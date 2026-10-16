// 胜负判定 —— 对应原版 game.py:BattleChess.update()

import { BOARD_SIZE, compareLevels } from './pieces';
import { legalActions } from './rules';
import type { GameState, Piece, Reason, Side } from './types';

export const MAX_NO_EAT = 30; // 30 步无吃子/无翻棋 → 和棋
export const MIN_GIVEUP = 20; // 走过 20 步后才能认输

export const REASON_TEXT: Record<Reason, string> = {
  wipe: '吃光了对方的全部棋子',
  lastStand: '最后之子比大小',
  noEat: `连续 ${MAX_NO_EAT} 步没有吃子或翻棋`,
  resign: '对方认输',
  stalemate: '无子可动',
};

/** 就地把 state 判为结束（只在 clone 出来的 state 上调用） */
function end(state: GameState, winner: Side | 'draw', reason: Reason): GameState {
  state.winner = winner;
  state.reason = reason;
  return state;
}

/**
 * 判定四种结束条件；未结束则原样返回。
 * 判定顺序照原版：先"吃光"，再"双方各剩 1 子"，再"30 步无吃子"，最后是本实现补的"无子可动"。
 */
export function judge(state: GameState): GameState {
  if (state.winner) return state;

  const { red, blue } = state.counts;
  if (red === 0) return end(state, 'blue', 'wipe');
  if (blue === 0) return end(state, 'red', 'wipe');

  if (red === 1 && blue === 1) {
    const left: Piece[] = [];
    for (let row = 0; row < BOARD_SIZE; row++) {
      for (let col = 0; col < BOARD_SIZE; col++) {
        const p = state.grid[row]![col];
        if (p) left.push(p);
      }
    }
    const r = left.find((p) => p.side === 'red');
    const b = left.find((p) => p.side === 'blue');
    // 理论上不可能（counts 已经保证各剩 1），但原版这里就是崩掉的那条分支，所以显式兜住
    if (!r || !b) return end(state, 'draw', 'lastStand');

    const cmp = compareLevels(r.level, b.level);
    if (cmp > 0) return end(state, 'red', 'lastStand');
    if (cmp < 0) return end(state, 'blue', 'lastStand');
    // 同级：原版因为先算红方 eat(蓝方) 而判红胜，这里改成和棋（有意偏离，见 README）
    return end(state, 'draw', 'lastStand');
  }

  if (state.noEat >= MAX_NO_EAT) return end(state, 'draw', 'noEat');

  const acts = legalActions(state);
  if (acts.flips.length === 0 && acts.moves.length === 0) return end(state, 'draw', 'stalemate');

  return state;
}
