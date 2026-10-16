// @vitest-environment jsdom
import { act, render, screen } from '@testing-library/react';
import { expect, test, vi } from 'vitest';

import { Toast, TOAST_MS } from './Toast';

test('没有消息时不渲染', () => {
  render(<Toast message={null} onDone={() => {}} />);
  expect(screen.queryByTestId('toast')).toBeNull();
});

test('显示消息并在 1.8 秒后自动消失', () => {
  vi.useFakeTimers();
  const onDone = vi.fn();
  const { rerender } = render(<Toast message="还没轮到你" onDone={onDone} />);

  expect(screen.getByTestId('toast')).toHaveTextContent('还没轮到你');

  act(() => {
    vi.advanceTimersByTime(TOAST_MS - 1);
  });
  expect(onDone, '没到时间不该收回').not.toHaveBeenCalled();

  act(() => {
    vi.advanceTimersByTime(1);
  });
  expect(onDone).toHaveBeenCalledTimes(1);

  rerender(<Toast message={null} onDone={onDone} />);
  expect(screen.queryByTestId('toast')).toBeNull();
  vi.useRealTimers();
});

test('换一条消息会重新计时', () => {
  vi.useFakeTimers();
  const onDone = vi.fn();
  const { rerender } = render(<Toast message="第一条" onDone={onDone} />);
  act(() => {
    vi.advanceTimersByTime(TOAST_MS - 100);
  });
  rerender(<Toast message="第二条" onDone={onDone} />);
  act(() => {
    vi.advanceTimersByTime(200);
  });
  expect(onDone, '旧定时器应该被清掉').not.toHaveBeenCalled();
  vi.useRealTimers();
});
