// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react';
import { expect, test, vi } from 'vitest';

import { createState } from '../core/reduce';
import type { Side, ViewState } from '../core/types';
import { viewFor } from '../core/visibility';
import { ResultModal } from './ResultModal';

const finished = (winner: Side | 'draw', reason: ViewState['reason'] = 'wipe'): ViewState => ({
  ...viewFor(createState(1), 'red'),
  over: true,
  winner,
  reason,
});

const overlay = () => screen.getByTestId('result-panel') as HTMLElement;
/** 面板顶栏（王冠 + 标题）用的是哪张图 */
const topArt = () => (overlay().querySelector('.panel-top') as HTMLImageElement).src.split('/').pop();

test('对局没结束就不渲染任何东西', () => {
  render(<ResultModal view={viewFor(createState(1), 'red')} onOk={() => {}} />);
  expect(screen.queryByTestId('result-modal')).toBeNull();
});

test('红方获胜 → 红胜那张顶栏', () => {
  render(<ResultModal view={finished('red', 'wipe')} onOk={() => {}} />);
  expect(topArt()).toBe('wait_top_red.webp');
});

test('蓝方获胜 → 蓝胜那张（不会显示成红方）', () => {
  render(<ResultModal view={finished('blue', 'lastStand')} onOk={() => {}} />);
  expect(topArt()).toBe('wait_top_blue.webp');
});

test('和局 → 平局那张', () => {
  render(<ResultModal view={finished('draw', 'noEat')} onOk={() => {}} />);
  expect(topArt()).toBe('wait_top_draw.webp');
});

test('确定 → 触发 onOk', () => {
  const onOk = vi.fn();
  render(<ResultModal view={finished('red')} onOk={onOk} />);
  fireEvent.click(screen.getByRole('button', { name: '确定' }));
  expect(onOk).toHaveBeenCalledTimes(1);
});

test('弹窗里只有一个「确定」按钮，不再有导出对局记录那一行', () => {
  render(<ResultModal view={finished('red')} onOk={() => {}} />);
  expect(screen.getAllByRole('button')).toHaveLength(1);
  expect(screen.getByRole('button', { name: '确定' })).toBeInTheDocument();
  expect(screen.queryByTestId('log-row')).toBeNull();
});
