// applyAction / Authority 的"非法输入不崩"测试。
// 这是原生版审计里变异存活的头号缺口：畸形 action 会让它直接 TypeError，
// 而 action 来自 transport 边界（SharedWorker / 将来的 WebSocket），属于不可信输入。

import { expect, test } from 'vitest';

import { Authority } from './authority';
import { applyAction, cloneState, createState, toPos } from './reduce';
import { stateFrom } from './test-helpers';

const garbage: unknown[] = [
  null,
  undefined,
  0,
  'flip',
  [],
  {},
  { t: 'flip' },
  { t: 'flip', at: null },
  { t: 'flip', at: [0] },
  { t: 'flip', at: [0, 1, 2] },
  { t: 'flip', at: ['0', '1'] },
  { t: 'flip', at: [1.5, 2] },
  { t: 'flip', at: [99, 99] },
  { t: 'flip', at: [-1, 0] },
  { t: 'move' },
  { t: 'move', from: [0, 0] },
  { t: 'move', from: [0, 0], to: null },
  { t: 'move', from: { row: 0 }, to: [0, 1] },
  { t: 'totally-unknown' },
];

test('畸形 action 一律返回 rejected，绝不抛异常', () => {
  for (const bad of garbage) {
    const state = createState(12345);
    expect(() => applyAction(state, bad), JSON.stringify(bad)).not.toThrow();
    const res = applyAction(state, bad);
    expect(res, JSON.stringify(bad)).toHaveProperty('rejected');
    // 状态没被碰过
    expect(state.step).toBe(0);
    expect(state.winner).toBeNull();
  }
});

test('toPos：只接受两个整数', () => {
  expect(toPos([1, 2])).toEqual([1, 2]);
  expect(toPos([1.5, 2])).toBeNull();
  expect(toPos(['1', 2])).toBeNull();
  expect(toPos([1])).toBeNull();
  expect(toPos(null)).toBeNull();
  expect(toPos('1,2')).toBeNull();
});

test('cloneState 是深拷贝：改副本不影响原状态', () => {
  const state = createState(7);
  const copy = cloneState(state);
  copy.grid[0]![0]!.revealed = true;
  copy.counts.red = 0;
  copy.lastStep = [5, 5];
  expect(state.grid[0]![0]!.revealed).toBe(false);
  expect(state.counts.red).toBe(18);
  expect(state.lastStep).toBeNull();
});

test('Authority.dispatch：畸形消息被拒且不崩，也不广播', () => {
  const authority = new Authority(2);
  const seen: unknown[] = [];
  authority.subscribe('red', (msg) => seen.push(msg));

  for (const bad of garbage) {
    expect(() => authority.dispatch('red', bad), JSON.stringify(bad)).not.toThrow();
    const res = authority.dispatch('red', bad);
    expect(res).toHaveProperty('rejected');
  }
  expect(seen.length, '只该有 subscribe 同步下发的那一条初始快照，畸形消息不广播').toBe(1);
});

test('Authority.dispatch：把垃圾消息原样丢给 applyAction 也不会污染状态', () => {
  const authority = new Authority(3);
  authority.dispatch(null, { t: 'flip', at: [0, 0] });
  const before = JSON.stringify(authority.truth());
  authority.dispatch(null, { t: 'move', from: [1, 1], to: [2, 2] }); // 未翻开 → 不合法
  authority.dispatch(null, null);
  expect(JSON.stringify(authority.truth())).toBe(before);
});

test('stateFrom 摆出来的局面 counts 是算出来的', () => {
  const state = stateFrom([
    'r0 b1 . . . .',
    '. . . . . .',
    '. . . . . .',
    '. . . . . .',
    '. . . . . .',
    'r2* b3* . . . .',
  ]);
  expect(state.counts).toEqual({ red: 2, blue: 2 });
});
