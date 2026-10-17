// 自对弈产训练数据：老师（PIMC 搜索）走子，学生（网络）学它的策略 + 对局结果。
//
// 用法（在 battlechess-web/ 下）：
//   pnpm exec tsx scripts/gen-data.ts --games 200 --shard 0/6 --out ../train/data/shard-0.bin
//
// 每一条记录 = 一次「轮到某方走」的决策点：
//   特征/全局标量   → 网络输入（和上网时**完全一致**的编码路径，见 core/features.ts）
//   策略目标        → 老师在同一信息集上的搜索分布（softmax(跨世界平均分 / T)）
//   结果 z          → 这盘棋最终对"该走的一方"是胜/和/负（+1/0/-1）
//
// 为什么老师只吃 ViewState：AI 的信息边界是硬不变量（PLAN §9），
// 训练数据也必须走同一条投影路径，否则训出来的网络会依赖它在上网时拿不到的信息。
//
// 对手池（--opponent）：self = 双方都听老师的；greedy / random = 对手按弱策略走。
// 关键点是**标签照记**：即使某一步是对手在走，我们也记下"老师会怎么走"，
// 于是同一盘棋既产生了老师的正解标签，又探索到了老师自己不会去的位置（更多样、更少自恋）。

import { closeSync, openSync, writeSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { mkdirSync } from 'node:fs';

import { chooseAction } from '../src/core/ai';
import { actionMask, encode, maskedSoftmax } from '../src/core/features';
import { applyAction, createState } from '../src/core/reduce';
import { mulberry32 } from '../src/core/rng';
import { pimc } from '../src/core/search';
import { viewFor } from '../src/core/visibility';
import { ACTION_COUNT, FEATURE_COUNT, GLOBAL_COUNT } from '../src/core/features';
import type { Action, GameState, Side, ViewState } from '../src/core/types';
import { actionFromIndex } from '../src/core/features';

const MAGIC = 'BCDS';
const VERSION = 1;
const HEADER_BYTES = 4 + 1 + 4 + 4 + 4 + 4; // magic + ver + count + feature + global + action
const RECORD_BYTES = FEATURE_COUNT * 4 + GLOBAL_COUNT * 4 + ACTION_COUNT * 4 + 1 + 1 + 2;

interface Args {
  games: number;
  shard: number;
  shards: number;
  seed: number;
  out: string;
  opponent: 'self' | 'greedy' | 'random' | 'mix';
  worlds: number;
  budget: number;
  /** 走子时的采样温度（=0 表示总走老师的最优解）；开局几步会额外升温，保证数据多样 */
  temp: number;
  rootWidth: number;
}

function parseArgs(argv: string[]): Args {
  const get = (name: string, fallback: string): string => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 && argv[i + 1] ? argv[i + 1]! : fallback;
  };
  const [shard, shards] = get('shard', '0/1').split('/').map(Number);
  return {
    games: Number(get('games', '100')),
    shard: shard ?? 0,
    shards: shards ?? 1,
    seed: Number(get('seed', '900000')),
    out: get('out', '../train/data/shard.bin'),
    opponent: get('opponent', 'mix') as Args['opponent'],
    worlds: Number(get('worlds', '8')),
    budget: Number(get('budget', '500')),
    temp: Number(get('temp', '0')),
    rootWidth: Number(get('rootWidth', '0')),
  };
}

/** 一步决策点的记录（结果 z 要等整盘棋下完才知道，所以先攒在内存里） */
interface Sample {
  features: Float32Array;
  globals: Float32Array;
  policy: Float32Array;
  side: Side;
  step: number;
}

function pickByPolicy(policy: Float32Array, rand: () => number): number {
  let r = rand();
  for (let i = 0; i < ACTION_COUNT; i++) {
    r -= policy[i]!;
    if (r <= 0 && policy[i]! > 0) return i;
  }
  for (let i = 0; i < ACTION_COUNT; i++) if (policy[i]! > 0) return i;
  return -1;
}

function opponentAction(view: ViewState, kind: 'greedy' | 'random', rand: () => number): Action | null {
  if (kind === 'greedy') return chooseAction(view, rand);
  const mask = actionMask(view);
  const legal: number[] = [];
  for (let i = 0; i < ACTION_COUNT; i++) if (mask[i]) legal.push(i);
  if (!legal.length) return null;
  return actionFromIndex(legal[Math.floor(rand() * legal.length)]!);
}

interface GameResult {
  samples: Sample[];
  winner: Side | 'draw';
  reason: string;
  steps: number;
}

function playGame(seed: number, args: Args, gameIndex: number): GameResult {
  const rand = mulberry32((seed ^ Math.imul(gameIndex + 1, 2654435761)) >>> 0);
  let state: GameState = createState(seed);

  // 对手池：mix 模式下每盘随机抽一种
  const kinds = ['self', 'greedy', 'random'] as const;
  const kind = args.opponent === 'mix' ? kinds[gameIndex % kinds.length]! : args.opponent;
  // 对手固定执一方（交替），保证两种视角的数据都有
  const opponentSide: Side | null = kind === 'self' ? null : gameIndex % 2 === 0 ? 'blue' : 'red';

  const samples: Sample[] = [];
  let guard = 0;

  while (!state.winner && guard++ < 4000) {
    const view = viewFor(state, state.turn);
    const enc = encode(view);
    const res = pimc(
      view,
      { worlds: args.worlds, nodeBudget: args.budget, rootWidth: args.rootWidth > 0 ? args.rootWidth : Infinity },
      rand,
    );
    if (res.best < 0) break;

    // 标签：老师在这个信息集上的分布。温度低 → 接近 one-hot，给网络一个干脆的目标
    const label =
      args.temp > 0
        ? maskedSoftmax(res.scores, enc.mask, args.temp)
        : res.policy;
    samples.push({
      features: enc.features,
      globals: enc.globals,
      policy: Float32Array.from(label),
      side: view.turn,
      step: view.step,
    });

    // 实际走子：老师方按标签采样（开局升温保证多样性），对手方走自己的
    let action: Action | null;
    if (opponentSide !== null && view.turn === opponentSide) {
      action = opponentAction(view, kind === 'random' ? 'random' : 'greedy', rand);
    } else {
      const t = view.step < 8 ? Math.max(args.temp, 200) : args.temp;
      const dist = t > 0 ? maskedSoftmax(res.scores, enc.mask, t) : res.policy;
      const idx = dist === res.policy && args.temp === 0 && t === 0 ? res.best : pickByPolicy(dist, rand);
      action = actionFromIndex(idx);
    }
    if (!action) break;

    const applied = applyAction(state, action);
    if ('rejected' in applied) throw new Error(`产数据时出现非法着法：${applied.rejected}`);
    state = applied.state;
  }

  return { samples, winner: state.winner ?? 'draw', reason: state.reason ?? 'guard', steps: state.step };
}

function writeSample(buffer: Buffer, offset: number, s: Sample, result: 0 | 1 | 2): void {
  let o = offset;
  for (let i = 0; i < FEATURE_COUNT; i++, o += 4) buffer.writeFloatLE(s.features[i]!, o);
  for (let i = 0; i < GLOBAL_COUNT; i++, o += 4) buffer.writeFloatLE(s.globals[i]!, o);
  for (let i = 0; i < ACTION_COUNT; i++, o += 4) buffer.writeFloatLE(s.policy[i]!, o);
  buffer.writeUInt8(s.side === 'red' ? 0 : 1, o++);
  buffer.writeUInt8(result, o++);
  buffer.writeUInt16LE(Math.min(s.step, 65535), o);
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  mkdirSync(dirname(args.out), { recursive: true });
  const header = Buffer.alloc(HEADER_BYTES);
  header.write(MAGIC, 0, 'latin1');
  header.writeUInt8(VERSION, 4);
  header.writeUInt32LE(0, 5);
  header.writeUInt32LE(FEATURE_COUNT, 9);
  header.writeUInt32LE(GLOBAL_COUNT, 13);
  header.writeUInt32LE(ACTION_COUNT, 17);
  writeFileSync(args.out, header);

  const fd = openSync(args.out, 'a');
  const buffer = Buffer.alloc(RECORD_BYTES);
  let records = 0;
  let decisive = 0;
  let draws = 0;
  const t0 = Date.now();

  try {
    for (let g = 0; g < args.games; g++) {
      const seed = args.seed + args.shard * 1_000_000 + g * 13;
      const game = playGame(seed, args, g);
      if (game.winner !== 'draw') decisive += 1;
      else draws += 1;

      for (const s of game.samples) {
        const result: 0 | 1 | 2 = game.winner === 'draw' ? 1 : game.winner === s.side ? 2 : 0;
        writeSample(buffer, 0, s, result);
        writeSync(fd, buffer, 0, RECORD_BYTES);
        records += 1;
      }

      if ((g + 1) % 10 === 0 || g === args.games - 1) {
        const secs = ((Date.now() - t0) / 1000).toFixed(0);
        console.log(
          `  [shard ${args.shard}] ${g + 1}/${args.games} 局 · 记录 ${records} · ` +
            `分胜负 ${decisive} / 和 ${draws} · ${secs}s`,
        );
      }
    }
  } finally {
    closeSync(fd);
  }

  // 回填记录数
  const fix = Buffer.alloc(4);
  fix.writeUInt32LE(records, 0);
  const fd2 = openSync(args.out, 'r+');
  writeSync(fd2, fix, 0, 4, 5);
  closeSync(fd2);
  console.log(`完成：${args.out}（${records} 条记录，${((records * RECORD_BYTES) / 1e6).toFixed(1)} MB）`);
}

main();
