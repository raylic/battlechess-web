// 积分与等级。
//
// 规则（和设计稿一一对应）：
//   · 六个等级就是棋子的六个等级，从弱到强：刺客 → 禁卫军 → 弓箭手 → 骑士 → 将军 → 国王
//   · 初始 0 分；胜 +20、负 −20（认输也算负）、和 0
//   · 分数不会低于 0（连输也不会变成负分）
//   · 等级 = 当前分数的实时映射 —— 掉分就会掉级，等级和积分永远是同一本账
//   · 星级 = 等级序号：刺客 1★ … 国王 6★（电脑不显示星）
//
// 分数只存本地（localStorage），一人一份；联机时双方各自记自己的。
// 没有服务器校验，想改随便改 —— 这个游戏不靠积分分级，它只是个进度感。

import type { Side } from '../core/types';

/** 等级名，弱 → 强。顺序必须和 `LEVEL_NAMES`（core/pieces.ts）相反，这里是"成长顺序" */
export const GRADE_NAMES = ['刺客', '禁卫军', '弓箭手', '骑士', '将军', '国王'] as const;
export type GradeName = (typeof GRADE_NAMES)[number];

/** 每个等级的起始分（第一个是 0，所以永远够得着最低级） */
export const GRADE_GATES: readonly number[] = [0, 100, 250, 450, 700, 1000];

/** 胜 / 负 的分数变化；和棋不动 */
export const WIN_POINTS = 20;
export const LOSS_POINTS = 20;

/** 一局的结果（AI 或对手的胜负，从"我"的视角） */
export type Outcome = 'win' | 'loss' | 'draw';

export interface Grade {
  /** 等级序号 0..5（0 = 刺客） */
  index: number;
  /** 等级名 */
  name: GradeName;
  /** 星级 = index + 1（刺客 1★ … 国王 6★） */
  star: number;
  /** 本级起始分 */
  gate: number;
  /** 下一级起始分；已是国王则为 null */
  next: { name: GradeName; gate: number } | null;
  /** 距离下一级的进度 0..1（国王恒为 1） */
  progress: number;
}

/**
 * 分数 → 等级。
 *
 * 负数按 0 处理（存档被手改也不会崩）；非整数先取整，避免 20.0000001 这类浮点尾巴
 * 在阈值上跳来跳去。
 */
export function gradeFor(points: number): Grade {
  const p = Math.max(0, Math.trunc(Number.isFinite(points) ? points : 0));
  let index = 0;
  for (let i = GRADE_GATES.length - 1; i >= 0; i--) {
    if (p >= GRADE_GATES[i]!) {
      index = i;
      break;
    }
  }
  const gate = GRADE_GATES[index]!;
  const nextGate = index + 1 < GRADE_GATES.length ? GRADE_GATES[index + 1]! : null;
  const progress =
    nextGate === null ? 1 : Math.min(1, Math.max(0, (p - gate) / (nextGate - gate)));
  return {
    index,
    name: GRADE_NAMES[index]!,
    star: index + 1,
    gate,
    next: nextGate === null ? null : { name: GRADE_NAMES[index + 1]!, gate: nextGate },
    progress,
  };
}

/** 结算分数：胜 +20、负 −20、和 0，下限 0 */
export function applyOutcome(points: number, outcome: Outcome): number {
  const p = Math.max(0, Math.trunc(Number.isFinite(points) ? points : 0));
  if (outcome === 'win') return p + WIN_POINTS;
  if (outcome === 'loss') return Math.max(0, p - LOSS_POINTS);
  return p;
}

/** 一局结束后的结果（认输算负；还没结束返回 null） */
export function outcomeFor(winner: Side | 'draw' | null, me: Side): Outcome | null {
  if (winner === null) return null;
  if (winner === 'draw') return 'draw';
  return winner === me ? 'win' : 'loss';
}

/**
 * 这一局要不要结算：不要就返回 null，要就返回结算后的分数。
 *
 * 把"什么局算分"的判断收在一处，App 里只负责调用 + 落盘：
 *   · 热座 / 双窗口是同一台机器上两个人 → 不记
 *   · 还没结束 / 不知道自己是哪一色 → 不记
 */
export function settlePoints(
  points: number,
  opts: { over: boolean; winner: Side | 'draw' | null; me: Side | null; record: boolean },
): number | null {
  if (!opts.record || !opts.over || !opts.me) return null;
  const outcome = outcomeFor(opts.winner, opts.me);
  if (!outcome) return null;
  return applyOutcome(points, outcome);
}

/** 本局分数变化（给结算文案用）：+20 / −20 / 0 */
export function pointsDelta(outcome: Outcome): number {
  if (outcome === 'win') return WIN_POINTS;
  if (outcome === 'loss') return -LOSS_POINTS;
  return 0;
}

// ── 存储 ────────────────────────────────────────────────────────────────
// 只存一个整数。所有访问都包 try/catch：隐私模式 / 存储被禁用时静默退化成"不记分"，
// 绝不能因为存档坏了把整局棋搞挂（和当初 gameLog 的做法一致）。

export const RATING_KEY = 'battlechess.rating.v1';

export function loadPoints(): number {
  try {
    const raw = window.localStorage.getItem(RATING_KEY);
    if (!raw) return 0;
    const parsed: unknown = JSON.parse(raw);
    // 兼容两种形状：直接存数字，或存 { points }
    const value =
      typeof parsed === 'number'
        ? parsed
        : parsed && typeof parsed === 'object' && 'points' in parsed
          ? Number((parsed as { points: unknown }).points)
          : 0;
    return Math.max(0, Math.trunc(Number.isFinite(value) ? value : 0));
  } catch {
    return 0;
  }
}

export function savePoints(points: number): number {
  const p = Math.max(0, Math.trunc(Number.isFinite(points) ? points : 0));
  try {
    window.localStorage.setItem(RATING_KEY, JSON.stringify({ points: p }));
  } catch {
    // 存不进去就只在本局生效
  }
  return p;
}
