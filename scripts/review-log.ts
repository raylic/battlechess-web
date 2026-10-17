// 复盘导出的对局记录，把 AI 的坏棋挑出来。
//
// 用法：
//   pnpm exec tsx scripts/review-log.ts ~/Downloads/battlechess-games-<日期>.json [--all]
//
// 记录里只存了「种子 + 动作序列」——整盘棋是确定性的，所以这里能重放出**每一步的真相**，
// 于是可以逐手检查"AI 当时这一手之后亏不亏"。
//
// 判据（都只用棋盘上的公开信息就能验证）：
//   ★  人自己标记过的局（优先看）
//   ☠  认输（顺便看它当时到底落后多少，判断是不是乱认）
//   💀  送子：走完之后这颗子被已翻开的敌子吃着、而且对方吃了净赚
//   🔁  循环：这一步把盘面带回了本局出现过的公开局面
//   ⚠️  记录与规则不符（存档格式或规则改动导致的错位）
//
// 默认只看 **AI 那一方**的棋，而且只有净亏 >= 120（一个弓箭手）才当坏棋 ——
// 否则"亏 40 的禁卫军"会刷满屏幕。`--all` 会把双方每一步都列出来（看 AI 到底在想什么时用）。

import { readFileSync } from 'node:fs';

import { canEat, LEVEL_NAMES, LEVEL_VALUE, other } from '../src/core/pieces';
import { applyAction, createState, publicKey, type ApplyResult } from '../src/core/reduce';
import { DIRS } from '../src/core/rules';
import { viewFor } from '../src/core/visibility';
import { decodeActions } from '../src/game/gameLog';
import type { Action, GameState, Pos, Side } from '../src/core/types';

interface Recorded {
  ts: number;
  seed: number;
  mode: string;
  ai: string;
  you: Side | null;
  winner: Side | 'draw';
  reason: string;
  steps: number;
  actions: string[];
  flagged?: boolean;
}

const file = process.argv[2];
const showAll = process.argv.includes('--all');
/** 净亏到这个数才值得报（默认一个弓箭手；小于它的交换在暗棋里常是有意的） */
const LOSS_FLOOR = 120;
if (!file) {
  console.error('用法：pnpm exec tsx scripts/review-log.ts <导出的 json> [--all]');
  process.exit(1);
}

const parsed = JSON.parse(readFileSync(file, 'utf8')) as { games?: Recorded[] };
const games = parsed.games ?? [];
if (!games.length) {
  console.error('这个文件里没有对局');
  process.exit(1);
}

const sideName = (side: Side | null): string => (side === 'red' ? '红' : side === 'blue' ? '蓝' : '?');

function neighbours(pos: Pos): Pos[] {
  return DIRS.map(([dr, dc]) => [pos[0] + dr, pos[1] + dc] as Pos).filter(
    ([r, c]) => r >= 0 && c >= 0 && r < 6 && c < 6,
  );
}

/** 走完之后，这颗子被吃掉会净亏多少（0 = 安全，或者吃了也换得回来） */
function seeLoss(s: GameState, pos: Pos, mySide: Side): { loss: number; by: string[] } {
  const piece = s.grid[pos[0]]![pos[1]];
  if (!piece) return { loss: 0, by: [] };
  const foe = other(mySide);
  let loss = 0;
  const by: string[] = [];
  for (const n of neighbours(pos)) {
    const q = s.grid[n[0]]![n[1]];
    if (!q || !q.revealed || q.side !== foe || !canEat(q.level, piece.level)) continue;
    const recap = neighbours(pos).find((m) => {
      const d = s.grid[m[0]]![m[1]];
      return d && d.revealed && d.side === mySide && canEat(d.level, q.level);
    });
    const value = recap ? LEVEL_VALUE[piece.level]! - LEVEL_VALUE[q.level]! : LEVEL_VALUE[piece.level]!;
    if (value > loss) loss = value;
    by.push(`${LEVEL_NAMES[q.level]}(${n[0]},${n[1]})`);
  }
  return { loss, by };
}

/** 棋盘上已翻开棋子的子力差（只看公开信息） */
function shownMaterial(s: GameState, side: Side): number {
  let sum = 0;
  for (let r = 0; r < 6; r++) {
    for (let c = 0; c < 6; c++) {
      const p = s.grid[r]![c];
      if (p && p.side === side && p.revealed) sum += LEVEL_VALUE[p.level]!;
    }
  }
  return sum;
}

function describe(s: GameState, action: Action): string {
  if (action.t === 'resign') return '认输';
  if (action.t === 'flip') return `翻 (${action.at[0]},${action.at[1]})`;
  const p = s.grid[action.from[0]]?.[action.from[1]];
  const name = p ? LEVEL_NAMES[p.level] : '子';
  return `${name} (${action.from[0]},${action.from[1]})→(${action.to[0]},${action.to[1]})`;
}

function resultText(winner: Side | 'draw', you: Side | null): string {
  if (winner === 'draw') return '和棋';
  if (!you) return `${sideName(winner)}方胜`;
  return winner === you ? '我赢了' : '电脑赢了';
}

let marked = 0;
let withFindings = 0;

for (const game of games) {
  const actions = decodeActions(game.actions);
  if (!actions.length && game.actions.length) {
    console.log(`种子 ${game.seed}：动作序列解不开（存档格式不对？），跳过\n`);
    continue;
  }

  const findings: string[] = [];
  let state = createState(game.seed);
  const seen = new Set<string>([publicKey(state)]);

  for (const action of actions) {
    if (state.winner) break;
    const mover = state.turn;
    const label = describe(state, action);
    // 默认只盯 AI 那一方
    const isAi = game.you === null || mover !== game.you;
    const report = showAll || isAi;

    if (!report) {
      // 不报也要把棋走完，否则重放会错位
      const skip = applyAction(state, action);
      if ('rejected' in skip) break;
      state = skip.state;
      continue;
    }

    if (action.t === 'resign') {
      const balance = shownMaterial(state, mover) - shownMaterial(state, other(mover));
      findings.push(
        `☠ 第${state.step}步 认输（${sideName(mover)}方=AI）· 已翻开子力差 ${balance > 0 ? '+' : ''}${balance} · ` +
          `剩子 红${state.counts.red}:蓝${state.counts.blue}`,
      );
    } else if (action.t === 'move') {
      const after = applyAction(state, action, true);
      if (!('rejected' in after)) {
        if (seen.has(publicKey(after.state))) findings.push(`🔁 第${state.step}步 走回旧局面：${label}`);
        const { loss, by } = seeLoss(after.state, action.to, mover);
        if (loss >= LOSS_FLOOR) findings.push(`💀 第${state.step}步 送子：${label} → 被 ${by.join('/')} 吃，净亏 ${loss}`);
      }
    }

    const res: ApplyResult = applyAction(state, action);
    if ('rejected' in res) {
      findings.push(`⚠️ 第${state.step}步 记录与规则不符（${res.rejected}）：${label}`);
      break;
    }
    seen.add(publicKey(res.state));
    state = res.state;
    if (showAll) findings.push(`· 第${state.step}步 ${label}`);
  }

  const head =
    `${game.flagged ? '★ ' : '  '}种子 ${game.seed} · ${game.mode}/${game.ai} · 我执${sideName(game.you)} · ` +
    `${resultText(game.winner, game.you)}（${game.reason}，${game.steps} 步）`;
  const interesting = findings.some((f) => !f.startsWith('·'));

  if (game.flagged || interesting || showAll) {
    console.log(head);
    for (const f of findings) console.log(`    ${f}`);
    console.log('');
  }
  if (game.flagged) marked += 1;
  if (interesting) withFindings += 1;
}

console.log(`共 ${games.length} 盘：标记过 ${marked} 盘，跑出可疑手 ${withFindings} 盘。加 --all 可打印每一步。`);
