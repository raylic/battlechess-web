// 搜索专用的**可变**核心：make / unmake + 零分配的着法生成。
//
// 为什么不直接用 reduce.ts 的 applyAction：
//   它是**不可变**的（每次 cloneState 复制 36 个棋子对象），而 rules.legalActions 每次调用
//   也会分配几十个数组。对"改状态只在一处"这条架构不变量来说，这是正确的选择 ——
//   但放进搜索的百万级节点里就是灾难：实测每节点约 80 次分配、15 微秒。
//
//   所以这里把同样的规则用"原地改 + 撤销"再实现一遍，**只给搜索用**。
//   代价是规则有两份实现，可能漂移 —— 用 fuzz 测试兜住：
//   searchCore.test.ts 会在成千上万个随机局面上，逐动作比对这里的 make/judgeFast
//   与 reduce.applyAction / judge 的结果（棋面指纹、回合、计数、胜负、原因全部逐字段相等）。
//
// 三条不变量：
//   1. make 之后必须 unmake 才能继续用同一局面；unmake 恢复的是 make 前的**每一**个字段。
//   2. judgeFast 与 judge 判定条件完全同序（wipe → lastStand → noEat → stalemate）。
//   3. 本模块不改任何 Piece 的身份（side/level），只改 revealed / 位置 / dire。

import { BOARD_SIZE, compareLevels, other } from './pieces';
import { MAX_NO_EAT } from './judge';
import { MOVE_ACTION_BASE, FLIP_ACTION_BASE } from './features';
import type { Dire, GameState, Piece, Pos, Reason, Side } from './types';

/**
 * 方向表**扁平化**：顺序与 rules.DIRS 一致（上、下、左、右）。
 * 用平铺数组而不是 [[r,c], ...] 是有原因的：`for (const [dr, dc] of DIRS)` 每次执行都会
 * 创建迭代器并解构元素，而在搜索里这些循环每节点都要跑几十次 —— 微基准显示它单独就
 * 占了 evaluate() 一半以上的时间。扁平表配整数下标则完全没有分配。
 */
export const DIRS_FLAT: readonly number[] = [-1, 0, 1, 0, 0, -1, 0, 1];

export const rowOf = (cell: number): number => (cell / BOARD_SIZE) | 0;
export const colOf = (cell: number): number => cell % BOARD_SIZE;
export const cellOf = (row: number, col: number): number => row * BOARD_SIZE + col;

function inside(row: number, col: number): boolean {
  return row >= 0 && col >= 0 && row < BOARD_SIZE && col < BOARD_SIZE;
}

/** 与 pieces.canEat 同口径；内联是为了省掉热点里的函数调用层 */
export function canEatLevel(attacker: number, target: number): boolean {
  if (attacker === 0 && target === 5) return false;
  if (attacker === 5 && target === 0) return true;
  return attacker <= target;
}

/** 一次 make 的撤销记录。预分配复用，所以整个搜索是零分配的 */
export interface Undo {
  index: number;
  prevTurn: Side;
  prevStep: number;
  prevNoEat: number;
  prevRed: number;
  prevBlue: number;
  prevLastStep: Pos | null;
  prevWinner: Side | 'draw' | null;
  prevReason: Reason | null;
  prevRevealed: boolean;
  prevDire: Dire;
  captured: Piece | null;
  fromCell: number;
  toCell: number;
}

export function createUndo(): Undo {
  return {
    index: -1,
    prevTurn: 'red',
    prevStep: 0,
    prevNoEat: 0,
    prevRed: 0,
    prevBlue: 0,
    prevLastStep: null,
    prevWinner: null,
    prevReason: null,
    prevRevealed: false,
    prevDire: 0,
    captured: null,
    fromCell: 0,
    toCell: 0,
  };
}

/**
 * 判定（与 judge.ts 同序，但零分配）。
 * 就地写 winner / reason；未结束则保持原样。
 */
const SCRATCH: number[] = [];

export function judgeFast(state: GameState, checkStalemate = true): void {
  if (state.winner) return;

  if (state.counts.red === 0) {
    state.winner = 'blue';
    state.reason = 'wipe';
    return;
  }
  if (state.counts.blue === 0) {
    state.winner = 'red';
    state.reason = 'wipe';
    return;
  }

  if (state.counts.red === 1 && state.counts.blue === 1) {
    let red: Piece | null = null;
    let blue: Piece | null = null;
    for (let row = 0; row < BOARD_SIZE; row++) {
      for (let col = 0; col < BOARD_SIZE; col++) {
        const p = state.grid[row]![col];
        if (!p) continue;
        if (p.side === 'red') red = p;
        else blue = p;
      }
    }
    if (!red || !blue) {
      state.winner = 'draw';
      state.reason = 'lastStand';
      return;
    }
    const cmp = compareLevels(red.level, blue.level);
    state.winner = cmp > 0 ? 'red' : cmp < 0 ? 'blue' : 'draw';
    state.reason = 'lastStand';
    return;
  }

  if (state.noEat >= MAX_NO_EAT) {
    state.winner = 'draw';
    state.reason = 'noEat';
    return;
  }

  // 无子可动 → 和（judge.ts 里那条 stalemate 兜底）。
  // 用模块级 scratch：judgeFast 在每个节点都会被调用，这里再分配数组等于把
  // make/unmake 省下来的分配又还回去。judgeFast 不会递归，所以共用一份是安全的。
  if (!checkStalemate) return;
  legalIndicesFast(state, SCRATCH);
  if (SCRATCH.length === 0) {
    state.winner = 'draw';
    state.reason = 'stalemate';
  }
}

/**
 * 执行一个动作（**原地**）。调用方必须保证动作合法（搜索内部生成的动作）。
 * 之后必须调用 unmake(undo) 才能继续使用这个局面。
 */
export function make(state: GameState, index: number, undo: Undo, checkStalemate = true): void {
  undo.index = index;
  undo.prevTurn = state.turn;
  undo.prevStep = state.step;
  undo.prevNoEat = state.noEat;
  undo.prevRed = state.counts.red;
  undo.prevBlue = state.counts.blue;
  undo.prevLastStep = state.lastStep;
  undo.prevWinner = state.winner;
  undo.prevReason = state.reason;
  undo.captured = null;

  if (index < MOVE_ACTION_BASE) {
    const cell = index - FLIP_ACTION_BASE;
    const row = rowOf(cell);
    const col = colOf(cell);
    const p = state.grid[row]![col]!;
    undo.prevRevealed = p.revealed;
    p.revealed = true;
    state.noEat = 0;
    state.lastStep = [row, col];
  } else {
    const rest = index - MOVE_ACTION_BASE;
    const cell = (rest / 4) | 0;
    const d = rest % 4;
    const fromRow = rowOf(cell);
    const fromCol = colOf(cell);
    const toRow = fromRow + DIRS_FLAT[d * 2]!;
    const toCol = fromCol + DIRS_FLAT[d * 2 + 1]!;
    const piece = state.grid[fromRow]![fromCol]!;
    const target = state.grid[toRow]![toCol];

    undo.fromCell = cell;
    undo.toCell = cellOf(toRow, toCol);
    undo.prevDire = piece.dire;

    if (target) {
      undo.captured = target;
      if (target.side === 'red') state.counts.red -= 1;
      else state.counts.blue -= 1;
      state.noEat = 0;
    } else {
      state.noEat += 1;
    }

    if (toCol !== fromCol) piece.dire = toCol < fromCol ? 0 : 1;
    state.grid[fromRow]![fromCol] = null;
    state.grid[toRow]![toCol] = piece;
    state.lastStep = [toRow, toCol];
  }

  state.step += 1;
  state.turn = other(state.turn);
  judgeFast(state, checkStalemate);
}

/** 撤销 make；必须严格配对、按栈序调用 */
export function unmake(state: GameState, undo: Undo): void {
  const index = undo.index;
  state.turn = undo.prevTurn;
  state.step = undo.prevStep;
  state.noEat = undo.prevNoEat;
  state.counts.red = undo.prevRed;
  state.counts.blue = undo.prevBlue;
  state.lastStep = undo.prevLastStep;
  state.winner = undo.prevWinner;
  state.reason = undo.prevReason;

  if (index < MOVE_ACTION_BASE) {
    const cell = index - FLIP_ACTION_BASE;
    state.grid[rowOf(cell)]![colOf(cell)]!.revealed = undo.prevRevealed;
    return;
  }

  const fromRow = rowOf(undo.fromCell);
  const fromCol = colOf(undo.fromCell);
  const toRow = rowOf(undo.toCell);
  const toCol = colOf(undo.toCell);
  const piece = state.grid[toRow]![toCol]!;
  piece.dire = undo.prevDire;
  state.grid[fromRow]![fromCol] = piece;
  state.grid[toRow]![toCol] = undo.captured ?? null;
}

/**
 * 全部合法着法（整数下标，写入调用方给的数组并**清空**它）。
 *
 * 与 rules.legalActions 同口径：暗子只能翻；已翻开的己方子向四邻走一格/吃子。
 */
export function legalIndicesFast(state: GameState, out: number[]): void {
  out.length = 0;
  const turn = state.turn;
  for (let row = 0; row < BOARD_SIZE; row++) {
    for (let col = 0; col < BOARD_SIZE; col++) {
      const p = state.grid[row]![col];
      if (!p) continue;
      const cell = cellOf(row, col);
      if (!p.revealed) {
        out.push(FLIP_ACTION_BASE + cell);
        continue;
      }
      if (p.side !== turn) continue;
      for (let d = 0; d < 4; d++) {
        const r = row + DIRS_FLAT[d * 2]!;
        const c = col + DIRS_FLAT[d * 2 + 1]!;
        if (!inside(r, c)) continue;
        const q = state.grid[r]![c];
        if (!q) out.push(MOVE_ACTION_BASE + cell * 4 + d);
        else if (q.revealed && q.side !== turn && canEatLevel(p.level, q.level)) {
          out.push(MOVE_ACTION_BASE + cell * 4 + d);
        }
      }
    }
  }
}

/** 只要吃子着法（quiescence 用），零分配 */
export function captureIndicesFast(state: GameState, out: number[]): void {
  out.length = 0;
  const turn = state.turn;
  for (let row = 0; row < BOARD_SIZE; row++) {
    for (let col = 0; col < BOARD_SIZE; col++) {
      const p = state.grid[row]![col];
      if (!p || !p.revealed || p.side !== turn) continue;
      const cell = cellOf(row, col);
      for (let d = 0; d < 4; d++) {
        const r = row + DIRS_FLAT[d * 2]!;
        const c = col + DIRS_FLAT[d * 2 + 1]!;
        if (!inside(r, c)) continue;
        const q = state.grid[r]![c];
        if (q && q.revealed && q.side !== turn && canEatLevel(p.level, q.level)) {
          out.push(MOVE_ACTION_BASE + cell * 4 + d);
        }
      }
    }
  }
}

/** 深拷贝一份局面（只在采样世界的根上用一次） */
export function cloneStateFast(state: GameState): GameState {
  return {
    seed: state.seed,
    grid: state.grid.map((row) => row.map((p) => (p ? { ...p } : null))),
    turn: state.turn,
    step: state.step,
    noEat: state.noEat,
    counts: { ...state.counts },
    lastStep: state.lastStep ? ([...state.lastStep] as Pos) : null,
    winner: state.winner,
    reason: state.reason,
    // 历史只用于根节点的循环判定，搜索内部不改它 —— 共用一份引用即可
    history: state.history,
  };
}
