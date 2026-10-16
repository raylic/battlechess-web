// 棋盘几何：和 style.css 里的几何参数、以及原版设计稿坐标对齐

import { expect, test } from 'vitest';

import { CELL, PIECE_RISE, PIECE_SCALE, PIECE_SIZE, piecePixel } from './geometry';

const num = (s: string) => Number.parseFloat(s);

test('棋子比格子大，尺寸关系符合原版观感', () => {
  expect(CELL).toBe(88);
  expect(PIECE_SCALE).toBeGreaterThan(1);
  expect(PIECE_SCALE).toBeLessThan(2);
  expect(PIECE_SIZE).toBeCloseTo(124.96, 2);
});

test('偏移换算：格子 (0,0) 向左上外溢半个差值，再按 PIECE_RISE 微调', () => {
  const off = (PIECE_SIZE - CELL) / 2;
  expect(piecePixel(0, 0)).toEqual({ px: `${-off}px`, py: `${-off - PIECE_RISE}px` });
});

test('偏移是线性的：第 (row, col) 格 = 行列各乘一个格宽', () => {
  const origin = piecePixel(0, 0);
  const far = piecePixel(3, 5);
  expect(num(far.px) - num(origin.px)).toBeCloseTo(5 * CELL, 6);
  expect(num(far.py) - num(origin.py)).toBeCloseTo(3 * CELL, 6);
});

test('未投影时棋子层的范围仍在舞台内（投影只会把它压得更小）', () => {
  // #stage 在 #app 内 left:236 / top:76；投影（rotateX + perspective）只会让四周内收
  const corner = piecePixel(5, 5);
  const right = 236 + num(corner.px) + PIECE_SIZE;
  const bottom = 76 + num(corner.py) + PIECE_SIZE;
  expect(right).toBeLessThan(1000);
  expect(bottom).toBeLessThan(650);
});
