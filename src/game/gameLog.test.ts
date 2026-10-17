// @vitest-environment jsdom
// 对局记录：只存「种子 + 动作序列」，必须能完整重放回同一盘棋。
import { beforeEach, expect, test } from 'vitest';

import { applyAction, createState, publicKey } from '../core/reduce';
import type { Action } from '../core/types';
import { viewFor } from '../core/visibility';
import {
  appendRecord,
  clearRecords,
  decodeAction,
  decodeActions,
  encodeAction,
  encodeActions,
  loadRecords,
  LOG_CAP,
  LOG_KEY,
  setFlagged,
  toJson,
  type GameRecord,
} from './gameLog';

const acts: Action[] = [
  { t: 'flip', at: [0, 3] },
  { t: 'move', from: [1, 1], to: [2, 1] },
  { t: 'resign' },
];

beforeEach(() => {
  window.localStorage.clear();
});

test('动作编码能原样还原', () => {
  for (const a of acts) expect(decodeAction(encodeAction(a))).toEqual(a);
  expect(decodeActions(encodeActions(acts))).toEqual(acts);
});

test('畸形编码解码成 null（不抛异常）', () => {
  for (const bad of ['', 'q1,2', 'f1', 'f9,0', 'm0,0,0', 'm0,0,0,9', 'f1,2,3']) {
    expect(decodeAction(bad)).toBeNull();
  }
  // 只要有一条坏的，整串就当不可用 —— 免得重放出半盘棋
  expect(decodeActions(['f0,0', '坏'])).toEqual([]);
});

function record(ts: number): GameRecord {
  return { ts, seed: 123, mode: 'ai', ai: 'search', you: 'red', winner: 'red', reason: 'wipe', steps: 10, actions: [] };
}

test('写入/读取/上限/标记/清空', () => {
  expect(loadRecords()).toEqual([]);
  for (let i = 0; i < LOG_CAP + 5; i++) appendRecord(record(i));
  const all = loadRecords();
  expect(all).toHaveLength(LOG_CAP);
  // 最新的在前
  expect(all[0]!.ts).toBe(LOG_CAP + 4);

  setFlagged(LOG_CAP + 4, true);
  expect(loadRecords().find((r) => r.ts === LOG_CAP + 4)?.flagged).toBe(true);

  expect(JSON.parse(toJson(all)).games).toHaveLength(LOG_CAP);
  expect(clearRecords()).toEqual([]);
  expect(window.localStorage.getItem(LOG_KEY)).toBeNull();
});

test('存储坏掉时静默退化成"不记录"，不抛异常', () => {
  window.localStorage.setItem(LOG_KEY, '{不是 json');
  expect(loadRecords()).toEqual([]);
  // 仍然能写入（覆盖掉坏数据）
  expect(appendRecord(record(1))).toHaveLength(1);
});

test('「种子 + 动作序列」能重放回同一盘棋', () => {
  const seed = 4242;
  let state = createState(seed);
  const played: Action[] = [];
  // 固定走 12 步（每步都从当前视角里挑第一个合法动作，谁走都行 —— 这里只验证重放一致）
  for (let i = 0; i < 12 && !state.winner; i++) {
    const view = viewFor(state, state.turn);
    const legal: Action[] = [];
    for (const at of view.legal.flips) legal.push({ t: 'flip', at });
    for (const m of view.legal.moves) legal.push({ t: 'move', from: m.from, to: m.to });
    const action = legal[i % legal.length]!;
    const res = applyAction(state, action);
    if ('rejected' in res) throw new Error(res.rejected);
    state = res.state;
    played.push(action);
  }

  let replay = createState(seed);
  for (const action of decodeActions(encodeActions(played))) {
    const res = applyAction(replay, action);
    if ('rejected' in res) throw new Error(res.rejected);
    replay = res.state;
  }
  expect(replay.step).toBe(state.step);
  expect(publicKey(replay)).toBe(publicKey(state));
  expect(replay.history).toEqual(state.history);
});
