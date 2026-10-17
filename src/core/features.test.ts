import { describe, expect, test } from 'vitest';

import {
  ACTION_COUNT,
  CELLS,
  CH,
  FEATURE_CHANNELS,
  FEATURE_COUNT,
  GLOBAL_COUNT,
  MOVE_ACTION_BASE,
  actionFromIndex,
  actionIndex,
  actionMask,
  cellIndex,
  dirIndex,
  encode,
  hiddenPool,
  maskedSoftmax,
} from './features';
import { createState } from './reduce';
import { DIRS } from './rules';
import { stateFrom } from './test-helpers';
import { viewFor } from './visibility';

describe('动作空间', () => {
  test('180 个动作下标全部可编码/解码，且往返一致', () => {
    expect(ACTION_COUNT).toBe(180);
    for (let i = 0; i < ACTION_COUNT; i++) {
      const action = actionFromIndex(i);
      expect(action).not.toBeNull();
      expect(actionIndex(action!)).toBe(i);
    }
  });

  test('方向序号与 rules.ts 的 DIRS 严格同序', () => {
    expect(DIRS.map(([dr, dc]) => dirIndex(dr, dc))).toEqual([0, 1, 2, 3]);
    DIRS.forEach(([dr, dc], d) => {
      const i = MOVE_ACTION_BASE + cellIndex(2, 3) * DIRS.length + d;
      const a = actionFromIndex(i)!;
      expect(a).toMatchObject({ t: 'move', from: [2, 3], to: [2 + dr, 3 + dc] });
    });
  });

  test('越界下标返回 null 而不是抛异常', () => {
    for (const bad of [-1, 180, 1.5, NaN]) expect(actionFromIndex(bad)).toBeNull();
  });

  test('认输不在动作空间里', () => {
    expect(actionIndex({ t: 'resign' })).toBeNull();
  });
});

describe('特征编码', () => {
  test('形状固定：612 特征 + 6 全局 + 180 掩码', () => {
    expect(FEATURE_COUNT).toBe(6 * 6 * FEATURE_CHANNELS);
    const e = encode(viewFor(createState(7), 'red'));
    expect(e.features.length).toBe(FEATURE_COUNT);
    expect(e.globals.length).toBe(GLOBAL_COUNT);
    expect(e.mask.length).toBe(ACTION_COUNT);
  });

  test('开局：36 格全是暗子，只有翻棋合法', () => {
    const view = viewFor(createState(1), 'red');
    const e = encode(view);
    const hiddenCount = e.features.slice(CH.HIDDEN * CELLS, (CH.HIDDEN + 1) * CELLS).reduce((a, b) => a + b, 0);
    expect(hiddenCount).toBe(36);
    expect(e.mask.reduce((a, b) => a + b, 0)).toBe(36);
    // 全部落点都只有翻棋
    for (let i = MOVE_ACTION_BASE; i < ACTION_COUNT; i++) expect(e.mask[i]).toBe(0);
    expect(e.globals[2]).toBeCloseTo(1); // 自己 18/18
    expect(e.globals[4]).toBeCloseTo(1); // 暗子还有 18/18（全部没翻开）
    expect(e.globals[5]).toBeCloseTo(1); // 对方同样
    // 各等级暗子占比全是 1
    for (let i = 6; i < GLOBAL_COUNT; i++) expect(e.globals[i]).toBeCloseTo(1);
  });

  test('敌我通道按 you 区分（同一局面换个视角就换个通道）', () => {
    const state = stateFrom([
      'r0 b1 . . . .',
      '. . . . . .',
      '. . . . . .',
      '. . . . . .',
      '. . . . . .',
      '. . . . . .',
    ]);
    const red = encode(viewFor(state, 'red')).features;
    const blue = encode(viewFor(state, 'blue')).features;
    const cell = cellIndex(0, 0); // 红方国王
    expect(red[(CH.MY_LEVEL0 + 0) * CELLS + cell]).toBe(1);
    expect(blue[(CH.ENEMY_LEVEL0 + 0) * CELLS + cell]).toBe(1);
    const other = cellIndex(0, 1); // 蓝方将军
    expect(red[(CH.ENEMY_LEVEL0 + 1) * CELLS + other]).toBe(1);
    expect(blue[(CH.MY_LEVEL0 + 1) * CELLS + other]).toBe(1);
  });

  test('可落点/来源/上一步都被标记', () => {
    const state = stateFrom(
      [
        'r0 . . . . .',
        '. . . . . .',
        '. . . . . .',
        '. . . . . .',
        '. . . . . .',
        '. . . . . .',
      ],
      { turn: 'red', lastStep: [0, 0] },
    );
    const e = encode(viewFor(state, 'red'));
    expect(e.features[CH.MOVE_SOURCE * CELLS + cellIndex(0, 0)]).toBe(1);
    expect(e.features[CH.MOVE_TARGET * CELLS + cellIndex(0, 1)]).toBe(1);
    expect(e.features[CH.MOVE_TARGET * CELLS + cellIndex(1, 0)]).toBe(1);
    expect(e.features[CH.LAST_STEP * CELLS + cellIndex(0, 0)]).toBe(1);
  });

  test('掩码与 view.legal 完全一致', () => {
    const state = stateFrom(
      [
        'r0* b1* . . . .',
        '. . . . . .',
        '. . . . . .',
        '. . . . . .',
        '. . . . . .',
        'b5 . . . . .',
      ],
      { turn: 'red' },
    );
    const view = viewFor(state, 'red');
    const mask = actionMask(view);
    for (const at of view.legal.flips) expect(mask[actionIndex({ t: 'flip', at })!]).toBe(1);
    for (const m of view.legal.moves) expect(mask[actionIndex({ t: 'move', ...m })!]).toBe(1);
  });

  test('各等级暗子构成是精确值：已翻开的、已被吃的都要扣掉', () => {
    // 手摆局面里，"没出现在棋盘上"的棋子一律算作已被吃掉（fallen = 开局量 - 场上存活量），
    // 这正是真实对局里的公开信息口径。
    const state = stateFrom(
      [
        'r0 b3 . . . .',
        'r1* b1* . . . .',
        '. . . . . .',
        '. . . . . .',
        '. . . . . .',
        '. . . . . .',
      ],
      { turn: 'red' },
    );
    const pool = hiddenPool(viewFor(state, 'red'));
    // 红方：国王已翻开（剩暗子 0）；将军在暗格里 r1*（剩暗子 1）；其余等级全被吃
    expect(pool.red).toEqual([0, 1, 0, 0, 0, 0]);
    // 蓝方：国王不在场上（被吃）；将军在暗格里；弓箭手 b3 已翻开
    expect(pool.blue).toEqual([0, 1, 0, 0, 0, 0]);
  });

  test('空格不计入任何棋子通道', () => {
    const state = stateFrom([
      '. . . . . .',
      '. . . . . .',
      '. . . . . .',
      '. . . . . .',
      '. . . . . .',
      '. . . . . .',
    ]);
    const e = encode(viewFor(state, 'red'));
    const empty = e.features.slice(CH.EMPTY * CELLS, (CH.EMPTY + 1) * CELLS).reduce((a, b) => a + b, 0);
    expect(empty).toBe(36);
    expect(e.mask.reduce((a, b) => a + b, 0)).toBe(0);
  });
});

describe('掩码 softmax', () => {
  test('非法动作恒为 0，合法动作加起来是 1', () => {
    const logits = new Float32Array(ACTION_COUNT).fill(1);
    const mask = new Uint8Array(ACTION_COUNT);
    mask[3] = 1;
    mask[7] = 1;
    const p = maskedSoftmax(logits, mask, 1);
    expect(p[3]).toBeCloseTo(0.5);
    expect(p[7]).toBeCloseTo(0.5);
    expect(p[4]).toBe(0);
    expect(p.reduce((a, b) => a + b, 0)).toBeCloseTo(1);
  });

  test('温度越低越尖锐', () => {
    const logits = new Float32Array(ACTION_COUNT).fill(0);
    logits[0] = 2;
    logits[1] = 0;
    const mask = new Uint8Array(ACTION_COUNT);
    mask[0] = 1;
    mask[1] = 1;
    const cold = maskedSoftmax(logits, mask, 0.5);
    const warm = maskedSoftmax(logits, mask, 4);
    expect(cold[0]).toBeGreaterThan(warm[0]!);
    expect(cold[0]! + cold[1]!).toBeCloseTo(1);
  });

  test('全是 -Infinity 时返回全 0 而不是 NaN', () => {
    const logits = new Float32Array(ACTION_COUNT).fill(-Infinity);
    const mask = new Uint8Array(ACTION_COUNT);
    mask[0] = 1;
    const p = maskedSoftmax(logits, mask, 1);
    expect(Array.from(p).every((v) => v === 0)).toBe(true);
  });
});
