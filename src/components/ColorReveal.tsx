// 开局揭晓颜色：一枚双面名牌绕竖轴翻转，减速停在"我方颜色"那一面。
//
// 牌面就是 HUD 里那份名牌（NamePlate）：头像 + 外圈星级 + 身份 + 称号·积分。
// 正面红、背面蓝，两面写着同一个人（玩家 / 我的等级）—— 转的是"我是哪一色"，不是两个对手。
// 停在哪一面靠 `--turns` 决定：转满 4 圈（1440°）红面朝前，再多半圈（1620°）就是蓝面朝前。

import type { CSSProperties } from 'react';

import { gradeFor } from '../game/rating';
import type { Side } from '../core/types';
import { NamePlate } from './NamePlate';

/** 转动时长（ms） */
export const REVEAL_SPIN_MS = 1400;
/** 停住后**停顿**多久（ms）：这段时间让「你执红方」站住、让人看清 */
export const REVEAL_HOLD_MS = 700;
/** 落位飞行时长（ms） */
export const REVEAL_FLY_MS = 470;

/** 落位开始时刻 = 转完 + 停顿 */
export const REVEAL_LAND_MS = REVEAL_SPIN_MS + REVEAL_HOLD_MS;
/** 整层卸载时刻（留 80ms 余量给"真头像顶上来"） */
export const REVEAL_TOTAL_MS = REVEAL_LAND_MS + REVEAL_FLY_MS + 80;

export interface ColorRevealProps {
  side: Side;
  /** 我的积分：牌面上直接显示我的等级/星级（不传就只显示身份） */
  points?: number | null;
  /** 我的身份文案（玩家 / 红方 …） */
  identity?: string;
  /** 点一下跳过（交给上层卸载这一层） */
  onSkip?: () => void;
}

export function ColorReveal({ side, points = null, identity = '玩家', onSkip }: ColorRevealProps) {
  const turns = side === 'red' ? '1440deg' : '1620deg';
  // 时间轴也交给 CSS 变量：常量只写在这里，样式表里全部 calc() 引用，不会各写一份对不上
  const timing = {
    '--turns': turns,
    '--spin': `${REVEAL_SPIN_MS}ms`,
    '--hold': `${REVEAL_HOLD_MS}ms`,
    '--fly': `${REVEAL_FLY_MS}ms`,
  } as CSSProperties;
  const gradeIndex = points === null ? null : gradeFor(points).index;

  const face = (which: Side) => (
    <div className={`reveal-face ${which === 'red' ? 'front' : 'back'}`}>
      <NamePlate side={which} identity={identity} gradeIndex={gradeIndex} points={points} testId={`reveal-plate-${which}`} />
    </div>
  );

  return (
    <div
      id="reveal"
      data-testid="color-reveal"
      data-side={side}
      style={timing}
      aria-hidden="true"
      onClick={onSkip}
    >
      {/* 压暗单独一层：它负责淡出，卡片不跟着淡 —— 否则牌飞到头像位时正好"淡没了" */}
      <div className="reveal-backdrop" />
      <div className="reveal-card" data-testid="reveal-card">
        {face('red')}
        {face('blue')}
      </div>
      <p className="reveal-text" data-testid="reveal-text">
        你执{side === 'red' ? '红' : '蓝'}方
      </p>
    </div>
  );
}
