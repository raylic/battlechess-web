// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { expect, test, vi } from 'vitest';

import { applyAction, createState } from '../core/reduce';
import { stateFrom } from '../core/test-helpers';
import type { ViewState } from '../core/types';
import { viewFor } from '../core/visibility';
import { GHOST_MS, useEatenGhosts } from './useEatenGhosts';

const drop = (view: ReturnType<typeof viewFor>, id: string) => ({
  ...view,
  cells: view.cells.map((c) => (c.id === id ? { ...c, id: null } : c)),
});

test('平静局面下没有幽灵', () => {
  const view = viewFor(createState(1), 'red');
  const { result } = renderHook(({ v }) => useEatenGhosts(v), { initialProps: { v: view } });
  expect(result.current).toEqual([]);
});

test('棋子从视图里消失 → 留一帧幽灵，带上它生前的身份；淡出后自动清理', () => {
  vi.useFakeTimers();
  // 用一张有明子的局面：能进幽灵的棋子一定是被吃掉的，而能吃的子必定已翻开
  const state = stateFrom([
    'r0 b3 . . . .',
    '. . . . . .',
    '. . . . . .',
    '. . . . . .',
    '. . . . . .',
    'r3 . . . . .',
  ]);
  const victimId = state.grid[0]![1]!.id;
  const base = viewFor(state, 'red');

  const { result, rerender } = renderHook(({ v }) => useEatenGhosts(v), { initialProps: { v: base } });

  act(() => {
    rerender({ v: drop(base, victimId) });
  });

  expect(result.current).toHaveLength(1);
  const ghost = result.current[0]!;
  expect(ghost.id).toBe(victimId);
  expect(ghost.at).toEqual([0, 1]);
  expect(ghost.side, '幽灵要能显示真面目（被吃时它已经翻开了）').toBe('blue');
  expect(ghost.level).toBe(3);

  act(() => {
    vi.advanceTimersByTime(GHOST_MS - 1);
  });
  expect(result.current).toHaveLength(1);
  act(() => {
    vi.advanceTimersByTime(1);
  });
  expect(result.current).toHaveLength(0);
  vi.useRealTimers();
});

test('320ms 内连吃两子，两个幽灵都要能消失', () => {
  // 曾经的写法在每次 view 变化时清掉定时器 → 第二个幽灵永远不会被移除
  vi.useFakeTimers();
  const base = viewFor(createState(1), 'red');
  const { result, rerender } = renderHook(({ v }) => useEatenGhosts(v), { initialProps: { v: base } });

  const v2 = drop(base, 'p0');
  act(() => {
    rerender({ v: v2 });
  });
  const v3 = drop(v2, 'p1');
  act(() => {
    rerender({ v: v3 });
  });
  expect(result.current.map((g) => g.id).sort()).toEqual(['p0', 'p1']);

  act(() => {
    vi.advanceTimersByTime(GHOST_MS + 1);
  });
  expect(result.current).toHaveLength(0);
  vi.useRealTimers();
});

test('真实吃子：被吃的蓝子留下幽灵', () => {
  vi.useFakeTimers();
  const state = stateFrom([
    'r0 b3 . . . .',
    '. . . . . .',
    '. . . . . .',
    '. . . . . .',
    '. . . . . .',
    'r3 . . . . .',
  ]);
  const before = viewFor(state, 'red');
  const { result, rerender } = renderHook(({ v }) => useEatenGhosts(v), { initialProps: { v: before } });

  const eaten = applyAction(state, { t: 'move', from: [0, 0], to: [0, 1] });
  if ('rejected' in eaten) throw new Error(eaten.rejected);
  const victimId = state.grid[0]![1]!.id;

  act(() => {
    rerender({ v: viewFor(eaten.state, 'red') });
  });
  expect(result.current).toHaveLength(1);
  expect(result.current[0]!.id).toBe(victimId);
  expect(result.current[0]!.side).toBe('blue');
  expect(result.current[0]!.level).toBe(3);

  act(() => {
    vi.advanceTimersByTime(GHOST_MS + 1);
  });
  expect(result.current).toHaveLength(0);
  vi.useRealTimers();
});

test('换局（view = null）会清空幽灵', () => {
  const base = viewFor(createState(1), 'red');
  const { result, rerender } = renderHook(
    ({ v }: { v: ViewState | null }) => useEatenGhosts(v),
    { initialProps: { v: base as ViewState | null } },
  );

  act(() => {
    rerender({ v: drop(base, 'p0') });
  });
  expect(result.current).toHaveLength(1);

  act(() => {
    rerender({ v: null });
  });
  expect(result.current).toHaveLength(0);
});
