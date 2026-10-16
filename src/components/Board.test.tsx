// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react';
import { expect, test, vi } from 'vitest';

import { applyAction, createState } from '../core/reduce';
import { stateFrom } from '../core/test-helpers';
import type { Action, ViewState } from '../core/types';
import { viewFor } from '../core/visibility';
import { Board } from './Board';

/** 局面：红方国王(0,0)已翻开；只有一个暗子在(5,2)；其余是空格 */
const openBoard = (): ViewState =>
  viewFor(
    stateFrom([
      'r0 . . . . .',
      '. . . . . .',
      '. . . . . .',
      '. . . . . .',
      '. . . . . .',
      '. . b3* . . .',
    ]),
    'red',
  );

function setup(view: ViewState) {
  const onAction = vi.fn<(a: Action) => void>();
  const utils = render(<Board view={view} onAction={onAction} />);
  const cell = (row: number, col: number) => screen.getByTestId(`cell-${row}-${col}`);
  return { onAction, cell, ...utils };
}

test('渲染 36 个格子 + 36 个棋子，棋子层在棋盘内部（3D 继承）', () => {
  const { container } = render(<Board view={viewFor(createState(2024), 'red')} onAction={() => {}} />);
  expect(container.querySelectorAll('.cell')).toHaveLength(36);
  expect(container.querySelectorAll('.piece')).toHaveLength(36);
  const board = screen.getByTestId('board');
  expect(board.querySelector('#pieces')).not.toBeNull();
});

test('格子配色：奇偶交替（原版 (i+j)%2 → 紫/白）', () => {
  const { container } = render(<Board view={openBoard()} onAction={() => {}} />);
  const cells = [...container.querySelectorAll('.cell')];
  expect(cells[0]!.className, '(0,0) 紫').toContain('parity-0');
  expect(cells[1]!.className, '(0,1) 白').toContain('parity-1');
  expect(cells[7]!.className, '(1,1) 紫').toContain('parity-0');
});

test('点暗子 → 发 flip', () => {
  const { onAction, cell } = setup(openBoard());
  fireEvent.click(cell(5, 2));
  expect(onAction).toHaveBeenCalledTimes(1);
  expect(onAction.mock.calls[0]![0]).toEqual({ t: 'flip', at: [5, 2] });
});

test('点自己的明子 → 选中；再点可落点 → 发 move', () => {
  const { onAction, cell } = setup(openBoard());

  fireEvent.click(cell(0, 0));
  expect(onAction, '选中的动作不该发给权威').not.toHaveBeenCalled();
  expect(cell(0, 0).className).toContain('is-selected');
  expect(cell(0, 1).className, '可落点要高亮').toContain('is-target');
  expect(cell(1, 0).className).toContain('is-target');

  fireEvent.click(cell(1, 0));
  expect(onAction).toHaveBeenCalledTimes(1);
  expect(onAction.mock.calls[0]![0]).toEqual({ t: 'move', from: [0, 0], to: [1, 0] });
});

test('点不可落点的空格 → 只取消选中，不发操作', () => {
  const { onAction, cell } = setup(openBoard());
  fireEvent.click(cell(0, 0));
  fireEvent.click(cell(3, 3));
  expect(onAction).not.toHaveBeenCalled();
  expect(cell(0, 0).className).not.toContain('is-selected');
});

test('守卫：不是自己回合的视角，点哪儿都没反应', () => {
  const { onAction, cell } = setup(viewFor(openBoardState(), 'blue'));
  fireEvent.click(cell(0, 0));
  fireEvent.click(cell(5, 2));
  fireEvent.click(cell(3, 3));
  expect(onAction).not.toHaveBeenCalled();
  expect(cell(0, 0).className).not.toContain('is-selected');
  expect(cell(5, 2).className).not.toContain('is-hoverable');
});

test('守卫：终局之后点哪儿都没反应', () => {
  const state = openBoardState();
  state.winner = 'red';
  state.reason = 'wipe';
  const { onAction, cell } = setup(viewFor(state, 'red'));
  fireEvent.click(cell(0, 0));
  fireEvent.click(cell(5, 2));
  expect(onAction).not.toHaveBeenCalled();
});

test('上一步高亮 + 轮到自己时的可操作提示', () => {
  const state = openBoardState();
  state.lastStep = [5, 2];
  const { cell } = setup(viewFor(state, 'red'));
  expect(cell(5, 2).className).toContain('is-last');
  expect(cell(5, 2).className).toContain('is-hoverable');
  expect(cell(3, 3).className).not.toContain('is-hoverable');
});

test('棋子按 id 复用 DOM 节点（位移动画的前提）', () => {
  // 注意：两个视图必须来自同一个 state —— 棋子 id 只在同一盘里稳定，
  // 重新摆一个局面会得到一批新 id，React 会当成新棋子（旧的重挂/淡出）
  const state = openBoardState();
  const { rerender, container } = render(<Board view={viewFor(state, 'red')} onAction={() => {}} />);
  const before = container.querySelectorAll('.piece');
  expect(before).toHaveLength(2);
  const nodeBefore = before[0]!;
  const pxBefore = (nodeBefore as HTMLElement).style.getPropertyValue('--px');

  const moved = applyAction(state, { t: 'move', from: [0, 0], to: [0, 1] });
  if ('rejected' in moved) throw new Error(moved.rejected);
  rerender(<Board view={viewFor(moved.state, 'red')} onAction={() => {}} />);

  const after = container.querySelectorAll('.piece');
  expect(after).toHaveLength(2);
  expect(after[0], '同一个棋子必须复用同一个 DOM 节点').toBe(nodeBefore);
  expect((after[0] as HTMLElement).style.getPropertyValue('--px')).not.toBe(pxBefore);
});

test('被吃掉的棋子会留一帧淡出幽灵，之后消失', async () => {
  const state = stateFrom([
    'r0 b3 . . . .',
    '. . . . . .',
    '. . . . . .',
    '. . . . . .',
    '. . . . . .',
    'r3 . . . . .',
  ]);
  const { rerender, container } = render(<Board view={viewFor(state, 'red')} onAction={() => {}} />);
  expect(container.querySelectorAll('.piece')).toHaveLength(3);

  const eaten = applyAction(state, { t: 'move', from: [0, 0], to: [0, 1] });
  if ('rejected' in eaten) throw new Error(eaten.rejected);
  rerender(<Board view={viewFor(eaten.state, 'red')} onAction={() => {}} />);

  // 场上还剩 2 个活子 + 1 个正在淡出的幽灵
  expect(container.querySelectorAll('.piece')).toHaveLength(3);
  expect(container.querySelectorAll('.piece.is-eaten')).toHaveLength(1);

  // 等淡出结束（GHOST_MS=320）
  await new Promise((r) => setTimeout(r, 400));
  rerender(<Board view={viewFor(eaten.state, 'red')} onAction={() => {}} />);
  expect(container.querySelectorAll('.piece.is-eaten')).toHaveLength(0);
});

function openBoardState() {
  return stateFrom([
    'r0 . . . . .',
    '. . . . . .',
    '. . . . . .',
    '. . . . . .',
    '. . . . . .',
    '. . b3* . . .',
  ]);
}
