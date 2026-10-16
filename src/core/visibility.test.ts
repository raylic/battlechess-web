import { expect, test } from 'vitest';

import { mulberry32 } from './rng';
import { applyAction, cloneState, createState } from './reduce';
import { POLICY, viewFor } from './visibility';
import { stateFrom } from './test-helpers';
import type { GameState, Side } from './types';

/**
 * 只打乱"未翻开棋子"的身份，格子与 id 都不动。
 * 双盲之下，这种改动必须对任何视角都不可观测。
 */
function permuteHidden(state: GameState): GameState {
  const next = cloneState(state);
  const hidden = [];
  for (let r = 0; r < 6; r++) {
    for (let c = 0; c < 6; c++) {
      const p = next.grid[r]![c];
      if (p && !p.revealed) hidden.push(p);
    }
  }
  const attrs = hidden.map((p) => ({ side: p.side, level: p.level })).reverse();
  hidden.forEach((p, i) => Object.assign(p, attrs[i]));
  return next;
}

const fingerprint = (state: GameState) =>
  state.grid
    .map((row) => row.map((p) => (p ? `${p.side}${p.level}${p.revealed ? '!' : ''}` : '..')).join('|'))
    .join('/');

const strip = (view: ReturnType<typeof viewFor>) => {
  const { you, legal, ...rest } = view;
  void you;
  void legal;
  return rest;
};

test('双盲：只打乱未翻开棋子的身份，视角投影必须完全一致（不可区分）', () => {
  const truth = createState(777);
  const shuffled = permuteHidden(truth);
  expect(fingerprint(truth), '为了测试有效，真相必须真的变了').not.toBe(fingerprint(shuffled));

  for (const side of ['red', 'blue'] as Side[]) {
    expect(viewFor(truth, side)).toEqual(viewFor(shuffled, side));
  }
});

test('双盲：整局进行中（已有明子）依然不可区分', () => {
  let state = createState(4242);
  const rand = mulberry32(1);
  for (let i = 0; i < 14 && !state.winner; i++) {
    const view = viewFor(state, state.turn);
    const legal = [
      ...view.legal.flips.map((at) => ({ t: 'flip' as const, at })),
      ...view.legal.moves.map((m) => ({ t: 'move' as const, from: m.from, to: m.to })),
    ];
    if (!legal.length) break;
    const res = applyAction(state, legal[Math.floor(rand() * legal.length)]);
    if ('rejected' in res) throw new Error(res.rejected);
    state = res.state;
  }

  const shuffled = permuteHidden(state);
  expect(fingerprint(state)).not.toBe(fingerprint(shuffled));
  for (const side of ['red', 'blue'] as Side[]) {
    expect(viewFor(state, side)).toEqual(viewFor(shuffled, side));
  }
});

test('双盲的必然结果：两个视角只在 you / legal 上不同', () => {
  const state = createState(31337);
  expect(strip(viewFor(state, 'red'))).toEqual(strip(viewFor(state, 'blue')));
  expect(viewFor(state, 'red').you).not.toBe(viewFor(state, 'blue').you);
});

test('投影里未翻开的格子，side 与 level 必须是 null', () => {
  const state = createState(20250101);
  for (const side of ['red', 'blue'] as Side[]) {
    const view = viewFor(state, side);
    expect(view.cells.length).toBe(36);
    for (const cell of view.cells) {
      expect(cell.revealed).toBe(false);
      expect(cell.side, `格子 ${cell.at} 泄漏了阵营`).toBeNull();
      expect(cell.level, `格子 ${cell.at} 泄漏了等级`).toBeNull();
    }
    expect(view.policy).toBe(POLICY.DOUBLE_BLIND);
  }
});

test('已翻开的棋子双方都看得见', () => {
  const state = stateFrom([
    'r0 . . . . .',
    '. . . . . .',
    '. . . . . .',
    '. . . . . .',
    '. . . . . .',
    '. . . . . b3',
  ]);
  for (const side of ['red', 'blue'] as Side[]) {
    const view = viewFor(state, side);
    const a = view.cells.find((c) => c.at[0] === 0 && c.at[1] === 0)!;
    expect([a.revealed, a.side, a.level]).toEqual([true, 'red', 0]);
    const b = view.cells.find((c) => c.at[0] === 5 && c.at[1] === 5)!;
    expect([b.revealed, b.side, b.level]).toEqual([true, 'blue', 3]);
  }
});

test('合法着法只下发给当前回合方的视角', () => {
  const state = createState(88);
  const redView = viewFor(state, 'red');
  const blueView = viewFor(state, 'blue');
  expect(state.turn).toBe('red');
  expect(redView.legal.flips.length).toBeGreaterThan(0);
  expect(blueView.legal.flips.length, '非当前回合方拿不到任何合法着法').toBe(0);
  expect(blueView.legal.moves.length).toBe(0);
});

test('口径 B 开关可用：切成"己方可见"后自己的暗子可见、对方的仍不可见', () => {
  const state = createState(6060);
  const own = viewFor(state, 'red', POLICY.OWN_KNOWN);
  expect(own.cells.filter((c) => c.side === 'red').length).toBe(18);
  expect(own.cells.filter((c) => c.side === 'blue').every((c) => !c.revealed)).toBe(true);

  const enemy = viewFor(state, 'blue', POLICY.OWN_KNOWN);
  expect(enemy.cells.filter((c) => c.side === 'blue').length).toBe(18);

  expect(viewFor(state, 'red', POLICY.OWN_KNOWN)).not.toEqual(viewFor(state, 'red', POLICY.DOUBLE_BLIND));
});

test('终局全亮，方便复盘', () => {
  const state = createState(4);
  state.winner = 'red';
  const view = viewFor(state, 'blue');
  expect(view.over).toBe(true);
  expect(view.cells.filter((c) => c.id).every((c) => c.revealed && c.side !== null)).toBe(true);
});

test('投影是全新对象，改它不会污染真相', () => {
  const state = createState(15);
  const view = viewFor(state, 'red');
  view.cells[0]!.revealed = true;
  view.cells[0]!.side = 'blue';
  view.counts.red = 999;
  expect(state.grid[0]![0]!.revealed).toBe(false);
  expect(state.counts.red).toBe(18);
});

test('朝向随投影下发给前端（React 组件因此可以是纯的）', () => {
  const state = stateFrom([
    'r0 . . . . .',
    '. . . . . .',
    '. . . . . .',
    '. . . . . .',
    '. . . . . .',
    '. . . . . .',
  ]);
  const moved = applyAction(state, { t: 'move', from: [0, 0], to: [0, 1] });
  if ('rejected' in moved) throw new Error(moved.rejected);
  const view = viewFor(moved.state, 'red');
  expect(view.cells.find((c) => c.at[0] === 0 && c.at[1] === 1)!.dire).toBe(1);
});
