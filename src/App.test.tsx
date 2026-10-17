// @vitest-environment jsdom
// App 级集成测试：开始界面 → 人机对战 → 玩家翻棋 → AI 应招。
// 原生版审计里 app.js 是 203 行、0 覆盖（连变异测试都做不了，因为代码根本没被加载）。

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { expect, test } from 'vitest';

import App from './App';

const cells = () => screen.getAllByTestId(/^cell-/);
const pieces = () => [...document.querySelectorAll('.piece')];
const revealed = () => [...document.querySelectorAll('.piece.is-revealed')];

test('开始界面：两个模式按钮都可用', () => {
  render(<App />);
  expect(screen.getByTestId('start-screen')).toBeInTheDocument();
  expect(screen.getByTestId('mode-ai')).toBeEnabled();
  expect(screen.getByTestId('mode-dual')).toBeEnabled();
  expect(document.querySelector('#game')).toBeNull();
});

test('人机对战：翻棋 → AI 应招 → 步数累加，认输按钮初期禁用', async () => {
  render(<App />);
  fireEvent.click(screen.getByTestId('mode-ai'));

  // 初始 state 是异步下发的
  await waitFor(() => expect(cells()).toHaveLength(36));
  expect(screen.queryByTestId('start-screen'), '开局后开始界面应当卸载').toBeNull();
  expect(pieces()).toHaveLength(36);
  expect(revealed()).toHaveLength(0);
  expect(screen.getByTestId('banner')).toHaveTextContent('轮到你了');
  expect(screen.getByTitle('认输')).toBeDisabled();
  expect(document.querySelector('#foot')!.textContent).toContain('已走 0 步');

  // 玩家翻一张暗子
  fireEvent.click(screen.getByTestId('cell-0-0'));
  await waitFor(() => expect(revealed()).toHaveLength(1));
  expect(screen.getByTestId('banner')).toHaveTextContent('电脑思考中…');

  // AI 思考 420ms 后应招
  await waitFor(() => expect(screen.getByTestId('banner')).toHaveTextContent('轮到你了'), {
    timeout: 3000,
  });
  await waitFor(() => expect(document.querySelector('#foot')!.textContent).toContain('已走 2 步'));
  expect(revealed().length, 'AI 至少要动一下子').toBeGreaterThanOrEqual(2);
  expect(pieces(), '现有 UI 下没有任何棋子会消失').toHaveLength(36);
});

test('不是自己回合时，点棋盘不会有任何进展', async () => {
  render(<App />);
  fireEvent.click(screen.getByTestId('mode-ai'));
  await waitFor(() => expect(cells()).toHaveLength(36));

  fireEvent.click(screen.getByTestId('cell-0-0'));
  await waitFor(() => expect(screen.getByTestId('banner')).toHaveTextContent('电脑思考中…'));
  const footBefore = document.querySelector('#foot')!.textContent;

  // 趁着轮到电脑，连点几下：不该有任何 effect（也不能抛错）
  fireEvent.click(screen.getByTestId('cell-1-1'));
  fireEvent.click(screen.getByTestId('cell-2-2'));
  expect(document.querySelector('#foot')!.textContent).toBe(footBefore);
});

test('棋子按 id 复用节点：AI 走完后仍是同一批 DOM 节点（动画才有得放矢）', async () => {
  render(<App />);
  fireEvent.click(screen.getByTestId('mode-ai'));
  await waitFor(() => expect(cells()).toHaveLength(36));

  const before = pieces();
  fireEvent.click(screen.getByTestId('cell-0-0'));
  await waitFor(() => expect(screen.getByTestId('banner')).toHaveTextContent('轮到你了'), {
    timeout: 3000,
  });

  const after = pieces();
  // 用 id 找同一个棋子的节点，必须是同一个对象
  const idOf = (el: Element) => (el as HTMLElement).dataset.pieceId;
  const sampleId = idOf(before[0]!)!;
  const same = after.find((el) => idOf(el) === sampleId)!;
  expect(same).toBe(before[0]);
});
