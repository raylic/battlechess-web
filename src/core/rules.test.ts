import { describe, expect, test } from 'vitest';

import { createGrid } from './board';
import {
  BOARD_SIZE,
  canEat,
  compareLevels,
  LEVEL_COUNT_PER_SIDE,
  PIECES_PER_SIDE,
} from './pieces';
import { applyAction, createState } from './reduce';
import { legalActions, movesFrom } from './rules';
import { stateFrom } from './test-helpers';

describe('克制关系', () => {
  test('全枚举 36 种组合，与规则一致', () => {
    for (let a = 0; a <= 5; a++) {
      for (let b = 0; b <= 5; b++) {
        const expected = a === 0 && b === 5 ? false : a === 5 && b === 0 ? true : a <= b;
        expect(canEat(a, b), `canEat(${a}, ${b})`).toBe(expected);
      }
    }
  });

  test('刺客吃国王，国王吃不了刺客（非对称）', () => {
    expect(canEat(5, 0)).toBe(true);
    expect(canEat(0, 5)).toBe(false);
    expect(compareLevels(5, 0)).toBe(1);
    expect(compareLevels(0, 5)).toBe(-1);
  });

  test('同级可互吃 → 残局判平', () => {
    expect(canEat(2, 2)).toBe(true);
    expect(compareLevels(2, 2)).toBe(0);
  });
});

describe('棋盘生成', () => {
  test('36 格全部摆满，每方 18 子、各等级数量对称', () => {
    for (const seed of [1, 42, 12345, 99999]) {
      const grid = createGrid(seed);
      let n = 0;
      const tally: Record<string, Record<number, number>> = { red: {}, blue: {} };
      for (let r = 0; r < BOARD_SIZE; r++) {
        for (let c = 0; c < BOARD_SIZE; c++) {
          const p = grid[r]![c];
          expect(p, `seed=${seed} 第 ${r},${c} 格是空的`).not.toBeNull();
          expect(p!.revealed).toBe(false);
          n++;
          tally[p!.side]![p!.level] = (tally[p!.side]![p!.level] ?? 0) + 1;
        }
      }
      expect(n).toBe(36);
      for (const side of ['red', 'blue']) {
        for (let level = 0; level < LEVEL_COUNT_PER_SIDE.length; level++) {
          expect(tally[side]![level], `${side} 等级 ${level} 数量`).toBe(LEVEL_COUNT_PER_SIDE[level]);
        }
      }
      expect(PIECES_PER_SIDE).toBe(18);
    }
  });

  test('同一 seed 完全一致，不同 seed 不同（种子可复现）', () => {
    expect(JSON.stringify(createGrid(2024))).toBe(JSON.stringify(createGrid(2024)));
    expect(JSON.stringify(createGrid(2024))).not.toBe(JSON.stringify(createGrid(2025)));
  });

  test('棋子 id 不携带身份信息', () => {
    const firsts = new Set<string>();
    for (let seed = 0; seed < 60; seed++) {
      const grid = createGrid(seed);
      const p0 = grid[0]![0]!;
      expect(p0.id).toBe('p0');
      firsts.add(`${p0.side}${p0.level}`);
    }
    expect(firsts.size, `p0 的身份分布过窄：${[...firsts].join(',')}`).toBeGreaterThanOrEqual(4);
  });
});

describe('走子', () => {
  test('只能上下左右一格，不能走对角线', () => {
    const corner = stateFrom([
      'r0 . . . . .',
      '. . . . . .',
      '. . . . . .',
      '. . . . . .',
      '. . . . . .',
      '. . . . . .',
    ]);
    expect(movesFrom(corner, 0, 0).sort()).toEqual([
      [0, 1],
      [1, 0],
    ]);
    const center = stateFrom([
      '. . . . . .',
      '. . . . . .',
      '. . r0 . . .',
      '. . . . . .',
      '. . . . . .',
      '. . . . . .',
    ]);
    expect(movesFrom(center, 2, 2).sort()).toEqual([
      [1, 2],
      [2, 1],
      [2, 3],
      [3, 2],
    ]);
  });

  test('不能吃未翻开的子、不能吃自己的子', () => {
    const hidden = stateFrom([
      'r0 b3* . . . .',
      '. . . . . .',
      '. . . . . .',
      '. . . . . .',
      '. . . . . .',
      '. . . . . .',
    ]);
    expect(
      movesFrom(hidden, 0, 0).some(([r, c]) => r === 0 && c === 1),
      '未翻开的子不能吃',
    ).toBe(false);
    expect(movesFrom(hidden, 0, 0)).toEqual([[1, 0]]); // 但空格还是能走

    const own = stateFrom([
      'r0 r3 . . . .',
      '. . . . . .',
      '. . . . . .',
      '. . . . . .',
      '. . . . . .',
      '. . . . . .',
    ]);
    expect(movesFrom(own, 0, 0).some(([r, c]) => r === 0 && c === 1)).toBe(false);
  });

  test('只能吃等级不高于自己的敌子（含刺客例外）', () => {
    const canTarget = (state: ReturnType<typeof stateFrom>, r: number, c: number) =>
      movesFrom(state, 0, 0).some(([rr, cc]) => rr === r && cc === c);

    const eatKing = stateFrom([
      'r5 b0 . . . .',
      '. . . . . .',
      '. . . . . .',
      '. . . . . .',
      '. . . . . .',
      '. . . . . .',
    ]);
    expect(canTarget(eatKing, 0, 1), '刺客应能吃国王').toBe(true);

    const kingVsAssassin = stateFrom([
      'r0 b5 . . . .',
      '. . . . . .',
      '. . . . . .',
      '. . . . . .',
      '. . . . . .',
      '. . . . . .',
    ]);
    expect(canTarget(kingVsAssassin, 0, 1), '国王不能吃刺客').toBe(false);

    const weakVsStrong = stateFrom([
      'r3 b2 . . . .',
      '. . . . . .',
      '. . . . . .',
      '. . . . . .',
      '. . . . . .',
      '. . . . . .',
    ]);
    expect(canTarget(weakVsStrong, 0, 1), '弓箭手不能吃骑士').toBe(false);

    const equal = stateFrom([
      'r3 b3 . . . .',
      '. . . . . .',
      '. . . . . .',
      '. . . . . .',
      '. . . . . .',
      '. . . . . .',
    ]);
    expect(canTarget(equal, 0, 1), '同级可吃').toBe(true);
  });

  test('落子后原格清空、计数变化，空走会增加无吃子计数', () => {
    const state = stateFrom([
      'r0 . . . . .',
      'b3 . . . . .',
      '. . . . . .',
      '. . . . . .',
      '. . . . . .',
      '. . . . . .',
    ]);
    const move = applyAction(state, { t: 'move', from: [0, 0], to: [0, 1] });
    expect(move).toHaveProperty('state');
    if ('rejected' in move) throw new Error(move.rejected);
    expect(move.state.grid[0]![1]!.level).toBe(0);
    expect(move.state.grid[0]![0]).toBeNull();
    expect(move.state.noEat).toBe(1);
    expect(move.state.counts.blue).toBe(1);

    const eat = applyAction(state, { t: 'move', from: [0, 0], to: [1, 0] });
    if ('rejected' in eat) throw new Error(eat.rejected);
    expect(eat.state.counts.blue).toBe(0);
    expect(eat.state.noEat).toBe(0);
    expect(eat.events[1]!.kind).toBe('eat');
    expect(eat.state.winner).toBe('red');
  });

  test('朝向：按最后一步的水平方向翻转（原版 Chess.dire）', () => {
    // 场上留三个子，避免走一步就撞上残局/吃光的结束判定
    const state = stateFrom([
      'r0 . . . . .',
      '. . . . . .',
      '. . . . . .',
      '. . . . . .',
      '. . . . . .',
      'r3 . . . . b5',
    ]);
    expect(state.grid[0]![0]!.dire).toBe(0);

    // 红方向右走 → 镜像
    const right = applyAction(state, { t: 'move', from: [0, 0], to: [0, 1] });
    if ('rejected' in right) throw new Error(right.rejected);
    expect(right.state.grid[0]![1]!.dire, '向右走 → 镜像').toBe(1);

    // 蓝方随便走一步（换手是自动的，不能让红方连着走）
    const blueMove = applyAction(right.state, { t: 'move', from: [5, 5], to: [5, 4] });
    if ('rejected' in blueMove) throw new Error(blueMove.rejected);

    // 红方往左走 → 回原图
    const back = applyAction(blueMove.state, { t: 'move', from: [0, 1], to: [0, 0] });
    if ('rejected' in back) throw new Error(back.rejected);
    expect(back.state.grid[0]![0]!.dire, '向左走 → 回原图').toBe(0);

    // 垂直移动不改朝向
    const blueMove2 = applyAction(back.state, { t: 'move', from: [5, 4], to: [5, 5] });
    if ('rejected' in blueMove2) throw new Error(blueMove2.rejected);
    const down = applyAction(blueMove2.state, { t: 'move', from: [0, 0], to: [1, 0] });
    if ('rejected' in down) throw new Error(down.rejected);
    expect(down.state.grid[1]![0]!.dire).toBe(0);
  });
});

describe('翻棋', () => {
  test('任意未翻开的格子都能翻，包括对方的；翻棋算一步并清零计数', () => {
    const state = createState(7);
    const acts = legalActions(state);
    expect(acts.flips.length).toBe(36);
    expect(acts.moves.length).toBe(0);

    const res = applyAction(state, { t: 'flip', at: [3, 4] });
    if ('rejected' in res) throw new Error(res.rejected);
    expect(res.state.grid[3]![4]!.revealed).toBe(true);
    expect(res.state.step).toBe(1);
    expect(res.state.turn).toBe('blue');
    expect(res.state.noEat).toBe(0);
    expect(res.state.lastStep).toEqual([3, 4]);
    expect(res.events[0]!.kind).toBe('flip');
  });

  test('已翻开的格子不能再翻；非法 action 被拒', () => {
    const state = stateFrom([
      'r0 . . . . .',
      '. . . . . .',
      '. . . . . .',
      '. . . . . .',
      '. . . . . .',
      '. . . . . .',
    ]);
    expect(applyAction(state, { t: 'flip', at: [0, 0] })).toHaveProperty('rejected');
    expect(applyAction(state, { t: 'move', from: [0, 0], to: [5, 5] })).toHaveProperty('rejected');
    expect(applyAction(state, { t: 'nonsense' })).toHaveProperty('rejected');
  });

  test('合法着法只属于当前回合方', () => {
    const state = stateFrom([
      'r0 . . . . .',
      'b3 . . . . .',
      '. . . . . .',
      '. . . . . .',
      '. . . . . .',
      'r1* . . . . .',
    ]);
    const acts = legalActions(state);
    expect(acts.moves.every((m) => state.grid[m.from[0]]![m.from[1]]!.side === state.turn)).toBe(true);

    const flipped = applyAction(state, { t: 'flip', at: [5, 0] });
    if ('rejected' in flipped) throw new Error(flipped.rejected);
    expect(flipped.state.turn).toBe('blue');

    const acts2 = legalActions(flipped.state);
    expect(acts2.moves.length).toBeGreaterThan(0);
    expect(
      acts2.moves.every((m) => m.from[0] === 1 && m.from[1] === 0),
      '换手后只剩蓝方那个已翻开的子可动',
    ).toBe(true);
  });

  test('每个未翻开的格子都能被翻开，翻棋总和 36 次', () => {
    let state = createState(555);
    let flips = 0;
    while (flips < 36) {
      const acts = legalActions(state);
      if (!acts.flips.length) break;
      const res = applyAction(state, { t: 'flip', at: acts.flips[0]! });
      if ('rejected' in res) throw new Error(res.rejected);
      state = res.state;
      flips++;
    }
    expect(flips).toBe(36);
    expect(legalActions(state).flips.length).toBe(0);
  });
});
