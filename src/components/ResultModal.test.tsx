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

test('对局没结束就不渲染任何东西', () => {
  render(<ResultModal view={viewFor(createState(1), 'red')} onOk={() => {}} onRestart={() => {}} />);
  expect(screen.queryByTestId('result-modal')).toBeNull();
});

test('红方获胜 → 精灵图第 0 列', () => {
  render(<ResultModal view={finished('red', 'wipe')} onOk={() => {}} onRestart={() => {}} />);
  expect(overlay().style.backgroundPosition).toBe('0% 0%');
  expect(overlay().style.backgroundSize).toBe('400% 100%');
  expect(screen.getByTestId('result-why')).toHaveTextContent('红方获胜');
  expect(screen.getByTestId('result-why')).toHaveTextContent('吃光了对方的全部棋子');
});

test('蓝方获胜 → 第 1 列（不会显示成红方）', () => {
  render(<ResultModal view={finished('blue', 'lastStand')} onOk={() => {}} onRestart={() => {}} />);
  expect(overlay().style.backgroundPosition).toBe(`${100 / 3}% 0%`);
  expect(screen.getByTestId('result-why')).toHaveTextContent('蓝方获胜');
});

test('和局 → 第 2 列', () => {
  render(<ResultModal view={finished('draw', 'noEat')} onOk={() => {}} onRestart={() => {}} />);
  expect(overlay().style.backgroundPosition).toBe(`${200 / 3}% 0%`);
  expect(screen.getByTestId('result-why')).toHaveTextContent('和局');
});

test('确定 → 回开始界面；再来一局 → 换一盘', () => {
  const onOk = vi.fn();
  const onRestart = vi.fn();
  render(<ResultModal view={finished('red')} onOk={onOk} onRestart={onRestart} />);

  fireEvent.click(document.querySelector('#ok') as HTMLElement);
  expect(onOk).toHaveBeenCalledTimes(1);

  fireEvent.click(screen.getByText('再来一局（换一盘）'));
  expect(onRestart).toHaveBeenCalledTimes(1);
});

test('对局记录：标记按钮与导出按钮都挂在终局弹窗上', () => {
  const onFlag = vi.fn();
  const onExport = vi.fn();
  const { rerender } = render(
    <ResultModal view={finished('red')} onOk={() => {}} onRestart={() => {}} onFlag={onFlag} onExport={onExport} recordCount={3} />,
  );
  fireEvent.click(screen.getByTestId('flag-game'));
  expect(onFlag).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByTestId('export-log'));
  expect(onExport).toHaveBeenCalledTimes(1);
  expect(screen.getByTestId('export-log')).toHaveTextContent('导出对局记录（3）');
  expect(screen.getByTestId('flag-game')).toHaveTextContent('标记这局有问题');

  // 已标记的状态要能看出来（否则用户会重复点）
  rerender(
    <ResultModal view={finished('red')} onOk={() => {}} onRestart={() => {}} flagged onFlag={onFlag} onExport={onExport} recordCount={3} />,
  );
  expect(screen.getByTestId('flag-game')).toHaveTextContent('已标记这局');
});
