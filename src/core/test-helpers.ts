// 测试辅助：用紧凑记法手工摆一张棋盘
//   'r0'  = 已翻开的红方国王      '.' = 空格
//   'r0*' = 未翻开的红方国王      'b5' = 已翻开的蓝方刺客

import { BOARD_SIZE } from './pieces';
import type { GameState, Level, Piece, Pos, Side } from './types';

let counter = 0;

export function gridFrom(rows: string[]): (Piece | null)[][] {
  if (rows.length !== BOARD_SIZE) throw new Error(`需要 ${BOARD_SIZE} 行，收到 ${rows.length}`);
  return rows.map((line) => {
    const tokens = line.trim().split(/\s+/);
    if (tokens.length !== BOARD_SIZE) throw new Error(`每行需要 ${BOARD_SIZE} 格：「${line}」`);
    return tokens.map((tok): Piece | null => {
      if (tok === '.') return null;
      const m = /^([rb])([0-5])(\*?)$/.exec(tok);
      if (!m) throw new Error(`无法解析的格子：${tok}`);
      return {
        id: `t${counter++}`,
        side: m[1] === 'r' ? 'red' : 'blue',
        level: Number(m[2]) as Level,
        revealed: m[3] !== '*',
        dire: 0,
      };
    });
  });
}

export function stateWithGrid(
  grid: (Piece | null)[][],
  patch: Partial<GameState> = {},
): GameState {
  const counts: Record<Side, number> = { red: 0, blue: 0 };
  for (let row = 0; row < BOARD_SIZE; row++) {
    for (let col = 0; col < BOARD_SIZE; col++) {
      const p = grid[row]?.[col];
      if (p) counts[p.side] += 1;
    }
  }
  return {
    seed: 0,
    grid,
    turn: 'red',
    step: 0,
    noEat: 0,
    counts,
    lastStep: null,
    winner: null,
    reason: null,
    ...patch,
  };
}

export function stateFrom(rows: string[], patch: Partial<GameState> = {}): GameState {
  return stateWithGrid(gridFrom(rows), patch);
}

export const fill = (token: string): string[] =>
  Array.from({ length: BOARD_SIZE }, () => new Array(BOARD_SIZE).fill(token).join(' '));

export type { Pos };
