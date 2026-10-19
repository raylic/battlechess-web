// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react';
import { expect, test, vi } from 'vitest';

import { ConnectingScreen } from './ConnectingScreen';

test('还在连：显示房号与等待文案', () => {
  render(<ConnectingScreen code="4821" error={null} onCancel={() => {}} />);
  expect(screen.getByTestId('connecting-screen')).toBeInTheDocument();
  expect(screen.getByRole('heading')).toHaveTextContent('正在连接');
  expect(screen.getByTestId('connecting-detail')).toHaveTextContent('房间 4821');
});

test('连不上：换成失败文案，原因原样留在屏上（不像 Toast 那样几秒就消失）', () => {
  render(<ConnectingScreen code="4821" error="联机失败：Could not connect to peer" onCancel={() => {}} />);
  expect(screen.getByRole('heading')).toHaveTextContent('连不上这个房间');
  expect(screen.getByTestId('connecting-detail')).toHaveTextContent('Could not connect to peer');
});

test('返回按钮把控制权交回上层（回开始界面 / 大厅）', () => {
  const onCancel = vi.fn();
  render(<ConnectingScreen code={null} error={null} onCancel={onCancel} />);
  expect(screen.getByTestId('connecting-detail')).toHaveTextContent('房间 ----');
  fireEvent.click(screen.getByRole('button', { name: '返回' }));
  expect(onCancel).toHaveBeenCalledTimes(1);
});
