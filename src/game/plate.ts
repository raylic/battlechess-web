// 名牌的几何、头像裁切参数与文案 —— 全是纯函数/常量，HUD 和揭晓动画共用同一份。
//
// 坐标系就是名牌本身：200×220，和 head_red / head_blue 那张图一模一样。
// 这些数字来自 `~/Documents/皇家战棋.pen` 的规格帧，改设计稿时两边一起改。

import type { Side } from '../core/types';
import type { Mode } from './hudText';

/** 名牌画布（= head_*.webp 的尺寸） */
export const PLATE = { width: 200, height: 220 } as const;

/**
 * 圆环里的头像圆盘。
 *
 * 实测 head_*.webp 的金环内洞正好是半径 30.5 的**正圆**（bbox 70..130 / 15..75，圆心 (100,45)），
 * 所以圆盘取 62 就能整块盖住洞口、又不压金环。
 */
export const DISC = { size: 62, left: 69, top: 14, cx: 100, cy: 45 } as const;

/** 五角星：沿圆盘外圈排一段上弧（星少就自动收紧，星多才铺开） */
export const STAR = { size: 11, radius: 39, step: 24, cx: DISC.cx, cy: DISC.cy } as const;

// ── 头像：运行时从 chess.webp 裁，不额外存图 ────────────────────────────
//
// 精灵图 870×290 = 6 列（等级，左强右弱）× 2 行（上行红、下行蓝），每格 145×145。
// 每枚棋子在格子里的紧裁框、以及"脸"的坐标，是离线量出来后写死在这里的参数 ——
// 运行时用 background-size / background-position 直接取那一块，一个字节的新资源都不用加。

export const SHEET = { url: 'assets/chess.webp', cell: 145, cols: 6, rows: 2, width: 870, height: 290 } as const;

/**
 * 头像缩放：设计稿是"基准 60px 高 × 1.714" = 精灵图原始像素的 0.864 倍。
 * 于是国王（116px 高）在 62px 的圆盘里被放大到 100px —— 只看得见脸和肩，正是头像该有的构图。
 */
export const PORTRAIT_SCALE = 0.864;

export interface PieceCrop {
  /** 紧裁框在格子里的左上角 */
  bx: number;
  by: number;
  /** 紧裁框尺寸（只用于校验，绘制不需要） */
  w: number;
  h: number;
  /** "脸"（近黑区域重心）在紧裁框里的坐标 */
  fx: number;
  fy: number;
}

/**
 * 六等级 × 两色的裁切参数，序号 = 等级序号（0 刺客 … 5 国王），**和精灵图的列序相反**。
 *
 * `fx/fy` 的判据是近黑像素的重心（`max(r,g,b) < 50`）：黑脸罩就是那张脸。
 * 别用"明度均值 < 95"那套 —— 红方深红袍、蓝方藏青袍的均值都在 60~75，会把重心拽到袍子上，
 * 蓝将军/蓝国王的头像就会偏上、皇冠被切掉（这个坑踩过）。
 */
export const PIECE_CROPS: Record<Side, readonly PieceCrop[]> = {
  red: [
    { bx: 42, by: 75, w: 53, h: 67, fx: 28.9, fy: 36.5 }, // 0 刺客
    { bx: 18, by: 72, w: 83, h: 73, fx: 48.4, fy: 32.8 }, // 1 禁卫军
    { bx: 28, by: 72, w: 77, h: 73, fx: 34.4, fy: 29.0 }, // 2 弓箭手
    { bx: 1, by: 60, w: 103, h: 85, fx: 68.6, fy: 43.9 }, // 3 骑士
    { bx: 15, by: 48, w: 100, h: 97, fx: 45.6, fy: 49.4 }, // 4 将军
    { bx: 5, by: 29, w: 108, h: 116, fx: 66.8, fy: 68.8 }, // 5 国王
  ],
  blue: [
    { bx: 42, by: 75, w: 53, h: 67, fx: 28.4, fy: 39.3 },
    { bx: 19, by: 72, w: 80, h: 73, fx: 47.4, fy: 35.1 },
    { bx: 28, by: 72, w: 89, h: 73, fx: 33.2, fy: 29.1 },
    { bx: 3, by: 59, w: 103, h: 86, fx: 68.1, fy: 41.2 },
    { bx: 15, by: 50, w: 103, h: 95, fx: 48.9, fy: 49.0 },
    { bx: 5, by: 32, w: 108, h: 113, fx: 66.7, fy: 64.6 },
  ],
};

export interface PortraitStyle {
  backgroundImage: string;
  backgroundSize: string;
  backgroundPosition: string;
}

/**
 * 单个头像的 CSS：把"脸"精确放到圆盘圆心。
 *
 * 做法就是把整张精灵图按 `PORTRAIT_SCALE` 放大，再平移，使脸的中心落在 (31,31)。
 * 负数位置是正常的 —— 精灵图比圆盘大得多，只有那一小块会露出来（圆盘 overflow:hidden）。
 */
export function portraitStyle(side: Side, gradeIndex: number): PortraitStyle {
  const level = Math.max(0, Math.min(5, Math.trunc(Number.isFinite(gradeIndex) ? gradeIndex : 5)));
  const crop = PIECE_CROPS[side][level]!;
  const col = SHEET.cols - 1 - level; // 精灵图第 0 列是最强的国王
  const row = side === 'blue' ? 1 : 0;
  const ax = col * SHEET.cell + crop.bx + crop.fx;
  const ay = row * SHEET.cell + crop.by + crop.fy;
  const s = PORTRAIT_SCALE;
  const half = DISC.size / 2;
  return {
    backgroundImage: `url(${import.meta.env.BASE_URL}${SHEET.url})`,
    backgroundSize: `${(SHEET.width * s).toFixed(2)}px ${(SHEET.height * s).toFixed(2)}px`,
    backgroundPosition: `${(half - ax * s).toFixed(2)}px ${(half - ay * s).toFixed(2)}px`,
  };
}

export interface StarSpot {
  left: number;
  top: number;
}

/**
 * n 颗星的坐标（相对名牌左上角）。
 *
 * 角度用**固定步距**而不是"把 120° 均分"：刺客只有 1 颗星时应该孤零零挂在正上方，
 * 均分的话 1 颗和 6 颗看起来一样宽 —— 星少就该排紧。
 */
export function starLayout(count: number): StarSpot[] {
  const n = Math.max(0, Math.min(6, Math.trunc(Number.isFinite(count) ? count : 0)));
  const spots: StarSpot[] = [];
  for (let i = 0; i < n; i++) {
    const deg = 270 + (i - (n - 1) / 2) * STAR.step;
    const rad = (deg * Math.PI) / 180;
    spots.push({
      left: Math.round(STAR.cx + STAR.radius * Math.cos(rad) - STAR.size / 2),
      top: Math.round(STAR.cy + STAR.radius * Math.sin(rad) - STAR.size / 2),
    });
  }
  return spots;
}

/** 电脑那一侧的名牌：没有积分，称号位写"普通"，头像固定用国王当对手徽记 */
export const COMPUTER = { title: '普通', gradeIndex: 5 } as const;

/**
 * 名牌黄块上的身份：说"你是谁"，不是"你是什么颜色"。
 *   · 人机：玩家 / 电脑
 *   · 联机：玩家 / 对手
 *   · 热座、双窗口：同一台机器上两个人，只能写红方 / 蓝方
 */
export function identityFor(mode: Mode, side: Side | null, which: Side): string {
  if (mode === 'ai') return which === side ? '玩家' : '电脑';
  if (mode === 'online') return which === side ? '玩家' : '对手';
  return which === 'red' ? '红方' : '蓝方';
}

/** 这一局记不记积分：人机与联机各记各的；热座/双窗口是同一台机器，不记 */
export function recordsRating(mode: Mode): boolean {
  return mode === 'ai' || mode === 'online';
}
