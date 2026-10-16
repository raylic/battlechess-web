// HUD 文案与按钮状态 —— 全是纯函数，所以"赢了显示失败""按钮该亮不亮"这类问题可以被单测钉住。
// （原生版这部分逻辑埋在 hud.js 里拼 innerHTML，一行测试都没有）

import { MAX_NO_EAT, MIN_GIVEUP, REASON_TEXT } from '../core/judge';
import type { Side, ViewState } from '../core/types';

export type Mode = 'ai' | 'hotseat' | 'dual';

export function sideName(side: Side): string {
  return side === 'red' ? '红方' : '蓝方';
}

/** 现在是不是"我"能操作（热座模式下恒为真） */
export function isMyTurn(view: ViewState, side: Side | null): boolean {
  return !view.over && (side === null || side === view.turn);
}

/** 认输按钮是否该禁用 */
export function resignDisabled(view: ViewState, side: Side | null): boolean {
  return !(view.canResign && isMyTurn(view, side));
}

export function bannerText(view: ViewState, mode: Mode): string {
  if (view.over) return '对局结束';
  const turnName = sideName(view.turn);
  if (mode === 'ai') return view.you === view.turn ? '轮到你了' : '电脑思考中…';
  if (mode === 'dual') {
    return view.you === view.turn ? `轮到你（${sideName(view.you)}）· 请落子` : `等待对方（${turnName}）…`;
  }
  return `${turnName}回合 · 请翻棋或走子`;
}

export function footText(view: ViewState): string {
  const base = `已走 ${view.step} 步 · 连续 ${view.noEat} 步无吃子（${MAX_NO_EAT} 步判和）`;
  if (view.over || view.step >= MIN_GIVEUP) return base;
  return `${base} · 走过 ${MIN_GIVEUP} 步后才能认输`;
}

export function countText(view: ViewState, side: Side): string {
  return `剩 ${view.counts[side]} 子`;
}

export function resultTitle(winner: Side | 'draw' | null): string {
  if (winner === 'draw') return '和局';
  if (winner === 'red') return '红方获胜';
  if (winner === 'blue') return '蓝方获胜';
  return '对局结束';
}

export function resultWhy(view: Pick<ViewState, 'winner' | 'reason'>): string {
  const reason = view.reason ? REASON_TEXT[view.reason] : '';
  return `${resultTitle(view.winner)} · ${reason}`;
}

/** wait.png 是 4 列 x 1 行：红胜 / 蓝胜 / 平局 / 掉线（本作只用前三列）。
 *  原图是 2 行，上面那行是“联网口径”（胜利/失败/平局/掉线，还带积分），而本作不做联网与
 *  积分，整行一处未用，已裁掉 —— 文件从 1280x591 减到 1280x295，cell 正好 320x295，
 *  与 #modal .panel 的显示尺寸 1:1。 */
export function resultColumn(winner: Side | 'draw' | null): 0 | 1 | 2 {
  if (winner === 'red') return 0;
  if (winner === 'blue') return 1;
  return 2;
}

/** 结算面板的精灵图切片位置（裁成单行后，纵向恒为 0%） */
export function resultPanelStyle(winner: Side | 'draw' | null): {
  backgroundSize: string;
  backgroundPosition: string;
} {
  const col = resultColumn(winner);
  return { backgroundSize: '400% 100%', backgroundPosition: `${(col * 100) / 3}% 0%` };
}

/** 开始界面 / 头像显示用的名字 */
export function playerNames(mode: Mode): Record<Side, string> {
  return mode === 'ai' ? { red: '你', blue: '电脑' } : { red: '红方', blue: '蓝方' };
}
