// @vitest-environment jsdom
import { fireEvent, render, screen, within } from '@testing-library/react';
import { expect, test, vi } from 'vitest';

import { StartScreen } from './StartScreen';

test('两个模式按钮分别回调 ai / dual', () => {
  const onChoose = vi.fn();
  render(<StartScreen seed={12345} notice={null} onChoose={onChoose} />);

  fireEvent.click(screen.getByTestId('mode-ai'));
  expect(onChoose).toHaveBeenLastCalledWith('ai');

  fireEvent.click(screen.getByTestId('mode-dual'));
  expect(onChoose).toHaveBeenLastCalledWith('dual');
  expect(onChoose).toHaveBeenCalledTimes(2);
});

test('显示棋盘种子（可复现）', () => {
  render(<StartScreen seed={777} notice={null} onChoose={() => {}} />);
  expect(screen.getByTestId('seed-hint')).toHaveTextContent('#777');
});

test('降级提示只在需要时出现', () => {
  const { unmount } = render(<StartScreen seed={1} notice={null} onChoose={() => {}} />);
  expect(screen.queryByTestId('start-notice')).toBeNull();
  unmount();

  render(<StartScreen seed={1} notice="这个浏览器不支持 SharedWorker，已退回单机热座" onChoose={() => {}} />);
  expect(screen.getByTestId('start-notice')).toHaveTextContent('SharedWorker');
});

test('按钮上带无障碍文本，视觉靠精灵图', () => {
  render(<StartScreen seed={1} notice={null} onChoose={() => {}} />);
  expect(within(screen.getByTestId('mode-ai')).getByText('单人 · 对战电脑')).toHaveClass('sr-only');
  expect(within(screen.getByTestId('mode-dual')).getByText('双人 · 两个视角')).toHaveClass('sr-only');
});
