// 对局记录 —— 把"人机对战"的每一盘存档，方便事后复盘 AI 的坏棋。
//
// 为什么只存 {种子, 动作序列} 就够了：
//   整盘棋是**确定性**的 —— createState(seed) 给出初始棋盘，之后每一步只由动作决定。
//   所以「种子 + 动作序列」可以完整重放，包括每一步的真相（暗子是谁）。
//   存真相反而更占地方，而且会在重放时和规则脱节。
//
// 存储用 localStorage；所有访问都包了 try/catch —— 隐私模式/存储被禁用时静默退化成"不记录"，
// 绝不能因为存档坏了把整局棋搞挂。

import type { Action, Reason, Side } from '../core/types';
import type { Mode } from './hudText';

export const LOG_KEY = 'battlechess.log.v1';

/** 最多留多少盘。一盘约 120 步、每步 ~8 字节 → 100 盘也就几十 KB */
export const LOG_CAP = 100;

export interface GameRecord {
  /** 结束时间戳，同时当唯一 id（列表里排序、标记都用它） */
  ts: number;
  seed: number;
  mode: Mode;
  /** AI 档位；这里用 string，免得 gameLog ↔ useAi 互相 import */
  ai: string;
  you: Side | null;
  winner: Side | 'draw';
  reason: Reason;
  steps: number;
  /** 紧凑动作序列，见 encodeAction */
  actions: string[];
  /** 人自己标的"这局有坏棋" */
  flagged?: boolean;
}

/** f0,1 = 翻 (0,1)；m0,1,0,2 = 从 (0,1) 走到 (0,2)；r = 认输 */
export function encodeAction(action: Action): string {
  if (action.t === 'flip') return `f${action.at[0]},${action.at[1]}`;
  if (action.t === 'resign') return 'r';
  return `m${action.from[0]},${action.from[1]},${action.to[0]},${action.to[1]}`;
}

export function decodeAction(text: string): Action | null {
  if (text === 'r') return { t: 'resign' };
  const nums = text.slice(1).split(',').map(Number);
  if (nums.some((n) => !Number.isInteger(n) || n < 0 || n > 5)) return null;
  if (text[0] === 'f' && nums.length === 2) return { t: 'flip', at: [nums[0]!, nums[1]!] };
  if (text[0] === 'm' && nums.length === 4) {
    return { t: 'move', from: [nums[0]!, nums[1]!], to: [nums[2]!, nums[3]!] };
  }
  return null;
}

export const encodeActions = (list: Action[]): string[] => list.map(encodeAction);

export function decodeActions(list: string[]): Action[] {
  const out: Action[] = [];
  for (const text of list) {
    const action = decodeAction(text);
    if (!action) return [];
    out.push(action);
  }
  return out;
}

function read(): GameRecord[] {
  try {
    const raw = window.localStorage.getItem(LOG_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((r): r is GameRecord => {
      const rec = r as Partial<GameRecord> | null;
      return !!rec && typeof rec.ts === 'number' && typeof rec.seed === 'number' && Array.isArray(rec.actions);
    });
  } catch {
    return [];
  }
}

function write(records: GameRecord[]): GameRecord[] {
  try {
    window.localStorage.setItem(LOG_KEY, JSON.stringify(records.slice(0, LOG_CAP)));
  } catch {
    // 存不进去就当没记录，不影响下棋
  }
  return records.slice(0, LOG_CAP);
}

/** 最新的在前 */
export function loadRecords(): GameRecord[] {
  return read().sort((a, b) => b.ts - a.ts);
}

export function appendRecord(record: GameRecord): GameRecord[] {
  return write([record, ...read()]);
}

export function clearRecords(): GameRecord[] {
  try {
    window.localStorage.removeItem(LOG_KEY);
  } catch {
    // 同上
  }
  return [];
}

export function setFlagged(ts: number, flagged: boolean): GameRecord[] {
  return write(read().map((r) => (r.ts === ts ? { ...r, flagged } : r)));
}

export function toJson(records: GameRecord[]): string {
  return JSON.stringify({ kind: 'battlechess-log', version: 1, games: records }, null, 2);
}

/** 导出成一个 .json 文件（交给 AI 复盘用） */
export function downloadRecords(records: GameRecord[]): void {
  const blob = new Blob([toJson(records)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `battlechess-games-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(url);
}
