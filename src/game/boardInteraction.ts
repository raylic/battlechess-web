// 点击策略与高亮 —— 从原生版的 boardView.handleClick/render 抽出来的**纯函数**。
// 抽出来是为了能直接测："不是自己回合不能操作"、"终局后不能操作"这两条守卫
// 在原生版里是裸 if，一行测试都没有（变异测试显示改坏了没人管）。

import { samePos } from '../core/rules';
import type { Action, Pos, ViewState } from '../core/types';

export interface ClickResult {
  /** 要发给权威的操作；没有则不发 */
  action?: Action;
  /** 点击之后的选中态 */
  selected: Pos | null;
}

export function cellAt(view: ViewState, at: Pos) {
  return view.cells.find((c) => samePos(c.at, at)) ?? null;
}

/** 这一格现在能操作吗（= 点下去会有后果） */
export function isActionable(view: ViewState, at: Pos): boolean {
  if (view.over || view.you !== view.turn) return false;
  const cell = cellAt(view, at);
  if (view.legal.flips.some((p) => samePos(p, at))) return true;
  if (cell?.revealed && cell.side === view.you) return true;
  return view.legal.moves.some((m) => samePos(m.from, at));
}

/** 点击某个格子之后应该发生什么 */
export function resolveClick(view: ViewState, selected: Pos | null, at: Pos): ClickResult {
  // 守卫 1：对局已结束
  if (view.over) return { selected };
  // 守卫 2：不是自己回合（双窗口模式下另一个窗口就会走到这里）
  if (view.you !== view.turn) return { selected };

  const cell = cellAt(view, at);

  // 暗子：任何格子都能翻（包括对方的）
  if (view.legal.flips.some((p) => samePos(p, at))) {
    return { action: { t: 'flip', at }, selected: null };
  }

  // 自己已翻开的子：选中 / 取消选中
  if (cell?.revealed && cell.side === view.you) {
    return { selected: selected && samePos(selected, at) ? null : at };
  }

  // 已选中且在可落点里：走子
  if (selected) {
    const targets = view.legal.moves.filter((m) => samePos(m.from, selected)).map((m) => m.to);
    if (targets.some((t) => samePos(t, at))) {
      return { action: { t: 'move', from: selected, to: at }, selected: null };
    }
  }

  return { selected: null };
}

export interface CellFlags {
  isLast: boolean;
  isSelected: boolean;
  isTarget: boolean;
  isHoverable: boolean;
}

export function cellFlags(view: ViewState, selected: Pos | null, at: Pos): CellFlags {
  const targets = selected
    ? view.legal.moves.filter((m) => samePos(m.from, selected)).map((m) => m.to)
    : [];
  return {
    isLast: view.lastStep !== null && samePos(view.lastStep, at),
    isSelected: selected !== null && samePos(selected, at),
    isTarget: targets.some((t) => samePos(t, at)),
    isHoverable: isActionable(view, at),
  };
}
