// 对抗场（arena）：把任意两个 AI 拉出来打 N 局，红蓝各半、固定种子，报胜率。
//
// 这是"到底变强了没有"的唯一裁判。训练出来的网络必须在这里赢过旧 AI 才算数 ——
// 训练损失下降、和老师一致率高，都**不能**替代这一步。
//
// 用法：
//   pnpm exec tsx scripts/arena.ts --a greedy --b net --weights ../train/weights/net.bin --games 200
//   pnpm exec tsx scripts/arena.ts --a greedy --b search --games 100
//
// 玩家名：random | greedy | search | net
// 可选参数：--worlds --budget --deepen-width --deepen-budget --seed --quiet
//   --a-opt key=value,key=value   只给 A 边加的搜索选项（B 边同理 --b-opt）
// 例（同一个搜索的两个版本对打，只有吃子延伸的预算口径不同）：
//   pnpm exec tsx scripts/arena.ts --a search --b search --games 60 \
//     --a-opt '' --b-opt splitQuiescenceBudget=true,minDepth=2

import { readFileSync } from 'node:fs';

import { chooseAction } from '../src/core/ai';
import { chooseActionNet, type NetAiOptions } from '../src/core/aiNet';
import { actionFromIndex } from '../src/core/features';
import { TinyNet, parseWeights } from '../src/core/nn';
import { applyAction, createState } from '../src/core/reduce';
import { mulberry32 } from '../src/core/rng';
import { legalActionIndices, pimcAction } from '../src/core/search';
import { viewFor } from '../src/core/visibility';
import type { Action, GameState, Side, ViewState } from '../src/core/types';

interface Args {
  a: string;
  b: string;
  games: number;
  weights: string | null;
  worlds: number;
  budget: number;
  netWidth: number;
  netAlpha: number;
  netSearchWorlds: number;
  seed: number;
  deepenWidth: number;
  deepenBudget: number;
  /** 每边额外的搜索选项（k=v 逗号分隔），用来让同一种 AI 的两个版本对打 */
  aOpt: Record<string, number | boolean>;
  bOpt: Record<string, number | boolean>;
}

/** 'splitQuiescenceBudget=true,minDepth=2' → { splitQuiescenceBudget: true, minDepth: 2 } */
function parseOpts(text: string): Record<string, number | boolean> {
  const out: Record<string, number | boolean> = {};
  for (const part of text.split(',')) {
    const piece = part.trim();
    if (!piece) continue;
    const eq = piece.indexOf('=');
    const key = eq < 0 ? piece : piece.slice(0, eq);
    const raw = eq < 0 ? 'true' : piece.slice(eq + 1);
    out[key] = raw === 'true' ? true : raw === 'false' ? false : Number(raw);
  }
  return out;
}

function parseArgs(argv: string[]): Args {
  const get = (name: string, fallback: string): string => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 && argv[i + 1] ? argv[i + 1]! : fallback;
  };
  return {
    a: get('a', 'greedy'),
    b: get('b', 'search'),
    games: Number(get('games', '100')),
    weights: argv.includes('--weights') ? get('weights', '') : null,
    worlds: Number(get('worlds', '8')),
    budget: Number(get('budget', '400')),
    netWidth: Number(get('net-width', '10')),
    netAlpha: Number(get('net-alpha', '0.5')),
    netSearchWorlds: Number(get('net-worlds', '0')),
    seed: Number(get('seed', '1000')),
    deepenWidth: Number(get('deepen-width', '5')),
    deepenBudget: Number(get('deepen-budget', '2400')),
    aOpt: parseOpts(get('a-opt', '')),
    bOpt: parseOpts(get('b-opt', '')),
  };
}

interface Player {
  name: string;
  /** 有状态：同一个实例可以跨局复用 */
  pick(view: ViewState, rand: () => number): Action | null;
}

function makePlayer(spec: string, args: Args, net: TinyNet | null, extra: Record<string, number | boolean> = {}): Player {
  if (spec === 'random') {
    return {
      name: 'random',
      pick: (view, rand) => {
        const legal = legalActionIndices(view);
        return legal.length ? actionFromIndex(legal[Math.floor(rand() * legal.length)]!) : null;
      },
    };
  }
  if (spec === 'greedy') {
    return { name: 'greedy', pick: (view, rand) => chooseAction(view, rand) };
  }
  if (spec === 'search') {
    const opts = {
      worlds: args.worlds,
      nodeBudget: args.budget,
      deepenWidth: args.deepenWidth,
      deepenBudget: args.deepenBudget,
      ...extra,
    };
    const tag = Object.keys(extra).length ? `+${Object.entries(extra).map(([k, v]) => `${k}=${v}`).join(',')}` : '';
    return {
      name: `search(K${args.worlds},b${args.budget},d${args.deepenWidth}x${args.deepenBudget}${tag})`,
      pick: (view, rand) => pimcAction(view, opts, rand),
    };
  }
  if (spec === 'net') {
    if (!net) throw new Error('net 玩家需要 --weights');
    const opts: NetAiOptions = {
      rootWidth: args.netWidth,
      alpha: args.netAlpha,
      worlds: args.netSearchWorlds,
    };
    return {
      name: `net(w${args.netWidth},α${args.netAlpha},s${args.netSearchWorlds})`,
      pick: (view, rand) => chooseActionNet(view, net, { ...opts, rand }, 0, rand),
    };
  }
  throw new Error(`未知玩家：${spec}`);
}

function play(seed: number, red: Player, blue: Player): GameState {
  let state = createState(seed);
  const rand = mulberry32((seed ^ 0x9e3779b9) >>> 0);
  let guard = 0;
  while (!state.winner && guard++ < 4000) {
    const view = viewFor(state, state.turn);
    const action = (state.turn === 'red' ? red : blue).pick(view, rand);
    if (!action) break;
    const res = applyAction(state, action);
    if ('rejected' in res) throw new Error(`非法着法（${res.rejected}）`);
    state = res.state;
  }
  return state;
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  let net: TinyNet | null = null;
  if (args.weights) {
    const buf = readFileSync(args.weights);
    net = new TinyNet(parseWeights(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer));
    console.log(`已加载权重：${args.weights}`);
  }

  const A = makePlayer(args.a, args, net, args.aOpt);
  const B = makePlayer(args.b, args, net, args.bOpt);
  console.log(`对局：${A.name} (A) vs ${B.name} (B)，各 ${args.games} 局，红蓝各半`);

  const tally: Record<Side | 'draw', number> = { red: 0, blue: 0, draw: 0 };
  const result = { win: 0, loss: 0, draw: 0 };
  const reasons: Record<string, number> = {};
  let steps = 0;
  const t0 = Date.now();

  for (let i = 0; i < args.games; i++) {
    const seed = args.seed + i * 13;
    // 偶数局 A 执红，奇数局 A 执蓝 —— 先手优势不能被算进胜负
    const aIsRed = i % 2 === 0;
    const state = play(seed, aIsRed ? A : B, aIsRed ? B : A);
    const aSide: Side = aIsRed ? 'red' : 'blue';
    tally[state.winner ?? 'draw'] += 1;
    reasons[state.reason ?? '?'] = (reasons[state.reason ?? '?'] ?? 0) + 1;
    steps += state.step;
    if (state.winner === 'draw') result.draw += 1;
    else if (state.winner === aSide) result.win += 1;
    else result.loss += 1;
    if ((i + 1) % 20 === 0) {
      console.log(`  ${i + 1}/${args.games}  ${A.name} 胜${result.win} 负${result.loss} 和${result.draw}`);
    }
  }

  const score = (result.win + result.draw / 2) / args.games;
  const secs = ((Date.now() - t0) / 1000).toFixed(0);
  console.log('');
  console.log(`  对局数   ${args.games}（A 执红 ${Math.ceil(args.games / 2)} / 执蓝 ${Math.floor(args.games / 2)}）`);
  console.log(`  ${A.name}: 胜 ${result.win} · 负 ${result.loss} · 和 ${result.draw}`);
  console.log(`  得分率   ${(score * 100).toFixed(1)}%   （净胜率 ${(((result.win - result.loss) / args.games) * 100).toFixed(1)}%）`);
  console.log(`  结束原因 ${JSON.stringify(reasons)}   平均 ${(steps / args.games).toFixed(0)} 步 · ${secs}s`);
}

main();
