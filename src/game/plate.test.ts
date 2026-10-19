// @vitest-environment jsdom
// 名牌：几何、身份文案、头像裁切参数、星级排布。全是纯函数，钉住"两色一致"这类问题。
import { expect, test } from 'vitest';

import {
  COMPUTER,
  DISC,
  identityFor,
  PIECE_CROPS,
  PLATE,
  PORTRAIT_SCALE,
  portraitStyle,
  recordsRating,
  SHEET,
  starLayout,
  STAR,
} from './plate';

test('名牌画布与圆盘：和 head_*.webp 的实测尺寸一致', () => {
  expect(PLATE).toMatchObject({ width: 200, height: 220 });
  // 金环内洞是一枚正圆：bbox 70..130 / 15..75，圆心 (100,45)
  expect(DISC).toMatchObject({ size: 62, left: 69, top: 14, cx: 100, cy: 45 });
  expect(DISC.left + DISC.size / 2).toBe(DISC.cx);
  expect(DISC.top + DISC.size / 2).toBe(DISC.cy);
});

test('精灵图参数：6 列 × 2 行、每格 145', () => {
  expect(SHEET).toMatchObject({ cell: 145, cols: 6, rows: 2, width: 870, height: 290 });
  expect(SHEET.cols * SHEET.cell).toBe(SHEET.width);
  expect(SHEET.rows * SHEET.cell).toBe(SHEET.height);
});

test('裁切参数：两色都是 6 级，框都落在格子里，脸在框内', () => {
  for (const side of ['red', 'blue'] as const) {
    expect(PIECE_CROPS[side]).toHaveLength(6);
    for (const c of PIECE_CROPS[side]) {
      expect(c.w).toBeGreaterThan(40);
      expect(c.h).toBeGreaterThan(40);
      expect(c.fx).toBeGreaterThan(0);
      expect(c.fx).toBeLessThan(c.w);
      expect(c.fy).toBeGreaterThan(0);
      expect(c.fy).toBeLessThan(c.h);
      // 框不能超出格子
      expect(c.bx + c.w).toBeLessThanOrEqual(SHEET.cell);
      expect(c.by + c.h).toBeLessThanOrEqual(SHEET.cell);
    }
  }
});

test('两色的国王/将军裁切是"同一种构图"：脸到中线的偏差不超过 10px', () => {
  // 这一条是为蓝将军/蓝国王那个坑写的：判据换成近黑重心后，两色的脸必须落在相近位置
  for (const level of [4, 5]) {
    const r = PIECE_CROPS.red[level]!;
    const b = PIECE_CROPS.blue[level]!;
    expect(Math.abs(r.fx - b.fx)).toBeLessThan(10);
    expect(Math.abs(r.fy - b.fy)).toBeLessThan(10);
  }
});

test('头像样式：脸被挪到圆盘圆心，且整张精灵图按 0.864 放大', () => {
  const s = PORTRAIT_SCALE;
  const style = portraitStyle('red', 5); // 国王 → 精灵图第 0 列
  expect(style.backgroundImage).toContain('chess.webp');
  expect(style.backgroundSize).toBe(`${(SHEET.width * s).toFixed(2)}px ${(SHEET.height * s).toFixed(2)}px`);

  const crop = PIECE_CROPS.red[5]!;
  const half = DISC.size / 2;
  // 列序是反的：等级 5 = 第 0 列；红方 = 第 0 行（偏移为 0，所以不加列/行号）
  const ax = crop.bx + crop.fx;
  const ay = crop.by + crop.fy;
  expect(style.backgroundPosition).toBe(`${(half - ax * s).toFixed(2)}px ${(half - ay * s).toFixed(2)}px`);
});

test('头像样式：蓝方取第 1 行，刺客取第 5 列', () => {
  const s = PORTRAIT_SCALE;
  const crop = PIECE_CROPS.blue[0]!;
  const ax = 5 * SHEET.cell + crop.bx + crop.fx;
  const ay = 1 * SHEET.cell + crop.by + crop.fy;
  expect(portraitStyle('blue', 0).backgroundPosition).toBe(
    `${(DISC.size / 2 - ax * s).toFixed(2)}px ${(DISC.size / 2 - ay * s).toFixed(2)}px`,
  );
});

test('头像样式：等级越界不会崩，夹到合法范围', () => {
  expect(portraitStyle('red', -3).backgroundPosition).toBe(portraitStyle('red', 0).backgroundPosition);
  expect(portraitStyle('red', 99).backgroundPosition).toBe(portraitStyle('red', 5).backgroundPosition);
});

test('星级：1 颗在正上方，6 颗铺满上弧，星少则排紧', () => {
  const one = starLayout(1);
  expect(one).toHaveLength(1);
  expect(Math.abs(one[0]!.left + STAR.size / 2 - STAR.cx)).toBeLessThanOrEqual(1);
  expect(one[0]!.top).toBe(Math.round(STAR.cy - STAR.radius - STAR.size / 2));

  const six = starLayout(6);
  expect(six).toHaveLength(6);
  const xs = six.map((s) => s.left);
  expect(xs[0]).toBeLessThan(xs[5]!); // 从左到右
  // 两端关于圆心对称
  expect(Math.abs(xs[0]! + xs[5]! + STAR.size - 2 * STAR.cx)).toBeLessThanOrEqual(2);
  // 越靠中间越高（上弧）
  expect(six[2]!.top).toBeLessThan(six[0]!.top!);

  // 数量少 → 跨度小（这就是"星少排紧"）
  const span = (n: number) => {
    const p = starLayout(n);
    return p[p.length - 1]!.left - p[0]!.left;
  };
  expect(span(2)).toBeLessThan(span(3));
  expect(span(3)).toBeLessThan(span(6));
  expect(starLayout(0)).toHaveLength(0);
  expect(starLayout(9)).toHaveLength(6);
});

test('身份文案：说"你是谁"而不是颜色', () => {
  expect(identityFor('ai', 'red', 'red')).toBe('玩家');
  expect(identityFor('ai', 'red', 'blue')).toBe('电脑');
  expect(identityFor('online', 'blue', 'blue')).toBe('玩家');
  expect(identityFor('online', 'blue', 'red')).toBe('对手');
  expect(identityFor('hotseat', null, 'red')).toBe('红方');
  expect(identityFor('dual', null, 'blue')).toBe('蓝方');
});

test('记不记分：人机、联机记；热座、双窗口不记', () => {
  expect(recordsRating('ai')).toBe(true);
  expect(recordsRating('online')).toBe(true);
  expect(recordsRating('hotseat')).toBe(false);
  expect(recordsRating('dual')).toBe(false);
});

test('电脑那侧：称号"普通"、头像用国王', () => {
  expect(COMPUTER.title).toBe('普通');
  expect(COMPUTER.gradeIndex).toBe(5);
});
