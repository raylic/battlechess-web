// 神经网络的特征编码 —— 把 ViewState 变成定长张量。
//
// 这里是**唯一**把 ViewState 翻译成网络输入的层，所以也是"AI 不偷看真相"这条不变量的
// 落地点：入参只有 ViewState，函数签名上就拿不到 GameState。
//
// 布局（两个侧都共享同一份编码，靠 `you` 字段区分敌我）：
//   特征平面 6x6 x 17 通道
//     0        未翻开的棋子
//     1        空格
//     2..7     我已翻开的棋子，等级 0..5 各一个通道
//     8..13    敌方已翻开的棋子，等级 0..5 各一个通道
//     14       我的合法落点
//     15       我有合法着法的棋子所在格
//     16       上一步落子处
//   全局标量 6 个（喂给价值头）
//
// 动作空间固定 180 维，和合法着法无关（非法位置靠 mask 屏蔽）：
//   0..35     翻开 r*6+c
//   36..179   走子 36 + (r*6+c)*4 + 方向序号
// 方向序号与 core/rules.ts 的 DIRS 严格同序（有测试守着）。

import { BOARD_SIZE, LEVEL_COUNT_PER_SIDE, SIDES, other } from './pieces';
import { DIRS } from './rules';
import type { Action, Pos, Side, ViewState } from './types';

export const CELLS = BOARD_SIZE * BOARD_SIZE; // 36
export const CELL_ROWS = BOARD_SIZE;

/** 通道编号，供测试与网络结构文档引用 */
export const CH = {
  HIDDEN: 0,
  EMPTY: 1,
  MY_LEVEL0: 2,
  ENEMY_LEVEL0: 8,
  MOVE_TARGET: 14,
  MOVE_SOURCE: 15,
  LAST_STEP: 16,
} as const;

export const FEATURE_CHANNELS = 17;
export const FEATURE_COUNT = FEATURE_CHANNELS * CELLS; // 612
/** 全局标量：步数、无吃子步、双方存活、双方暗子总数、双方暗子各等级构成（6+6） */
export const GLOBAL_COUNT = 6 + 2 * 6; // 18

export const FLIP_ACTION_BASE = 0;
export const MOVE_ACTION_BASE = CELLS; // 36
export const ACTION_COUNT = CELLS + CELLS * DIRS.length; // 180

const idx = (row: number, col: number): number => row * BOARD_SIZE + col;

/** 走动方向编号；和 rules.ts 的 DIRS 同序 */
export function dirIndex(dr: number, dc: number): number {
  return DIRS.findIndex(([a, b]) => a === dr && b === dc);
}

export function actionIndex(action: Action): number | null {
  if (action.t === 'flip') return FLIP_ACTION_BASE + idx(action.at[0], action.at[1]);
  if (action.t === 'move') {
    const d = dirIndex(action.to[0] - action.from[0], action.to[1] - action.from[1]);
    if (d < 0) return null;
    return MOVE_ACTION_BASE + idx(action.from[0], action.from[1]) * DIRS.length + d;
  }
  return null; // 认输不在动作空间里
}

export function actionFromIndex(index: number): Action | null {
  if (!Number.isInteger(index) || index < 0 || index >= ACTION_COUNT) return null;
  if (index < MOVE_ACTION_BASE) {
    return { t: 'flip', at: [Math.floor(index / BOARD_SIZE), index % BOARD_SIZE] };
  }
  const rest = index - MOVE_ACTION_BASE;
  const cell = Math.floor(rest / DIRS.length);
  const d = rest % DIRS.length;
  const dr = DIRS[d]!;
  const from: Pos = [Math.floor(cell / BOARD_SIZE), cell % BOARD_SIZE];
  return { t: 'move', from, to: [from[0] + dr[0], from[1] + dr[1]] };
}

/**
 * 还没翻开的棋子里，各方各等级还剩几个。
 *
 * 这是**精确值**，不是估算：开局每方各等级数量固定且公开，减去「场上已翻开的」
 * （view 里能数出来）再减去「已经被吃掉的」（view.fallen，公开知识）即可。
 * 早先的版本漏了后者 —— 一旦有子被吃，池子就会越算越大。
 */
export function hiddenPool(view: ViewState): Record<Side, number[]> {
  const revealed: Record<Side, number[]> = {
    red: LEVEL_COUNT_PER_SIDE.map(() => 0),
    blue: LEVEL_COUNT_PER_SIDE.map(() => 0),
  };
  for (const cell of view.cells) {
    if (cell.revealed && cell.side && cell.level !== null) revealed[cell.side][cell.level] += 1;
  }
  const out = {} as Record<Side, number[]>;
  for (const side of SIDES) {
    out[side] = LEVEL_COUNT_PER_SIDE.map(
      (n, level) => n - revealed[side][level]! - (view.fallen?.[side]?.[level] ?? 0),
    );
  }
  return out;
}

/** 合法动作掩码（180 维，1 = 合法）。注意：只看 `view.legal`，不自己重算规则 */
export function actionMask(view: ViewState): Uint8Array {
  const mask = new Uint8Array(ACTION_COUNT);
  for (const at of view.legal.flips) mask[FLIP_ACTION_BASE + idx(at[0], at[1])] = 1;
  for (const m of view.legal.moves) {
    const d = dirIndex(m.to[0] - m.from[0], m.to[1] - m.from[1]);
    if (d >= 0) mask[MOVE_ACTION_BASE + idx(m.from[0], m.from[1]) * DIRS.length + d] = 1;
  }
  return mask;
}

export interface Encoded {
  /** 6x6x17，按 [channel][row][col] 的平面序存放 */
  features: Float32Array;
  globals: Float32Array;
  mask: Uint8Array;
}

/** ViewState → 网络输入。纯函数，不改入参 */
export function encode(view: ViewState): Encoded {
  const features = new Float32Array(FEATURE_COUNT);
  const me = view.you;
  const enemy = other(me);

  const at = (channel: number, cell: number): number => channel * CELLS + cell;

  for (const cell of view.cells) {
    const i = idx(cell.at[0], cell.at[1]);
    if (!cell.id) {
      features[at(CH.EMPTY, i)] = 1;
      continue;
    }
    if (!cell.revealed || cell.side === null || cell.level === null) {
      features[at(CH.HIDDEN, i)] = 1;
      continue;
    }
    const base = cell.side === me ? CH.MY_LEVEL0 : CH.ENEMY_LEVEL0;
    features[at(base + cell.level, i)] = 1;
  }

  for (const m of view.legal.moves) {
    features[at(CH.MOVE_SOURCE, idx(m.from[0], m.from[1]))] = 1;
    features[at(CH.MOVE_TARGET, idx(m.to[0], m.to[1]))] = 1;
  }
  if (view.lastStep) features[at(CH.LAST_STEP, idx(view.lastStep[0], view.lastStep[1]))] = 1;

  const pool = hiddenPool(view);
  let unknownTotal = 0;
  const poolTotal: Record<Side, number> = { red: 0, blue: 0 };
  for (const side of SIDES) {
    for (const n of pool[side]) {
      unknownTotal += n;
      poolTotal[side] += n;
    }
  }

  const globals = new Float32Array(GLOBAL_COUNT);
  globals[0] = view.step / 60;
  globals[1] = view.noEat / 30;
  globals[2] = view.counts[me] / 18;
  globals[3] = view.counts[enemy] / 18;
  globals[4] = poolTotal[me] / 18;
  globals[5] = poolTotal[enemy] / 18;
  // 6..11 = 我还没翻开的子各等级占比；12..17 = 对方的。
  // 这是"还有哪些强子埋着"的直接线索（比如双方国王都已被吃 → 这个通道全 0）
  for (const side of SIDES) {
    const base = side === me ? 6 : 12;
    for (let level = 0; level < 6; level++) {
      globals[base + level] = pool[side][level]! / LEVEL_COUNT_PER_SIDE[level]!;
    }
  }

  return { features, globals, mask: actionMask(view) };
}

/** 掩码 softmax（就地返回新数组；非法位置为 0）。数值上减了最大值 */
export function maskedSoftmax(logits: ArrayLike<number>, mask: Uint8Array, temperature = 1): Float32Array {
  const out = new Float32Array(ACTION_COUNT);
  let max = -Infinity;
  for (let i = 0; i < ACTION_COUNT; i++) if (mask[i] && logits[i]! > max) max = logits[i]!;
  if (max === -Infinity) return out;
  let sum = 0;
  for (let i = 0; i < ACTION_COUNT; i++) {
    if (!mask[i]) continue;
    const e = Math.exp((logits[i]! - max) / temperature);
    out[i] = e;
    sum += e;
  }
  if (sum > 0) for (let i = 0; i < ACTION_COUNT; i++) out[i] = out[i]! / sum;
  return out;
}

export { idx as cellIndex };
