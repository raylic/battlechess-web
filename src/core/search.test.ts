import { describe, expect, test } from 'vitest';

import { LEVEL_COUNT_PER_SIDE, LEVEL_VALUE, SIDES } from './pieces';
import type { Action } from './types';
import { applyAction, createState, publicKey } from './reduce';
import { mulberry32 } from './rng';
import { legalActions } from './rules';
import { determinize, evaluate, flipClassKey, legalActionIndices, pimc, pimcAction, shouldResign } from './search';
import { stateFrom } from './test-helpers';
import { viewFor } from './visibility';
import { actionFromIndex, actionIndex, hiddenPool } from './features';

describe('evaluate 的威胁项开关（治"自投罗网"）', () => {
  // 红骑士(2) 挂在蓝将军(1) 嘴边：将军能吃骑士，骑士吃不回将军 → 净亏 160
  // 同时蓝弓箭手(3) 挂在红骑士嘴边（骑士能吃弓箭手）→ 敌方挂子
  const board = [
    'r2 . . . . .',
    'b1 . . . . .',
    '. . b3 . . .',
    '. . . . . .',
    '. . . . . .',
    '. . . . . .',
  ];

  test('默认：自己的挂子只按半价扣（这就是它敢把子送上去的原因）', () => {
    const state = stateFrom(board);
    const base = evaluate(state, 'red');
    const full = evaluate(state, 'red', { ownThreatFull: true });
    // 自己挂的骑士从 -80 变成 -160（noEat=0，和棋收缩系数为 1，所以差正好 80）
    expect(base - full).toBeCloseTo(80, 5);
  });

  test('默认：敌方挂子的加分不受自己挂子的开关影响（不会变得不敢吃、走成和棋）', () => {
    const state = stateFrom(board);
    // 从蓝方视角看：红骑士是"敌方的挂子"，所以蓝方的分数在两种设置下完全一样
    const a = evaluate(state, 'blue');
    const b = evaluate(state, 'blue', { ownThreatFull: true });
    expect(a).toBe(b);
  });

  test('kingFullPrice：挂着的国王按 1000 算，不再按 500', () => {
    // 蓝刺客(5) 吃得到红国王(0)：刺客是唯一能杀国王的低价子 → 国王挂着必死
    const state = stateFrom([
      'r0 b5 . . . .',
      '. . . . . .',
      '. . . . . .',
      '. . . . . .',
      '. . . . . .',
      '. . . . . .',
    ]);
    const base = evaluate(state, 'red');
    const full = evaluate(state, 'red', { kingFullPrice: true });
    expect(base - full).toBeCloseTo(500, 5); // 0.5 → 1.0 的一半
  });

  test('hiddenThreat：暗子被攻击也算威胁（按世界的真值算，跨世界平均就是概率）', () => {
    const state = stateFrom(
      ['r2* . . . . .', 'b1 . . . . .', '. . . . . .', '. . . . . .', '. . . . . .', '. . . . . .'],
    );
    // 暗着的红骑士被蓝将军吃得到：默认完全不计，开了之后按半价扣
    expect(evaluate(state, 'red')).toBe(evaluate(state, 'red', { hiddenThreat: false }));
    expect(evaluate(state, 'red') - evaluate(state, 'red', { hiddenThreat: true })).toBeCloseTo(80, 5);
  });
});

describe('determinize：采样一个与视角一致的世界', () => {
  test('已翻开的部分逐格一致，空格一致，占用一致', () => {
    const state = stateFrom(
      [
        'r0 b1* . . . b2',
        '. . . . . .',
        '. . . . . .',
        '. . . . . .',
        '. . . . . .',
        'r3* . . . . .',
      ],
      { turn: 'red', step: 5, noEat: 2 },
    );
    const view = viewFor(state, 'red');
    const world = determinize(view, mulberry32(42));

    for (const cell of view.cells) {
      const [r, c] = cell.at;
      const p = world.grid[r]![c];
      expect(Boolean(p)).toBe(Boolean(cell.id));
      if (cell.revealed && cell.side) {
        expect(p!.side).toBe(cell.side);
        expect(p!.level).toBe(cell.level);
        expect(p!.revealed).toBe(true);
      }
    }
    expect(world.turn).toBe('red');
    expect(world.step).toBe(5);
    expect(world.noEat).toBe(2);
  });

  test('暗格分配到的棋子，构成与公开剩余池严格一致', () => {
    // 用真实开局，再手工翻开两个子（翻开的身份本来就是公开信息）
    const state = createState(77);
    state.grid[0]![0]!.revealed = true;
    state.grid[5]![5]!.revealed = true;

    const view = viewFor(state, 'red');
    const pool = hiddenPool(view);
    const world = determinize(view, mulberry32(9));

    const hidden: Record<string, number[]> = { red: [0, 0, 0, 0, 0, 0], blue: [0, 0, 0, 0, 0, 0] };
    const alive: Record<string, number[]> = { red: [0, 0, 0, 0, 0, 0], blue: [0, 0, 0, 0, 0, 0] };
    for (let r = 0; r < 6; r++) {
      for (let c = 0; c < 6; c++) {
        const p = world.grid[r]![c]!;
        alive[p.side]![p.level] += 1;
        if (!p.revealed) hidden[p.side]![p.level] += 1;
      }
    }
    expect(hidden).toEqual(pool);
    for (const side of SIDES) expect(alive[side]).toEqual([...LEVEL_COUNT_PER_SIDE]);
  });

  test('合法着法在世界之间不变（都能对上 view.legal）', () => {
    const state = stateFrom(
      [
        'r0 . . b1 . .',
        '. . . . . .',
        '. . . . . .',
        '. . . . . .',
        '. . . . . .',
        'b5* . . . . r2',
      ],
      { turn: 'red' },
    );
    const view = viewFor(state, 'red');
    const expectIndices = legalActionIndices(view).sort((a, b) => a - b);
    for (let i = 0; i < 5; i++) {
      const world = determinize(view, mulberry32(i));
      const acts = legalActions(world);
      const got = [
        ...acts.flips.map((at) => actionIndex({ t: 'flip', at })!),
        ...acts.moves.map((m) => actionIndex({ t: 'move', from: m.from, to: m.to })!),
      ].sort((a, b) => a - b);
      expect(got).toEqual(expectIndices);
    }
  });

  test('采样确实是随机的（同一个视角不同随机源给出不同的暗子分布）', () => {
    const view = viewFor(createState(3), 'red');
    const a = determinize(view, mulberry32(1));
    const b = determinize(view, mulberry32(2));
    const line = (s: typeof a) => s.grid.flat().map((p) => (p ? `${p.side}${p.level}` : '.')).join(' ');
    expect(line(a)).not.toBe(line(b));
  });

  test('情报不自洽时显式抛错，而不是悄悄采出一个假世界', () => {
    const view = viewFor(createState(5), 'red');
    // 手动把 fallen 改坏：声称红方已经被吃掉了一堆子，但格子还是满的
    const broken = { ...view, fallen: { ...view.fallen, red: [...view.fallen.red] } };
    broken.fallen.red[0] = 1;
    expect(() => determinize(broken, mulberry32(1))).toThrow(/不自洽/);
  });
});

describe('evaluate：静态评估', () => {
  test('吃掉对方一个大子后，己方评估明显变好', () => {
    const before = stateFrom(
      ['r0 b0 . . . .', '. . . . . .', '. . . . . .', '. . . . . .', '. . . . . .', '. . . . . .'],
      { turn: 'red' },
    );
    const after = stateFrom(
      ['r0 . . . . .', '. . . . . .', '. . . . . .', '. . . . . .', '. . . . . .', '. . . . . .'],
      { turn: 'red' },
    );
    expect(evaluate(after, 'red')).toBeGreaterThan(evaluate(before, 'red'));
  });

  test('零和：国王贴脸对方将军是巨大利好（等级小 = 强，0 <= 1 吃得到）', () => {
    // 国王(0) 在 (0,0)，对方将军(1) 在 (0,1)
    const state = stateFrom(
      ['r0 b1 . . . .', '. . . . . .', '. . . . . .', '. . . . . .', '. . . . . .', '. . . . . .'],
      { turn: 'red' },
    );
    expect(evaluate(state, 'red')).toBeGreaterThan(0);
    expect(evaluate(state, 'blue')).toBeLessThan(0);
  });

  test('暗子按折扣计价，所以"翻出自己一个大子"是净收益', () => {
    const hidden = stateFrom(
      ['r0* . . . . .', '. . . . . .', '. . . . . .', '. . . . . .', '. . . . . .', '. . . . . .'],
      { turn: 'red' },
    );
    const shown = stateFrom(
      ['r0 . . . . .', '. . . . . .', '. . . . . .', '. . . . . .', '. . . . . .', '. . . . . .'],
      { turn: 'red' },
    );
    const diff = evaluate(shown, 'red') - evaluate(hidden, 'red');
    // 主体是 1000 * (1 - 0.55) = 450；另外翻开之后多出两个可走步（机动项很小）
    expect(diff).toBeGreaterThan(LEVEL_VALUE[0]! * 0.45);
    expect(diff).toBeLessThan(LEVEL_VALUE[0]! * 0.45 + 30);
  });

  test('逼近敌人比远离敌人好（击退"双方随机游走到和棋"）', () => {
    const far = stateFrom(
      ['r2 . . . . b3', '. . . . . .', '. . . . . .', '. . . . . .', '. . . . . .', '. . . . . .'],
      { turn: 'red' },
    );
    const near = stateFrom(
      ['r2 b3 . . . .', '. . . . . .', '. . . . . .', '. . . . . .', '. . . . . .', '. . . . . .'],
      { turn: 'red' },
    );
    expect(evaluate(near, 'red')).toBeGreaterThan(evaluate(far, 'red'));
  });

  test('对称开局：双方评估都是 0（没有偏袒任何一方）', () => {
    const view = viewFor(createState(11), 'red');
    const world = determinize(view, mulberry32(5));
    expect(evaluate(world, 'red')).toBeCloseTo(0);
    expect(evaluate(world, 'blue')).toBeCloseTo(0);
  });
});

describe('pimc：跨世界平均的搜索', () => {
  test('有便宜可占时必须吃（战术底线）', () => {
    // 红方骑士(2) 在 (2,2)，蓝方弓箭手(3) 在 (2,3)：2 <= 3，可以直接吃掉一个大子
    const state = stateFrom(
      [
        'r0 . . . . .',
        '. . . . . .',
        '. . r2 b3 . .',
        '. . . . . .',
        '. . . . . .',
        '. . . . . .',
      ],
      { turn: 'red' },
    );
    const view = viewFor(state, 'red');
    const best = pimcAction(view, { worlds: 8, depth: 2 }, mulberry32(1));
    expect(best).toEqual({ t: 'move', from: [2, 2], to: [2, 3] });
  });

  test('不吃亏：主动贴到能反吃自己的敌子旁边，会被评估为更差', () => {
    // 红方骑士(2) 在 (2,2)；蓝方将军(1) 在 (2,4)：1 <= 2，蓝方吃得到红骑士。
    // 红骑士走到 (2,3) = 送到嘴边；(1,2) = 安全。
    const state = stateFrom(
      [
        '. . . . . b0',
        '. . . . . .',
        '. . r2 . b1 .',
        '. . . . . .',
        '. . . . . .',
        '. . . . . r0',
      ],
      { turn: 'red' },
    );
    const view = viewFor(state, 'red');
    const res = pimc(view, { worlds: 8, depth: 2 }, mulberry32(3));
    const walkInto = actionIndex({ t: 'move', from: [2, 2], to: [2, 3] })!;
    const safe = actionIndex({ t: 'move', from: [2, 2], to: [1, 2] })!;
    expect(res.scores[walkInto]!).toBeLessThan(res.scores[safe]!);
  });

  test('循环惩罚：把盘面带回旧局面的动作被扣分，别的动作不受影响', () => {
    // 红骑士在 (2,2)，两个都是安全格 —— 只看分数差，不涉及战术
    const state = stateFrom(
      [
        '. . . . . b0',
        '. . . . . .',
        '. . r2 . . .',
        '. . . . . .',
        '. . . . . .',
        '. . . . . r0',
      ],
      { turn: 'red' },
    );
    const view = viewFor(state, 'red');
    const loop: Action = { t: 'move', from: [2, 2], to: [2, 3] };
    const other: Action = { t: 'move', from: [2, 2], to: [1, 2] };
    const after = applyAction(state, loop);
    if ('rejected' in after) throw new Error(after.rejected);

    const opts = { worlds: 4, depth: 2, repeatPenalty: 150, deepenWidth: 0 };
    const clean = pimc(view, opts, mulberry32(5));
    const looped = pimc({ ...view, recent: [...view.recent, publicKey(after.state)] }, opts, mulberry32(5));

    const iLoop = actionIndex(loop)!;
    const iOther = actionIndex(other)!;
    expect(looped.scores[iLoop]!).toBeCloseTo(clean.scores[iLoop]! - 150, 3);
    expect(looped.scores[iOther]!).toBeCloseTo(clean.scores[iOther]!, 3);

    // repeatPenalty = 0 就是关闭
    const off = pimc({ ...view, recent: [...view.recent, publicKey(after.state)] }, { ...opts, repeatPenalty: 0 }, mulberry32(5));
    expect(off.scores[iLoop]!).toBeCloseTo(clean.scores[iLoop]!, 3);
  });

  test('认输：只看"最好的动作"、要过 20 步、margin 非有限值则关闭', () => {
    const rows = [
      '. . . . b0 b1',
      '. . . . . .',
      '. . . . . .',
      '. . . . . .',
      '. . . . . .',
      'r5 . . . . .',
    ];
    const late = viewFor(stateFrom(rows, { turn: 'red', step: 30 }), 'red');
    const early = viewFor(stateFrom(rows, { turn: 'red', step: 5 }), 'red');
    expect(late.canResign).toBe(true);
    expect(early.canResign).toBe(false);

    // 明显输：最好的动作也远低于阈值
    expect(shouldResign(late, -2000, 1400)).toBe(true);
    // 只是稍差：不认
    expect(shouldResign(late, -300, 1400)).toBe(false);
    // 过了 20 步但分数是正的（我占优）：不认
    expect(shouldResign(late, 800, 1400)).toBe(false);
    // 关闭开关
    expect(shouldResign(late, -1e9, Number.POSITIVE_INFINITY)).toBe(false);
    // 还没到可以认输的步数
    expect(shouldResign(early, -1e9, 1400)).toBe(false);
  });

  test('必败局面：搜索直接给出认输', () => {
    const view = viewFor(
      stateFrom(
        [
          '. . . . b0 b1',
          '. . . . b2 b3',
          '. . . . . .',
          '. . . . . .',
          '. . . . . .',
          'r5 . . . . .',
        ],
        { turn: 'red', step: 24 },
      ),
      'red',
    );
    const res = pimc(view, { worlds: 4, depth: 3 }, mulberry32(9));
    expect(res.resign).toBe(true);
    expect(pimcAction(view, { worlds: 4, depth: 3 }, mulberry32(9))).toEqual({ t: 'resign' });
  });

  test('策略目标只覆盖合法动作、且归一化', () => {
    const view = viewFor(createState(21), 'red');
    const res = pimc(view, { worlds: 6, depth: 2 }, mulberry32(2));
    let sum = 0;
    const legal = new Set(legalActionIndices(view));
    for (let i = 0; i < res.policy.length; i++) {
      sum += res.policy[i]!;
      if (!legal.has(i)) expect(res.policy[i]).toBe(0);
    }
    expect(sum).toBeCloseTo(1, 5);
    expect(legal.has(res.best)).toBe(true);
  });

  test('开局（满盘暗子）也能给出合法着法，且必然是翻棋', () => {
    const view = viewFor(createState(31), 'red');
    const action = pimcAction(view, { worlds: 4, depth: 2 }, mulberry32(1));
    expect(action).not.toBeNull();
    expect(action!.t).toBe('flip');
  });

  test('可复现：同一随机源两次结果完全一致', () => {
    const view = viewFor(createState(41), 'red');
    const a = pimc(view, { worlds: 6, depth: 2 }, mulberry32(7));
    const b = pimc(view, { worlds: 6, depth: 2 }, mulberry32(7));
    expect(Array.from(a.scores)).toEqual(Array.from(b.scores));
    expect(a.best).toBe(b.best);
  });

  test('终局视角返回空结果，不抛异常', () => {
    const state = stateFrom(
      ['r0 . . . . .', '. . . . . .', '. . . . . .', '. . . . . .', '. . . . . .', '. . . . . .'],
      { winner: 'red', reason: 'wipe' },
    );
    const res = pimc(viewFor(state, 'red'), {}, mulberry32(1));
    expect(res.best).toBe(-1);
    expect(res.worlds).toBe(0);
  });

  test('每个合法着法的搜索值都有限（不能有 NaN / Infinity 泄进训练数据）', () => {
    const view = viewFor(createState(51), 'red');
    const res = pimc(view, { worlds: 8, nodeBudget: 1500 }, mulberry32(4));
    for (const i of legalActionIndices(view)) expect(Number.isFinite(res.scores[i]!)).toBe(true);
  });

  test('rootWidth 剪枝：每世界只搜前 N 个代表，被搜到的动作数不超过 N*K', () => {
    const view = viewFor(createState(61), 'red');
    const legal = legalActionIndices(view);
    expect(legal.length).toBeGreaterThan(20);
    const K = 2;
    const W = 6;
    // 关掉翻棋归类，才能直接数"到底搜了几个动作"
    const res = pimc(view, { worlds: K, depth: 1, rootWidth: W, flipClasses: false }, mulberry32(1));
    const scored = legal.filter((i) => Number.isFinite(res.scores[i]!));
    expect(scored.length).toBeGreaterThan(0);
    expect(scored.length).toBeLessThanOrEqual(K * W);
    expect(scored.length).toBeLessThan(legal.length);
    expect(Number.isFinite(res.scores[res.best]!)).toBe(true);
  });

  test('翻棋归类：同一类的格子分数完全相同，且所有翻棋都有分数（不会被当成坏棋）', () => {
    const view = viewFor(createState(63), 'red');
    const res = pimc(view, { worlds: 6, depth: 2 }, mulberry32(1));
    const flips = view.legal.flips.map((at) => actionIndex({ t: 'flip', at })!);
    expect(flips.length).toBe(36);
    // 开局 36 个翻棋全都有分数（归类把同类成员一起填上了）
    for (const i of flips) expect(Number.isFinite(res.scores[i]!)).toBe(true);
    // 同类成员分数必须一致（这正是"归类共享分数"的定义）
    for (const i of flips) {
      for (const j of flips) {
        if (i === j) continue;
        const sameClass = flipClassKey(view, i) === flipClassKey(view, j);
        if (sameClass) expect(res.scores[i]).toBeCloseTo(res.scores[j]!, 6);
      }
    }
  });

  test('节点预算真的在起作用（预算越小越省时，结果仍合法）', () => {
    const view = viewFor(createState(71), 'red');
    const t0 = Date.now();
    pimc(view, { worlds: 4, nodeBudget: 200 }, mulberry32(1));
    const cheap = Date.now() - t0;
    const action = pimcAction(view, { worlds: 4, nodeBudget: 200 }, mulberry32(1));
    expect(action).not.toBeNull();
    expect(cheap).toBeLessThan(5000);
  });
});

describe('PIMC 的整体强度', () => {
  test('对随机走子：不输，且绝大多数能吃掉对方', () => {
    const N = 10;
    let wins = 0;
    let losses = 0;
    for (let g = 0; g < N; g++) {
      let state = createState(900 + g * 17);
      const rand = mulberry32(300 + g);
      const me = g % 2 === 0 ? 'red' : 'blue';
      let guard = 0;
      while (!state.winner && guard++ < 3000) {
        const view = viewFor(state, state.turn);
        let action;
        if (state.turn === me) {
          action = pimcAction(view, { worlds: 4, depth: 2 }, rand);
        } else {
          const legal = legalActionIndices(view);
          action = actionFromIndex(legal[Math.floor(rand() * legal.length)]!);
        }
        if (!action) throw new Error('没有给出着法');
        const res = applyAction(state, action);
        if ('rejected' in res) throw new Error(`非法着法：${res.rejected}`);
        state = res.state;
      }
      if (state.winner === me) wins += 1;
      else if (state.winner !== 'draw') losses += 1;
    }
    expect(losses).toBe(0);
    expect(wins).toBeGreaterThanOrEqual(Math.ceil(N * 0.8));
  }, 180000);
});
