// 兵种与克制关系 —— 对应原版 base.py:Chess.eat() 与 utils.py:random_chess()

import type { Level, Side } from './types';

/** level 越小越强：0=国王 … 5=刺客 */
export const LEVEL_NAMES = ['国王', '将军', '骑士', '弓箭手', '禁卫军', '刺客'] as const;

/** 每方各等级的数量（原版 CHESS_NUM / 2） */
export const LEVEL_COUNT_PER_SIDE: readonly number[] = [1, 1, 2, 2, 4, 8];

/** AI 估值用（不是游戏规则） */
export const LEVEL_VALUE: readonly number[] = [1000, 300, 160, 120, 60, 40];

export const BOARD_SIZE = 6;
export const PIECES_PER_SIDE = LEVEL_COUNT_PER_SIDE.reduce((a, b) => a + b, 0); // 18

export const KING: Level = 0;
export const ASSASSIN: Level = 5;

export const SIDES: readonly Side[] = ['red', 'blue'];

export function other(side: Side): Side {
  return side === 'red' ? 'blue' : 'red';
}

/**
 * 等级 a 能否吃掉等级 b —— 原版 Chess.eat()
 * 规则：a <= b 即可吃；外加刺客吃国王、国王吃不了刺客。
 */
export function canEat(attackerLevel: number, targetLevel: number): boolean {
  if (attackerLevel === KING && targetLevel === ASSASSIN) return false;
  if (attackerLevel === ASSASSIN && targetLevel === KING) return true;
  return attackerLevel <= targetLevel;
}

/**
 * 残局（双方各剩 1 子）比大小。
 * @returns 1 = a 胜，-1 = b 胜，0 = 平（同级）
 */
export function compareLevels(a: number, b: number): 1 | 0 | -1 {
  const ab = canEat(a, b);
  const ba = canEat(b, a);
  if (ab && !ba) return 1;
  if (ba && !ab) return -1;
  return 0;
}
