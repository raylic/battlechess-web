// 侧栏棋子面板：把"每方还剩哪些子"摊成 5 行棋子。
//
// 三种状态全部来自**公开信息**，所以这个面板不需要（也不允许）碰任何隐藏信息：
//   存活 = 已翻开且还在场上（从投影 cells 里数）
//   被吃 = view.fallen（公开知识：被吃之前一定是翻开的）
//   没翻起 = 该等级总数 − 存活 − 被吃
// 每行都是该等级的**固定格位**：只会换状态，不会因为吃子/翻棋而改变布局。

import { LEVEL_COUNT_PER_SIDE } from '../core/pieces';
import type { Level, Side, ViewState } from '../core/types';

export type SlotState = 'alive' | 'down' | 'dead';

export interface PanelSlot {
  level: Level;
  state: SlotState;
}

/**
 * 面板布局：5 行，每行若干"组"（组内紧挨、组间留出等级间隔）。
 * 王+将 / 骑+弓 / 卫×4 / 刺×4 / 刺×4 —— 每方合计 18，与 LEVEL_COUNT_PER_SIDE 一致。
 */
export const PANEL_LAYOUT: readonly (readonly (readonly Level[])[])[] = [
  [[0, 1]],
  [[2, 2], [3, 3]],
  [[4, 4, 4, 4]],
  [[5, 5, 5, 5]],
  [[5, 5, 5, 5]],
];

/** 某方各等级**已经翻开且还在场上**的棋子数（公开信息，直接从投影里数） */
function revealedCounts(view: ViewState, side: Side): number[] {
  const out = LEVEL_COUNT_PER_SIDE.map(() => 0);
  for (const cell of view.cells) {
    if (cell.revealed && cell.side === side && cell.level !== null) out[cell.level] += 1;
  }
  return out;
}

/**
 * 生成某方面板的 5 行棋子。
 * 行内每个等级的格位固定按「存活 → 没翻起 → 被吃」排，左侧永远是还活着的。
 */
export function panelRows(view: ViewState, side: Side): PanelSlot[][][] {
  const alive = revealedCounts(view, side);
  const dead = view.fallen[side];

  const queue = LEVEL_COUNT_PER_SIDE.map((total, level) => {
    const a = alive[level]!;
    const d = dead[level]!;
    const down = Math.max(0, total - a - d);
    const slots: SlotState[] = [];
    for (let i = 0; i < a; i++) slots.push('alive');
    for (let i = 0; i < down; i++) slots.push('down');
    for (let i = 0; i < d; i++) slots.push('dead');
    return slots;
  });

  return PANEL_LAYOUT.map((row) =>
    row.map((group) => group.map((level) => ({ level, state: queue[level]!.shift() ?? 'down' }))),
  );
}
