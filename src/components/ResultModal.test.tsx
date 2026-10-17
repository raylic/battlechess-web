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
  fireEvent.click(document.querySelector('#ok') as HTMLElement);
  expect(onOk).toHaveBeenCalledTimes(1);
});

test('对局记录：导出按钮挂在终局弹窗上', () => {
  const onExport = vi.fn();
  render(<ResultModal view={finished('red')} onOk={() => {}} onExport={onExport} recordCount={3} />);
  fireEvent.click(screen.getByTestId('export-log'));
  expect(onExport).toHaveBeenCalledTimes(1);
  expect(screen.getByTestId('export-log')).toHaveTextContent('导出对局记录（3）');
});

test('没有 onExport 时不渲染记录按钮', () => {
  render(<ResultModal view={finished('red')} onOk={() => {}} />);
  expect(screen.queryByTestId('log-row')).toBeNull();
});
