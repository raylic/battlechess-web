// HUD 文案与结算面板映射 —— 原生版这部分逻辑埋在 hud.js 里拼 innerHTML，零测试。
// 这里全是纯函数，"赢了显示失败""按钮该亮不亮"这类问题现在能被钉死。

import { expect, test } from 'vitest';

import { MIN_GIVEUP } from '../core/judge';
import { createState } from '../core/reduce';
import type { Side, ViewState } from '../core/types';
import { viewFor } from '../core/visibility';
import {
  bannerText,
  countText,
  footText,
  isMyTurn,
  playerNames,
  resignDisabled,
  resultColumn,
  resultPanelStyle,
  resultTitle,
  resultWhy,
  sideName,
} from './hudText';

const view = (patch: Partial<ViewState> = {}, side: Side = 'red'): ViewState => ({
  ...viewFor(createState(1), side),
  ...patch,
});

test('sideName / playerNames', () => {
  expect(sideName('red')).toBe('红方');
  expect(sideName('blue')).toBe('蓝方');
  expect(playerNames('ai')).toEqual({ red: '你', blue: '电脑' });
  expect(playerNames('hotseat')).toEqual({ red: '红方', blue: '蓝方' });
  expect(playerNames('dual')).toEqual({ red: '红方', blue: '蓝方' });
});

test('isMyTurn：热座恒为真，分视角看回合，终局恒为假', () => {
  const red = view(); // 红方先手
  expect(isMyTurn(red, null), '热座').toBe(true);
  expect(isMyTurn(red, 'red')).toBe(true);
  expect(isMyTurn(red, 'blue')).toBe(false);
  expect(isMyTurn(view({ turn: 'blue' }), 'blue')).toBe(true);
  expect(isMyTurn(view({ over: true, winner: 'red' }), null), '终局').toBe(false);
});

test('认输按钮：步数不够 / 不是自己回合 / 已结束 → 都禁用', () => {
  expect(resignDisabled(view({ canResign: false }), 'red')).toBe(true);
  expect(resignDisabled(view({ canResign: true }), 'red')).toBe(false);
  expect(resignDisabled(view({ canResign: true, turn: 'blue' }), 'red'), '不是自己回合').toBe(true);
  expect(resignDisabled(view({ canResign: true, over: true, winner: 'red' }), 'red')).toBe(true);
  expect(resignDisabled(view({ canResign: true }), null), '热座').toBe(false);
});

test('回合条文案按模式区分', () => {
  const red = view();
  expect(bannerText(red, 'hotseat')).toBe('红方回合 · 请翻棋或走子');
  expect(bannerText(red, 'ai'), '红方=人类且轮到它').toBe('轮到你了');

  const blueTurn = view({ turn: 'blue' });
  expect(bannerText(blueTurn, 'ai'), '轮到电脑').toBe('电脑思考中…');
  expect(bannerText(blueTurn, 'hotseat')).toBe('蓝方回合 · 请翻棋或走子');

  expect(bannerText(red, 'dual')).toBe('轮到你（红方）· 请落子');
  expect(bannerText(view({ turn: 'blue' }), 'dual')).toBe('等待对方（蓝方）…');

  expect(bannerText(view({ over: true, winner: 'draw' }), 'ai')).toBe('对局结束');
});

test('底部提示：20 步前会提示还不能认输，之后不再提示', () => {
  const early = footText(view({ step: MIN_GIVEUP - 1, noEat: 3 }));
  expect(early).toContain(`已走 ${MIN_GIVEUP - 1} 步`);
  expect(early).toContain('连续 3 步无吃子');
  expect(early).toContain('才能认输');

  const late = footText(view({ step: MIN_GIVEUP, noEat: 0 }));
  expect(late).not.toContain('才能认输');
});

test('countText', () => {
  expect(countText(view({ counts: { red: 12, blue: 7 } }), 'red')).toBe('剩 12 子');
  expect(countText(view({ counts: { red: 12, blue: 7 } }), 'blue')).toBe('剩 7 子');
});

test('结算标题', () => {
  expect(resultTitle('red')).toBe('红方获胜');
  expect(resultTitle('blue')).toBe('蓝方获胜');
  expect(resultTitle('draw')).toBe('和局');
  expect(resultTitle(null)).toBe('对局结束');
});

test('结算理由文案带上结束原因', () => {
  expect(resultWhy({ winner: 'red', reason: 'wipe' })).toBe('红方获胜 · 吃光了对方的全部棋子');
  expect(resultWhy({ winner: 'blue', reason: 'lastStand' })).toBe('蓝方获胜 · 最后之子比大小');
  expect(resultWhy({ winner: 'draw', reason: 'noEat' })).toContain('和局');
  expect(resultWhy({ winner: 'draw', reason: 'resign' })).toBe('和局 · 对方认输');
});

test('结算面板精灵图：红胜=第0列、蓝胜=第1列、和局=第2列', () => {
  // wait.png 已裁成 4 列 x 1 行（原图上面那行是联网口径 + 积分，本作不用）
  expect(resultColumn('red')).toBe(0);
  expect(resultColumn('blue')).toBe(1);
  expect(resultColumn('draw')).toBe(2);
  expect(resultColumn(null)).toBe(2);

  expect(resultPanelStyle('red')).toEqual({ backgroundSize: '400% 100%', backgroundPosition: '0% 0%' });
  expect(resultPanelStyle('blue')).toEqual({
    backgroundSize: '400% 100%',
    backgroundPosition: `${100 / 3}% 0%`,
  });
  expect(resultPanelStyle('draw').backgroundPosition).toBe(`${200 / 3}% 0%`);

  // 三个结果必须落在三个不同的列上（防"赢了显示失败"）
  const xs = new Set(['red', 'blue', 'draw'].map((w) => resultPanelStyle(w as 'red').backgroundPosition));
  expect(xs.size).toBe(3);
});
