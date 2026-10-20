// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react';
import { expect, test, vi } from 'vitest';

import { MAX_NO_EAT, MIN_GIVEUP } from '../core/judge';
import { createState } from '../core/reduce';
import type { Side, ViewState } from '../core/types';
import { viewFor } from '../core/visibility';
import { Hud } from './Hud';

const view = (patch: Partial<ViewState> = {}, side: Side = 'red'): ViewState => ({
  ...viewFor(createState(1), side),
  ...patch,
});

function setup(v: ViewState, mode: 'ai' | 'hotseat' | 'dual' = 'ai', side: Side | null = 'red') {
  const onResign = vi.fn();
  render(<Hud view={v} mode={mode} side={side} onResign={onResign} />);
  return { onResign };
}

test('侧栏面板：每方 18 个格位，开局全部没翻起', () => {
  setup(view());
  for (const side of ['red', 'blue'] as const) {
    const slots = [...screen.getByTestId(`panel-${side}`).querySelectorAll('.pslot')];
    expect(slots).toHaveLength(18);
    expect(slots.every((s) => s.getAttribute('data-state') === 'down')).toBe(true);
  }
});

test('侧栏面板：翻开/被吃的棋子换成对应状态', () => {
  const base = view();
  const cells = base.cells.map((c, i) =>
    i < 3 ? { ...c, revealed: true, side: 'red' as const, level: 5 as const } : c,
  );
  setup(view({ cells, fallen: { red: [1, 0, 0, 0, 0, 1], blue: [0, 0, 0, 0, 0, 0] } }));
  const red = screen.getByTestId('panel-red');
  expect(red.querySelectorAll('.pslot.is-alive')).toHaveLength(3);
  expect(red.querySelectorAll('.pslot.is-dead')).toHaveLength(2);
  expect(screen.getByTestId('panel-blue').querySelectorAll('.pslot.is-down')).toHaveLength(18);
});

test('名牌：只高亮当前回合方，身份写"玩家/电脑"而不是颜色', () => {
  const headRed = () => document.querySelector('#head-red') as HTMLElement;
  const headBlue = () => document.querySelector('#head-blue') as HTMLElement;

  const { unmount } = render(<Hud view={view()} mode="ai" side="red" onResign={() => {}} />);
  expect(headRed().className).toContain('is-active');
  expect(headBlue().className).not.toContain('is-active');
  expect(headRed().textContent).toContain('玩家');
  expect(headBlue().textContent).toContain('电脑');
  unmount();

  render(<Hud view={view({ turn: 'blue' })} mode="hotseat" side={null} onResign={() => {}} />);
  expect(headBlue().className).toContain('is-active');
  expect(headRed().className).not.toContain('is-active');
});

test('回合条文案', () => {
  setup(view(), 'hotseat', null);
  expect(screen.getByTestId('banner')).toHaveTextContent('红方回合 · 请翻棋或走子');
});

test('认输按钮：20 步前禁用，20 步后可用，点它会上报', () => {
  const early = setup(view({ step: MIN_GIVEUP - 1, canResign: false }));
  const button = screen.getByTitle('认输');
  expect(button).toBeDisabled();
  fireEvent.click(button);
  expect(early.onResign, '禁用状态点击不该上报').not.toHaveBeenCalled();
});

test('认输按钮：步数够了且轮到自己才亮', () => {
  const { onResign } = setup(view({ step: MIN_GIVEUP, canResign: true }));
  const button = screen.getByTitle('认输');
  expect(button).toBeEnabled();
  fireEvent.click(button);
  expect(onResign).toHaveBeenCalledTimes(1);
});

test('认输按钮：步数够了但不是自己回合 → 仍然禁用', () => {
  setup(view({ step: MIN_GIVEUP, canResign: true, turn: 'blue' }), 'dual', 'red');
  expect(screen.getByTitle('认输')).toBeDisabled();
});

test('顶部计数行：只报未吃子步数和判和阈值', () => {
  setup(view({ step: 3, noEat: 2 }));
  const foot = document.querySelector('#foot')!;
  expect(foot.textContent).toBe(`已 2 步未吃子，${MAX_NO_EAT} 步将判和`);
  // 总步数和认输门槛提示已从界面上拿掉（步数改走 data-step，给测试与 click-check 用）
  expect(foot.textContent).not.toContain('已走');
  expect(foot.textContent).not.toContain('才能认输');
  expect(foot.getAttribute('data-step')).toBe('3');
});

test('终局：回合条显示对局结束，认输禁用', () => {
  setup(view({ over: true, winner: 'red', canResign: false }));
  expect(screen.getByTestId('banner')).toHaveTextContent('对局结束');
  expect(screen.getByTitle('认输')).toBeDisabled();
});
