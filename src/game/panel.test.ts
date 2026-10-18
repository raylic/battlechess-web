import { expect, test } from 'vitest';

import { LEVEL_COUNT_PER_SIDE } from '../core/pieces';
import { createState } from '../core/reduce';
import type { Level, Side, ViewState } from '../core/types';
import { viewFor } from '../core/visibility';
import { PANEL_LAYOUT, panelRows, type SlotState } from './panel';

const ZERO = LEVEL_COUNT_PER_SIDE.map(() => 0);

function opening(side: Side = 'red'): ViewState {
  return viewFor(createState(7), side);
}

/** 把 n 个"还扣着的格子"在投影里改成某方某等级已翻开（模拟翻棋/吃子之后的公开信息） */
function markAlive(v: ViewState, side: Side, level: Level, n: number): ViewState {
  let left = n;
  const cells = v.cells.map((c) => {
    if (left > 0 && c.id && !c.revealed) {
      left -= 1;
      return { ...c, revealed: true, side, level };
    }
    return c;
  });
  return { ...v, cells };
}

function withFallen(v: ViewState, side: Side, level: Level, n: number): ViewState {
  const fallen = { red: [...ZERO], blue: [...ZERO] };
  fallen[side][level] = n;
  return { ...v, fallen };
}

const states = (rows: ReturnType<typeof panelRows>, level: Level): SlotState[] =>
  rows.flat().flat().filter((s) => s.level === level).map((s) => s.state);

test('开局：每方 18 个格位、全部没翻起', () => {
  const rows = panelRows(opening(), 'red');
  expect(rows.flat().flat()).toHaveLength(18);
  expect(rows.flat().flat().every((s) => s.state === 'down')).toBe(true);
});

test('布局：每行每级的格位数 = 兵种默认个数（合计 18）', () => {
  const counts = LEVEL_COUNT_PER_SIDE.map(() => 0);
  for (const row of PANEL_LAYOUT) for (const group of row) for (const lv of group) counts[lv] += 1;
  expect(counts).toEqual([...LEVEL_COUNT_PER_SIDE]);
  expect(counts.reduce((a, b) => a + b, 0)).toBe(18);
});

test('已翻开 = 存活；fallen = 被吃；剩下的才是没翻起', () => {
  let v = opening();
  // 红方：国王 1 颗翻开、刺客被吃 2 颗、禁卫军翻开 1 颗
  v = markAlive(v, 'red', 0, 1);
  v = markAlive(v, 'red', 4, 1);
  v = withFallen(v, 'red', 5, 2);

  const rows = panelRows(v, 'red');
  expect(states(rows, 0)).toEqual(['alive']);
  expect(states(rows, 4)).toEqual(['alive', 'down', 'down', 'down']);
  expect(states(rows, 5)).toEqual(['down', 'down', 'down', 'down', 'down', 'down', 'dead', 'dead']);
  // 蓝方不受影响
  expect(panelRows(v, 'blue').flat().flat().every((s) => s.state === 'down')).toBe(true);
});

test('格位顺序固定：存活 → 没翻起 → 被吃', () => {
  let v = opening();
  v = markAlive(v, 'blue', 5, 3);
  v = withFallen(v, 'blue', 5, 2);
  expect(states(panelRows(v, 'blue'), 5)).toEqual([
    'alive',
    'alive',
    'alive',
    'down',
    'down',
    'down',
    'dead',
    'dead',
  ]);
});

test('终局全亮：没有"没翻起"，剩几个就是几个存活', () => {
  let v = opening('blue');
  v = markAlive(v, 'blue', 3, 2); // 弓箭手 2 颗都已翻开
  expect(states(panelRows(v, 'blue'), 3)).toEqual(['alive', 'alive']);
});

test('数据不矛盾时，每一级的三种状态合计恒等于默认个数', () => {
  let v = opening();
  v = markAlive(v, 'red', 2, 1);
  v = withFallen(v, 'red', 2, 1);
  const rows = panelRows(v, 'red');
  LEVEL_COUNT_PER_SIDE.forEach((total, lv) => {
    expect(states(rows, lv as Level)).toHaveLength(total);
  });
});
