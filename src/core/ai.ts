// 简易 AI —— 只用 ViewState 里的公开信息，绝不偷看真相
// （所以它能反过来验证视角投影足够支撑一整局对局）

import { BOARD_SIZE, LEVEL_VALUE, SIDES, canEat, other } from './pieces';
import { hiddenPool } from './features';import type { Action, Pos, Side, ViewCell, ViewState } from './types';

/** 还没翻开的棋子里，各方各等级还剩几个（公开知识，精确值 —— 见 features.hiddenPool） */
export function unknownPool(view: ViewState): Record<Side, number[]> {
  return hiddenPool(view);
}

/** 每个未翻开格子属于某方某等级的概率 —— 棋子池是公开知识，所以这个后验是精确的 */
export function identityProbability(view: ViewState): Record<Side, number[]> {
  const pool = unknownPool(view);
  let total = 0;
  for (const side of SIDES) for (const n of pool[side]) total += n;

  const prob = {} as Record<Side, number[]>;
  for (const side of SIDES) prob[side] = pool[side].map((n) => (total > 0 ? n / total : 0));
  return prob;
}

const key = (at: Pos) => `${at[0]},${at[1]}`;

function neighbors(at: Pos): Pos[] {
  const out: Pos[] = [];
  for (const [dr, dc] of [
    [-1, 0],
    [1, 0],
    [0, -1],
    [0, 1],
  ] as const) {
    const r = at[0] + dr;
    const c = at[1] + dc;
    if (r >= 0 && c >= 0 && r < BOARD_SIZE && c < BOARD_SIZE) out.push([r, c]);
  }
  return out;
}

/** 一步贪心，返回一个合法 action；没有可选则 null */
export function chooseAction(view: ViewState, rand: () => number = Math.random): Action | null {
  if (view.over) return null;

  const map = new Map<string, ViewCell>();
  for (const cell of view.cells) if (cell.id) map.set(key(cell.at), cell);

  const enemy = other(view.you);
  const prob = identityProbability(view);
  const revealedEnemies = view.cells.filter((c) => c.id && c.revealed && c.side === enemy);

  const distToNearest = (at: Pos): number => {
    let best = Infinity;
    for (const e of revealedEnemies) {
      const d = Math.abs(e.at[0] - at[0]) + Math.abs(e.at[1] - at[1]);
      if (d < best) best = d;
    }
    return best;
  };

  const candidates: { action: Action; score: number }[] = [];

  // 走子：吃子收益 - 被吃风险；吃不到子时朝最近的敌子靠拢
  for (const move of view.legal.moves) {
    const me = map.get(key(move.from));
    const target = map.get(key(move.to));
    if (!me) continue;

    let score = 0;
    const eats = Boolean(target && target.side);
    if (eats && target?.level !== null && target?.level !== undefined) score += LEVEL_VALUE[target.level]! * 10;

    const risky = neighbors(move.to).some((n) => {
      const c = map.get(key(n));
      return (
        c != null &&
        c.side === enemy &&
        c.level !== null &&
        me.level !== null &&
        canEat(c.level, me.level)
      );
    });
    if (risky) score -= LEVEL_VALUE[me.level ?? 5]! * (eats ? 3 : 5);
    if (!eats && revealedEnemies.length) {
      // 主动逼近：否则残局双方随机游走，很容易撞上 30 步和棋规则
      score += (distToNearest(move.from) - distToNearest(move.to)) * 8;
    }
    candidates.push({ action: { t: 'move', from: move.from, to: move.to }, score });
  }

  // 翻棋：翻到自己强子的期望收益 - 免费给对方亮牌的期望损失
  let flipScore = 2;
  for (let level = 0; level < LEVEL_VALUE.length; level++) {
    flipScore += prob[view.you][level]! * LEVEL_VALUE[level]! * 0.35;
    flipScore -= prob[enemy][level]! * LEVEL_VALUE[level]! * 0.15;
  }
  for (const at of view.legal.flips) {
    candidates.push({ action: { t: 'flip', at }, score: flipScore });
  }

  if (!candidates.length) return null;

  for (const c of candidates) c.score += rand() * 0.5;
  candidates.sort((a, b) => b.score - a.score);
  return candidates[0]!.action;
}
