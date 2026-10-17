// 视角投影 —— 隐藏信息只在这一层发生。
// 渲染层不做任何"隐藏"，它拿到的数据里就已经没有暗子身份了。
//
// 口径（已与需求方确认）：
//   double-blind = 口径 A：未翻开的棋子对双方都不可见（原版行为，未翻开的棋子红蓝共用一张图）
//   own-known    = 口径 B：自己的暗子自己可见（本期不启用，保留为单常量开关）
//
// 双盲之下 viewFor(red) 与 viewFor(blue) 的信息是对称的，两者只差
// "you / legal（谁能操作）" 和 HUD —— 这是原版玩法的固有性质。

import { BOARD_SIZE, LEVEL_COUNT_PER_SIDE, SIDES } from './pieces';
import { legalActions } from './rules';
import { MIN_GIVEUP } from './judge';
import type { Level, Piece, Policy, Side, ViewCell, ViewState } from './types';

export const POLICY = {
  DOUBLE_BLIND: 'double-blind',
  OWN_KNOWN: 'own-known',
} as const satisfies Record<string, Policy>;

export const DEFAULT_POLICY: Policy = POLICY.DOUBLE_BLIND;

/**
 * 往视角里带多少步公开局面指纹。
 * 只带尾巴：AI 需要认出的"循环"都是短周期的（来回走子、三五十步内绕回同一张盘面）。
 * 带多了只是给搜索多加活，没有好处。
 */
export const RECENT_CAP = 32;

export function visibleIdentity(
  piece: Piece,
  viewer: Side,
  policy: Policy,
): { side: Side | null; level: Level | null } {
  if (piece.revealed) return { side: piece.side, level: piece.level };
  if (policy === POLICY.OWN_KNOWN && piece.side === viewer) return { side: piece.side, level: piece.level };
  return { side: null, level: null };
}

/**
 * 各方各等级被吃掉了几个 —— 公开知识。
 * 开局每方各等级数量固定且公开，场上还活着的子可以直接数出来（真相里数，不吃亏），
 * 差额就是"已经被吃掉"的部分，而这部分在被吃之前都是翻开的、双方都看见过。
 * 所以把它放进投影**不泄漏任何隐藏信息**，却让"剩余暗子池"从估算变成精确值。
 */
function fallenCounts(state: import('./types').GameState): Record<Side, number[]> {
  const alive: Record<Side, number[]> = {
    red: LEVEL_COUNT_PER_SIDE.map(() => 0),
    blue: LEVEL_COUNT_PER_SIDE.map(() => 0),
  };
  for (let row = 0; row < BOARD_SIZE; row++) {
    for (let col = 0; col < BOARD_SIZE; col++) {
      const p = state.grid[row]![col];
      if (p) alive[p.side][p.level] += 1;
    }
  }
  const out = {} as Record<Side, number[]>;
  for (const side of SIDES) {
    out[side] = LEVEL_COUNT_PER_SIDE.map((n, level) => n - alive[side][level]!);
  }
  return out;
}

/** 把真相投影成某个视角能看到的全部信息 */
export function viewFor(
  state: import('./types').GameState,
  viewer: Side,
  policy: Policy = DEFAULT_POLICY,
): ViewState {
  const over = state.winner !== null;

  const cells: ViewCell[] = [];
  for (let row = 0; row < BOARD_SIZE; row++) {
    for (let col = 0; col < BOARD_SIZE; col++) {
      const p = state.grid[row]![col];
      if (!p) {
        cells.push({ id: null, at: [row, col], revealed: false, side: null, level: null, dire: 0 });
        continue;
      }
      // 终局全亮：已经没有可藏的信息了，顺便当复盘
      const identity = over ? { side: p.side, level: p.level } : visibleIdentity(p, viewer, policy);
      cells.push({
        id: p.id,
        at: [row, col],
        revealed: over || p.revealed,
        side: identity.side,
        level: identity.level,
        dire: p.dire,
      });
    }
  }

  const myTurn = !over && state.turn === viewer;

  return {
    you: viewer,
    turn: state.turn,
    step: state.step,
    noEat: state.noEat,
    counts: { ...state.counts },
    fallen: fallenCounts(state),
    lastStep: state.lastStep ? ([...state.lastStep] as [number, number]) : null,
    winner: state.winner,
    reason: state.reason,
    over,
    policy,
    canResign: !over && state.step >= MIN_GIVEUP,
    recent: state.history.slice(-RECENT_CAP),
    cells,
    legal: myTurn ? legalActions(state) : { flips: [], moves: [] },
  };
}
