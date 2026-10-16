// 点击策略与高亮 —— 这两条守卫在原生版里是裸 if，一行测试都没有
// （变异测试显示：把"不是自己回合就忽略点击"和"终局后忽略点击"改坏，测试依然全绿）

import { expect, test } from 'vitest';

import { createState } from '../core/reduce';
import { stateFrom } from '../core/test-helpers';
import type { Pos, ViewState } from '../core/types';
import { viewFor } from '../core/visibility';
import { cellFlags, isActionable, resolveClick } from './boardInteraction';

/** 局面：红方国王(0,0)已翻开；只有一个暗子在(5,2)可翻；其余是空格 */
const openBoard = () =>
  stateFrom([
    'r0 . . . . .',
    '. . . . . .',
    '. . . . . .',
    '. . . . . .',
    '. . . . . .',
    '. . b3* . . .',
  ]);

/** 红方国王被一个蓝方刺客贴着：刺客不能吃，所以不是可落点 */
const kingVsAssassin = () =>
  stateFrom([
    'r0 b5 . . . .',
    '. . . . . .',
    '. . . . . .',
    '. . . . . .',
    '. . . . . .',
    '. . . . . .',
  ]);

test('点暗子 → 翻棋，并且清掉选中', () => {
  const view = viewFor(openBoard(), 'red');
  expect(resolveClick(view, [0, 0], [5, 2])).toEqual({ action: { t: 'flip', at: [5, 2] }, selected: null });
});

test('点自己的明子 → 选中；再点一次 → 取消选中', () => {
  const view = viewFor(openBoard(), 'red');
  expect(resolveClick(view, null, [0, 0])).toEqual({ selected: [0, 0] });
  expect(resolveClick(view, [0, 0], [0, 0])).toEqual({ selected: null });
});

test('选中后点空格 → 走子', () => {
  const view = viewFor(openBoard(), 'red');
  expect(resolveClick(view, [0, 0], [0, 1])).toEqual({
    action: { t: 'move', from: [0, 0], to: [0, 1] },
    selected: null,
  });
  expect(resolveClick(view, [0, 0], [1, 0])).toEqual({
    action: { t: 'move', from: [0, 0], to: [1, 0] },
    selected: null,
  });
});

test('点吃不到的敌子 → 只是取消选中，不发操作', () => {
  const view = viewFor(kingVsAssassin(), 'red');
  expect(isActionable(view, [0, 1]), '吃不到的敌子不该显示为可操作').toBe(false);
  expect(resolveClick(view, [0, 0], [0, 1])).toEqual({ selected: null });
});

test('点空处 → 取消选中，不发操作', () => {
  const view = viewFor(openBoard(), 'red');
  expect(resolveClick(view, [0, 0], [3, 3])).toEqual({ selected: null });
  expect(resolveClick(view, null, [3, 3])).toEqual({ selected: null });
});

test('守卫：不是自己回合时，点哪儿都什么都不做（选中态也不变）', () => {
  const view = viewFor(openBoard(), 'blue');
  expect(view.you).not.toBe(view.turn);
  const spots: Pos[] = [
    [0, 0],
    [5, 2],
    [0, 1],
    [3, 3],
  ];
  for (const at of spots) {
    expect(resolveClick(view, null, at), `点 ${at}`).toEqual({ selected: null });
    expect(resolveClick(view, [0, 0], at), `带选中点 ${at}`).toEqual({ selected: [0, 0] });
    expect(isActionable(view, at)).toBe(false);
  }
});

test('守卫：终局之后点哪儿都什么都不做', () => {
  const state = openBoard();
  state.winner = 'red';
  state.reason = 'wipe';
  const view = viewFor(state, 'red');
  expect(view.over).toBe(true);
  for (const at of [
    [0, 0],
    [5, 2],
    [0, 1],
  ] as Pos[]) {
    expect(resolveClick(view, null, at)).toEqual({ selected: null });
    expect(resolveClick(view, [0, 0], at)).toEqual({ selected: [0, 0] });
    expect(isActionable(view, at)).toBe(false);
  }
});

test('高亮：上一步 / 选中 / 可落点 / 可操作', () => {
  const state = openBoard();
  state.lastStep = [0, 0];
  const view = viewFor(state, 'red');

  expect(cellFlags(view, null, [0, 0])).toEqual({
    isLast: true,
    isSelected: false,
    isTarget: false,
    isHoverable: true,
  });

  // 选中 (0,0) 之后，它的可落点 (0,1)、(1,0) 变蓝
  expect(cellFlags(view, [0, 0], [0, 1]).isTarget).toBe(true);
  expect(cellFlags(view, [0, 0], [1, 0]).isTarget).toBe(true);
  expect(cellFlags(view, [0, 0], [0, 0]).isSelected).toBe(true);
  expect(cellFlags(view, [0, 0], [3, 3]).isTarget).toBe(false);

  // 暗子总是可操作（能翻）
  expect(cellFlags(view, null, [5, 2]).isHoverable).toBe(true);
});

test('高亮跟随视角：换成蓝方视角就没有任何可操作格', () => {
  const view = viewFor(openBoard(), 'blue');
  for (let row = 0; row < 6; row++) {
    for (let col = 0; col < 6; col++) {
      expect(cellFlags(view, null, [row, col]).isHoverable).toBe(false);
    }
  }
});

test('热座视角（you === turn）也能正常操作', () => {
  const view = viewFor(openBoard(), 'red') as ViewState;
  const asHotseat: ViewState = { ...view, you: 'red' };
  expect(isActionable(asHotseat, [5, 2])).toBe(true);
  expect(resolveClick(asHotseat, null, [5, 2]).action).toEqual({ t: 'flip', at: [5, 2] });
});

test('createState 出来的满盘：36 个暗子都可翻，且没有可走的子', () => {
  const view = viewFor(createState(123), 'red');
  expect(view.legal.flips).toHaveLength(36);
  expect(view.legal.moves).toHaveLength(0);
  expect(isActionable(view, [0, 0])).toBe(true);
});

test('分视角：别人的子不可操作，自己的子可操作', () => {
  const state = openBoard();
  state.turn = 'blue';
  const blueView = viewFor(state, 'blue');

  expect(isActionable(blueView, [0, 0]), '红方的子不归蓝方管').toBe(false);
  expect(isActionable(blueView, [5, 2]), '暗子谁都能翻').toBe(true);
  expect(resolveClick(blueView, null, [0, 0])).toEqual({ selected: null });
  expect(resolveClick(blueView, null, [5, 2]).action).toEqual({ t: 'flip', at: [5, 2] });
});
