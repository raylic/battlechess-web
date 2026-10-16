// 合法着法 —— 对应原版 base.py:Chess.next() 与 game.py:click_help()

import { BOARD_SIZE, canEat } from './pieces';
import type { GameState, LegalMoves, Pos } from './types';

/** 四个正交方向 [dRow, dCol]；原版 DIRECTION 只有上下左右（无对角线） */
export const DIRS: readonly (readonly [number, number])[] = [
  [-1, 0],
  [1, 0],
  [0, -1],
  [0, 1],
];

export function inside(row: number, col: number): boolean {
  return row >= 0 && col >= 0 && row < BOARD_SIZE && col < BOARD_SIZE;
}

export function samePos(a: Pos, b: Pos): boolean {
  return a[0] === b[0] && a[1] === b[1];
}

/** 某个棋子的可落点。未翻开的棋子给不出可落点 */
export function movesFrom(state: GameState, row: number, col: number): Pos[] {
  const piece = state.grid[row]?.[col];
  if (!piece || !piece.revealed) return [];

  const out: Pos[] = [];
  for (const [dr, dc] of DIRS) {
    const r = row + dr;
    const c = col + dc;
    if (!inside(r, c)) continue;
    const target = state.grid[r]![c];
    if (!target) {
      out.push([r, c]);
    } else if (target.revealed && target.side !== piece.side && canEat(piece.level, target.level)) {
      out.push([r, c]);
    }
  }
  return out;
}

/**
 * 当前回合方的全部合法操作。
 * 翻棋对颜色没有限制 —— 可以翻对方的子（原版 click_help 里没有颜色判断）。
 */
export function legalActions(state: GameState): LegalMoves {
  const result: LegalMoves = { flips: [], moves: [] };
  if (state.winner) return result;

  for (let row = 0; row < BOARD_SIZE; row++) {
    for (let col = 0; col < BOARD_SIZE; col++) {
      const piece = state.grid[row]![col];
      if (!piece) continue;
      if (!piece.revealed) {
        result.flips.push([row, col]);
        continue;
      }
      if (piece.side !== state.turn) continue;
      for (const to of movesFrom(state, row, col)) {
        result.moves.push({ from: [row, col], to });
      }
    }
  }
  return result;
}
