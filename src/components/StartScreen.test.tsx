// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react';
import { expect, test, vi } from 'vitest';

import { StartScreen } from './StartScreen';

test('第一枚按钮进人机对战，第二枚进联机大厅', () => {
  const onChoose = vi.fn();
  const onOnline = vi.fn();
  render(<StartScreen notice={null} onChoose={onChoose} onOnline={onOnline} />);

  fireEvent.click(screen.getByTestId('mode-ai'));
  expect(onChoose).toHaveBeenLastCalledWith('ai');
  expect(onOnline).not.toHaveBeenCalled();

  fireEvent.click(screen.getByTestId('mode-online'));
  expect(onOnline).toHaveBeenCalledTimes(1);
  expect(onChoose).toHaveBeenCalledTimes(1);
});

test('降级提示只在需要时出现', () => {
  const { unmount } = render(<StartScreen notice={null} onChoose={() => {}} onOnline={() => {}} />);
  expect(screen.queryByTestId('start-notice')).toBeNull();
  unmount();

  render(<StartScreen notice="这个浏览器不支持 SharedWorker，已退回单机热座" onChoose={() => {}} onOnline={() => {}} />);
  expect(screen.getByTestId('start-notice')).toHaveTextContent('SharedWorker');
});

test('按钮上是真文本（金盘背景 + 可朗读的文案）', () => {
  render(<StartScreen notice={null} onChoose={() => {}} onOnline={() => {}} />);
  const ai = screen.getByTestId('mode-ai');
  expect(ai).toHaveTextContent('本地对战');
  expect(ai.className).toContain('b-clean');
  expect(screen.getByTestId('mode-online')).toHaveTextContent('联网对战');
  expect(screen.queryByText('单人 · 对战电脑')).toBeNull();
});
