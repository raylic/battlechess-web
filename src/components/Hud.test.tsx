// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react';
import { expect, test, vi } from 'vitest';

import { MIN_GIVEUP } from '../core/judge';
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

test('两侧面板数字 = 剩余子数', () => {
  setup(view({ counts: { red: 12, blue: 7 } }));
  expect(screen.getByTestId('panel-count-red')).toHaveTextContent('12');
  expect(screen.getByTestId('panel-count-blue')).toHaveTextContent('7');
  expect(screen.getByText('剩 12 子')).toBeInTheDocument();
  expect(screen.getByText('剩 7 子')).toBeInTheDocument();
  expect(screen.getByText('红方剩余')).toBeInTheDocument();
  expect(screen.getByText('蓝方剩余')).toBeInTheDocument();
});

test('头像框：当前回合方高亮，名字按模式变', () => {
  const headRed = () => document.querySelector('#head-red') as HTMLElement;
  const headBlue = () => document.querySelector('#head-blue') as HTMLElement;
  const nameOf = (head: HTMLElement) => head.querySelector('.line.name')!.textContent;

  const { unmount } = render(<Hud view={view()} mode="ai" side="red" onResign={() => {}} />);
  expect(headRed().className).toContain('is-active');
  expect(headBlue().className).not.toContain('is-active');
  expect(nameOf(headRed())).toBe('你');
  expect(nameOf(headBlue())).toBe('电脑');
  unmount();

  render(<Hud view={view({ turn: 'blue' })} mode="hotseat" side={null} onResign={() => {}} />);
  expect(headBlue().className).toContain('is-active');
  expect(headRed().className).not.toContain('is-active');
  expect(nameOf(headRed())).toBe('红方');
  expect(nameOf(headBlue())).toBe('蓝方');
  expect(headRed().querySelector('.line.title')!.textContent).toBe('红方');
  expect(headRed().querySelector('.line.count')!.textContent).toBe('剩 18 子');
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

test('底部提示：20 步前提示还不能认输', () => {
  setup(view({ step: 3, noEat: 2 }));
  const foot = document.querySelector('#foot')!;
  expect(foot.textContent).toContain('已走 3 步');
  expect(foot.textContent).toContain('连续 2 步无吃子');
  expect(foot.textContent).toContain('才能认输');
});

test('终局：回合条显示对局结束，认输禁用', () => {
  setup(view({ over: true, winner: 'red', canResign: false }));
  expect(screen.getByTestId('banner')).toHaveTextContent('对局结束');
  expect(screen.getByTitle('认输')).toBeDisabled();
});
