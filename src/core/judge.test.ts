import { expect, test } from 'vitest';

import { judge, MAX_NO_EAT, MIN_GIVEUP } from './judge';
import { applyAction, createState } from './reduce';
import { stateFrom } from './test-helpers';

const only = stateFrom;

test('吃光对方全部棋子 → 对方获胜', () => {
  const noRed = only([
    'b0 b1 b2 b3 b4 b5',
    'b0 b1 b2 b3 b4 b5',
    'b0 b1 b2 b3 b4 b5',
    'b0 b1 b2 b3 b4 b5',
    'b0 b1 b2 b3 b4 b5',
    'b0 b1 b2 b3 b4 b5',
  ]);
  expect(noRed.counts.red).toBe(0);
  expect(judge(noRed).winner).toBe('blue');
  expect(noRed.reason).toBe('wipe');
});

test('双方各剩 1 子：刺客对国王 → 刺客方胜（两个方向都验）', () => {
  const redAssassin = only([
    'r5 . . . . .',
    '. . . . . .',
    '. . . . . .',
    '. . . . . .',
    '. . . . . .',
    '. . . . . b0',
  ]);
  expect(judge(redAssassin).winner).toBe('red');

  const blueAssassin = only([
    'r0 . . . . .',
    '. . . . . .',
    '. . . . . .',
    '. . . . . .',
    '. . . . . .',
    '. . . . . b5',
  ]);
  expect(judge(blueAssassin).winner).toBe('blue');
});

test('双方各剩 1 子：高等级胜低等级；同级判和（有意偏离原版）', () => {
  const knightVsGuard = only([
    'r2 . . . . .',
    '. . . . . .',
    '. . . . . .',
    '. . . . . .',
    '. . . . . .',
    '. . . . . b4',
  ]);
  expect(judge(knightVsGuard).winner).toBe('red');
  expect(knightVsGuard.reason).toBe('lastStand');

  const sameLevel = only([
    'r2 . . . . .',
    '. . . . . .',
    '. . . . . .',
    '. . . . . .',
    '. . . . . .',
    '. . . . . b2',
  ]);
  expect(judge(sameLevel).winner).toBe('draw');
  expect(sameLevel.reason).toBe('lastStand');
});

test('counts 声称各剩 1 子但棋盘对不上 → 兜底判和，不崩（原版就是在这条分支崩的）', () => {
  const inconsistent = only(
    [
      'r2 . . . . .',
      '. . . . . .',
      '. . . . . .',
      '. . . . . .',
      '. . . . . .',
      'r3 . . . . .',
    ],
    { counts: { red: 1, blue: 1 } },
  );
  expect(judge(inconsistent).winner).toBe('draw');
});

test('连续 30 步无吃子且无翻棋 → 和棋', () => {
  const state = createState(99);
  state.noEat = MAX_NO_EAT - 1;
  expect(judge(state).winner).toBeNull();
  state.noEat = MAX_NO_EAT;
  expect(judge(state).winner).toBe('draw');
  expect(state.reason).toBe('noEat');
});

test('翻棋会清零无吃子计数', () => {
  const state = createState(5);
  state.noEat = MAX_NO_EAT - 1;
  const res = applyAction(state, { t: 'flip', at: [0, 0] });
  if ('rejected' in res) throw new Error(res.rejected);
  expect(res.state.noEat).toBe(0);
  expect(res.state.winner).toBeNull();
});

test('认输：走过 20 步之前被拒，之后可认输', () => {
  const early = createState(3);
  early.step = MIN_GIVEUP - 1;
  early.turn = 'red';
  expect(applyAction(early, { t: 'resign' })).toHaveProperty('rejected');
  expect(early.winner).toBeNull();

  const late = createState(3);
  late.step = MIN_GIVEUP;
  late.turn = 'red';
  const ok = applyAction(late, { t: 'resign' });
  if ('rejected' in ok) throw new Error(ok.rejected);
  expect(ok.state.winner).toBe('blue');
  expect(ok.state.reason).toBe('resign');
  expect(ok.state.turn).toBe('red');
});

test('无子可动 → 和棋（原版会一直空转，本实现补上这一条）', () => {
  const trapped = only([
    'r0 b5 b5 b5 b5 b5',
    'b5 b5 b5 b5 b5 b5',
    'b5 b5 b5 b5 b5 b5',
    'b5 b5 b5 b5 b5 b5',
    'b5 b5 b5 b5 b5 b5',
    'b5 b5 b5 b5 b5 b5',
  ]);
  trapped.turn = 'red';
  expect(judge(trapped).winner).toBe('draw');
  expect(trapped.reason).toBe('stalemate');
});

test('judge 是幂等的：对已结束的状态再判一次不会改写结论', () => {
  const state = createState(4);
  state.winner = 'red';
  state.reason = 'resign';
  const again = judge(state);
  expect(again.winner).toBe('red');
  expect(again.reason).toBe('resign');

  // 就算 counts 看起来像"蓝方被吃光"，也不该翻案
  const flipped = stateFrom(
    [
      'r0 . . . . .',
      '. . . . . .',
      '. . . . . .',
      '. . . . . .',
      '. . . . . .',
      '. . . . . .',
    ],
    { winner: 'blue', reason: 'wipe', counts: { red: 1, blue: 0 } },
  );
  expect(judge(flipped).winner).toBe('blue');
});
