import type { CSSProperties } from 'react';

import { DISC, PLATE, portraitStyle, starLayout } from '../game/plate';
import { GRADE_NAMES } from '../game/rating';
import type { Side } from '../core/types';

export interface NamePlateProps {
  side: Side;
  /** 黄块上的身份：玩家 / 电脑 / 对手 / 红方 / 蓝方 */
  identity: string;
  /** 等级序号 0..5；不传就不画星级、不写称号（热座/双窗口/对方没有数据时） */
  gradeIndex?: number | null;
  /** 称号文案，默认取等级名（电脑写"普通"） */
  title?: string | null;
  /** 积分；null/undefined 就不显示（电脑、对手） */
  points?: number | null;
  /** 追加类名（HUD 用来挂 is-active 之类的状态） */
  className?: string;
  testId?: string;
}

/** 五角星（金面 + 深棕描边，和设计稿同色）。用 SVG 直接画：不要额外的图片资源 */
function Star() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path
        d="M12 2.4l2.94 5.96 6.58.96-4.76 4.64 1.12 6.55L12 17.42l-5.88 3.09 1.12-6.55L2.48 9.32l6.58-.96z"
        fill="#FFD24A"
        stroke="#7A3A06"
        strokeWidth="1.7"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/**
 * 200×220 的盾形名牌：金环里一枚圆形头像，黄块写身份，下面两行是称号与积分，
 * 头像外圈挂五角星。
 *
 * 底板直接用游戏里那张 head_{side}.webp（金环内洞是透明的），头像是**运行时**从
 * chess.webp 里裁的（参数见 game/plate.ts），所以这里一张新图都不用存。
 */
export function NamePlate({
  side,
  identity,
  gradeIndex = null,
  title = null,
  points = null,
  className,
  testId,
}: NamePlateProps) {
  const hasGrade = gradeIndex !== null && gradeIndex >= 0 && gradeIndex < GRADE_NAMES.length;
  // 星级 = 等级序号 + 1：刺客 1 颗 … 国王 6 颗
  const stars = hasGrade ? starLayout(gradeIndex! + 1) : [];
  const label = hasGrade ? (title ?? GRADE_NAMES[gradeIndex!]) : title;
  // 没有等级信息（热座两头、联机对手）时头像退到国王，纯当"对手徽记"
  const portrait = portraitStyle(side, hasGrade ? gradeIndex! : 5);

  return (
    <div
      className={`plate${className ? ` ${className}` : ''}`}
      data-side={side}
      data-testid={testId ?? `plate-${side}`}
      style={PLATE_STYLE}
    >
      <img className="plate-art" src={`${import.meta.env.BASE_URL}assets/head_${side}.webp`} alt="" />
      <div
        className="plate-disc"
        style={portrait as CSSProperties}
        data-testid={`portrait-${side}`}
        aria-hidden="true"
      />
      {stars.map((spot, i) => (
        <span
          key={i}
          className="plate-star"
          style={{ left: spot.left, top: spot.top, width: 11, height: 11 } as CSSProperties}
          data-testid={i === 0 ? `stars-${side}` : undefined}
        >
          <Star />
        </span>
      ))}
      <div className="plate-id">{identity}</div>
      {label ? <div className="plate-title">{label}</div> : null}
      {points !== null ? <div className="plate-points">{points}</div> : null}
    </div>
  );
}

const PLATE_STYLE = {
  width: PLATE.width,
  height: PLATE.height,
  // 圆盘点位也从这里注入，样式表里不另写一份
  ['--disc-size' as string]: `${DISC.size}px`,
  ['--disc-left' as string]: `${DISC.left}px`,
  ['--disc-top' as string]: `${DISC.top}px`,
} as CSSProperties;
