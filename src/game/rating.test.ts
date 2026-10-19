// @vitest-environment jsdom
// 积分与等级：阈值、星级、结算、坏存档，全部是纯函数，好测。
import { beforeEach, expect, test } from 'vitest';

import {
  applyOutcome,
  GRADE_GATES,
  GRADE_NAMES,
  gradeFor,
  loadPoints,
  outcomeFor,
  pointsDelta,
  settlePoints,
  RATING_KEY,
  savePoints,
} from './rating';

beforeEach(() => {
  window.localStorage.clear();
});

test('六个等级：刺客 → 国王，星级 1..6', () => {
  expect(GRADE_NAMES).toEqual(['刺客', '禁卫军', '弓箭手', '骑士', '将军', '国王']);
  GRADE_GATES.forEach((gate, i) => {
    const g = gradeFor(gate);
    expect(g.index).toBe(i);
    expect(g.name).toBe(GRADE_NAMES[i]);
    expect(g.star).toBe(i + 1);
    expect(g.gate).toBe(gate);
  });
});

test('阈值边界：差一分不掉级也没升', () => {
  expect(gradeFor(99).name).toBe('刺客');
  expect(gradeFor(100).name).toBe('禁卫军');
  expect(gradeFor(249).name).toBe('禁卫军');
  expect(gradeFor(250).name).toBe('弓箭手');
  expect(gradeFor(999).name).toBe('将军');
  expect(gradeFor(1000).name).toBe('国王');
  // 再往上没有新等级，但也不会崩
  expect(gradeFor(99999).name).toBe('国王');
});

test('进度：0..1，国王恒为 1，且没有下一级', () => {
  expect(gradeFor(0).progress).toBe(0);
  expect(gradeFor(50).progress).toBeCloseTo(0.5); // 0→100 的中点
  expect(gradeFor(100).progress).toBe(0); // 刚进禁卫军
  expect(gradeFor(175).progress).toBeCloseTo(0.5); // 100→250 的中点
  expect(gradeFor(1000).next).toBeNull();
  expect(gradeFor(1000).progress).toBe(1);
  expect(gradeFor(0).next).toEqual({ name: '禁卫军', gate: 100 });
});

test('负分和脏数据都按 0 处理', () => {
  expect(gradeFor(-100).index).toBe(0);
  expect(gradeFor(NaN).index).toBe(0);
  expect(gradeFor(Infinity).index).toBe(0);
  // 小数取整，避免浮点尾巴在阈值上抖动
  expect(gradeFor(99.9).name).toBe('刺客');
  expect(gradeFor(100.0).name).toBe('禁卫军');
});

test('结算：胜 +20、负 −20、和 0，下限 0', () => {
  expect(applyOutcome(0, 'win')).toBe(20);
  expect(applyOutcome(120, 'win')).toBe(140);
  expect(applyOutcome(120, 'loss')).toBe(100);
  expect(applyOutcome(10, 'loss')).toBe(0); // 不出现负分
  expect(applyOutcome(0, 'loss')).toBe(0);
  expect(applyOutcome(120, 'draw')).toBe(120);
  expect(pointsDelta('win')).toBe(20);
  expect(pointsDelta('loss')).toBe(-20);
  expect(pointsDelta('draw')).toBe(0);
});

test('掉分会掉级：从骑士输回弓箭手', () => {
  const before = gradeFor(455);
  expect(before.name).toBe('骑士');
  const after = gradeFor(applyOutcome(455, 'loss'));
  expect(after.name).toBe('弓箭手');
  expect(after.star).toBe(3);
});

test('谁赢了 → 我的结果（认输是对手赢，我算负）', () => {
  expect(outcomeFor('red', 'red')).toBe('win');
  expect(outcomeFor('blue', 'red')).toBe('loss');
  expect(outcomeFor('draw', 'red')).toBe('draw');
  expect(outcomeFor(null, 'red')).toBeNull();
});

test('结算入口：只给该记的局算分', () => {
  // 人机/联机（record=true）+ 已结束 + 知道自己是谁 → 算
  expect(settlePoints(100, { over: true, winner: 'red', me: 'red', record: true })).toBe(120);
  expect(settlePoints(100, { over: true, winner: 'blue', me: 'red', record: true })).toBe(80);
  expect(settlePoints(0, { over: true, winner: 'blue', me: 'red', record: true })).toBe(0);

  // 热座/双窗口：一台机器两个人，不记
  expect(settlePoints(100, { over: true, winner: 'red', me: 'red', record: false })).toBeNull();
  // 还没结束
  expect(settlePoints(100, { over: false, winner: null, me: 'red', record: true })).toBeNull();
  // 不知道自己哪一色（热座视角）
  expect(settlePoints(100, { over: true, winner: 'red', me: null, record: true })).toBeNull();
});

test('存档：写读一致、坏数据不抛、负数夹到 0', () => {
  expect(loadPoints()).toBe(0); // 空存档
  expect(savePoints(120)).toBe(120);
  expect(loadPoints()).toBe(120);
  expect(savePoints(-5)).toBe(0);
  expect(loadPoints()).toBe(0);

  window.localStorage.setItem(RATING_KEY, '{ 这不是 json');
  expect(loadPoints()).toBe(0);

  window.localStorage.setItem(RATING_KEY, JSON.stringify({ points: 'abc' }));
  expect(loadPoints()).toBe(0);

  // 也认直接存数字的老格式
  window.localStorage.setItem(RATING_KEY, '340');
  expect(loadPoints()).toBe(340);
});
