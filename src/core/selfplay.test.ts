// 自对弈压测：这是当初原作者两个 bug 的"同类问题探针" —— 只要有一局崩/不收敛就报错

import { expect, test } from 'vitest';

import { chooseAction } from './ai';
import { applyAction, createState } from './reduce';
import { mulberry32 } from './rng';
import { viewFor } from './visibility';
import type { GameState } from './types';

const MAX_GUARD = 5000;

// 注意：自对弈是热点循环，内部只用普通 throw/if 判断，不要塞 expect（vitest 的 expect 很重，
// 几十万次会把默认 5s 超时拖爆）

function playRandom(seed: number): GameState {
  let state = createState(seed);
  const rand = mulberry32(seed);
  let guard = 0;
  while (!state.winner) {
    const view = viewFor(state, state.turn);
    const legal = [
      ...view.legal.flips.map((at) => ({ t: 'flip' as const, at })),
      ...view.legal.moves.map((m) => ({ t: 'move' as const, from: m.from, to: m.to })),
    ];
    if (!legal.length) throw new Error(`seed=${seed}：没有合法着法却没判和棋（会死循环）`);
    const res = applyAction(state, legal[Math.floor(rand() * legal.length)]);
    if ('rejected' in res) throw new Error(`seed=${seed}：合法着法却被拒：${res.rejected}`);
    state = res.state;
    if (++guard >= MAX_GUARD) throw new Error(`seed=${seed}：超过 ${MAX_GUARD} 步仍未结束`);
  }
  return state;
}

function playAi(seed: number): GameState {
  let state = createState(seed);
  let guard = 0;
  while (!state.winner) {
    const view = viewFor(state, state.turn);
    const rand = mulberry32((seed ^ Math.imul(state.step + 1, 2654435761)) >>> 0);
    const action = chooseAction(view, rand);
    if (!action) throw new Error(`seed=${seed}：AI 没有给出着法`);
    const res = applyAction(state, action);
    if ('rejected' in res) throw new Error(`seed=${seed}：AI 给出非法着法（${res.rejected}）`);
    state = res.state;
    if (++guard >= MAX_GUARD) throw new Error(`seed=${seed}：超过 ${MAX_GUARD} 步仍未结束`);
  }
  return state;
}

test(
  '随机合法着法自对弈 300 局：不崩、不死循环、全部收敛',
  { timeout: 60000 },
  () => {
  const reasons: Record<string, number> = {};
  for (let i = 0; i < 300; i++) {
    const state = playRandom(1000 + i);
    expect(state.winner).not.toBeNull();
    reasons[state.reason!] = (reasons[state.reason!] ?? 0) + 1;
  }
  console.log('  随机自对弈结束原因分布：', reasons);
  expect(Object.keys(reasons).every((r) => ['wipe', 'lastStand', 'noEat', 'stalemate'].includes(r))).toBe(
    true,
  );
  },
);

test(
  'AI 对 AI 1000 局：全部收敛，四类结束条件都被走到',
  { timeout: 60000 },
  () => {
  const winners = { red: 0, blue: 0, draw: 0 };
  const reasons: Record<string, number> = {};
  let totalSteps = 0;

  for (let i = 0; i < 1000; i++) {
    const state = playAi(7000 + i);
    winners[state.winner as 'red' | 'blue' | 'draw'] += 1;
    reasons[state.reason!] = (reasons[state.reason!] ?? 0) + 1;
    totalSteps += state.step;
  }

  console.log(
    '  AI 自对弈胜负：',
    winners,
    ' 结束原因：',
    reasons,
    ' 平均步数：',
    (totalSteps / 1000).toFixed(1),
  );

  // 1) 大部分对局要真打出结果（这版 AI 不会追击时和棋率曾高达 92%）
  expect(winners.red + winners.blue).toBeGreaterThan(550);
  // 2) 四种结束条件都要在自对弈里真的出现（尤其 lastStand —— 原版就是在这条分支上崩的）
  for (const r of ['wipe', 'lastStand', 'noEat']) {
    expect(reasons[r] ?? 0, `自对弈从未走到「${r}」分支`).toBeGreaterThan(0);
  }
  expect(reasons.lastStand ?? 0).toBeGreaterThanOrEqual(20);
  expect(reasons.stalemate ?? 0).toBeLessThan(100);
  },
);

test('确定性：同一 seed 两局结果完全一致', () => {
  for (const seed of [11, 222, 3333]) {
    const a = playAi(seed);
    const b = playAi(seed);
    expect(a.winner).toBe(b.winner);
    expect(a.step).toBe(b.step);
    expect(a.reason).toBe(b.reason);
    expect(JSON.stringify(a.grid)).toBe(JSON.stringify(b.grid));
  }
});
