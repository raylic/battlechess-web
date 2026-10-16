// 棋盘生成 —— 对应原版 utils.py:random_chess()，用种子随机保证可复现

import { BOARD_SIZE, LEVEL_COUNT_PER_SIDE, SIDES } from './pieces';
import { mulberry32, shuffle } from './rng';
import type { Level, Piece, Side } from './types';

/**
 * 生成 6x6 棋盘：36 格全部摆满，全部背面朝上。
 * 硬约束：双方每个等级的棋子数严格一致（有测试守着）。
 * id 在洗牌之后按格位顺序生成，因此 id 顺序不携带任何身份信息 —— 双盲下不会通过 id 泄漏。
 */
export function createGrid(seed: number): (Piece | null)[][] {
  const rand = mulberry32(seed);

  const deck: { side: Side; level: Level }[] = [];
  for (const side of SIDES) {
    for (let level = 0; level < LEVEL_COUNT_PER_SIDE.length; level++) {
      for (let i = 0; i < LEVEL_COUNT_PER_SIDE[level]!; i++) {
        deck.push({ side, level: level as Level });
      }
    }
  }

  const mixed = shuffle(deck, rand);

  const grid: (Piece | null)[][] = [];
  for (let row = 0; row < BOARD_SIZE; row++) grid.push(new Array<Piece | null>(BOARD_SIZE).fill(null));

  mixed.forEach((p, i) => {
    const row = Math.floor(i / BOARD_SIZE);
    const col = i % BOARD_SIZE;
    grid[row]![col] = { id: `p${i}`, side: p.side, level: p.level, revealed: false, dire: 0 };
  });

  return grid;
}
