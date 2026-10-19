import { expect, test } from 'vitest';

import { otherSide, sideForSeed } from './side';

test('颜色由种子派生：偶数红、奇数蓝，且同一种子永远同一颜色', () => {
  expect(sideForSeed(0)).toBe('red');
  expect(sideForSeed(2)).toBe('red');
  expect(sideForSeed(3)).toBe('blue');
  expect(sideForSeed(999)).toBe('blue');
  expect(sideForSeed(4821)).toBe('blue');
  expect(sideForSeed(-42)).toBe('red');
  // 幂等：复盘/刷新都靠这条
  expect(sideForSeed(12345)).toBe(sideForSeed(12345));
});

test('相邻种子会换边（「再来一局」种子 +1 就换色）', () => {
  for (let s = 1; s < 10; s += 1) {
    expect(sideForSeed(s)).not.toBe(sideForSeed(s + 1));
  }
});

test('otherSide 来回一次还是自己', () => {
  expect(otherSide('red')).toBe('blue');
  expect(otherSide('blue')).toBe('red');
  expect(otherSide(otherSide('red'))).toBe('red');
});
