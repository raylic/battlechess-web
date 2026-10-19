// 颜色的派生规则。
//
// 为什么不在 `start()` 里 `Math.random()`：种子是"整盘棋的编号"（`?seed=42` 刷新得同一盘、
// 对局记录只存种子+动作、复盘能完整重放）。颜色要是每次随机，同一个 seed 就会跑出两种
// 不同的对局 —— 记录和复盘立刻对不上。所以颜色**也由种子派生**：
//   seed 偶数 → 红，奇数 → 蓝
// 「再来一局」种子 +1，颜色自然换边；想固定颜色仍然可以 `?side=blue` 覆盖。

import type { Side } from '../core/types';

/** 我方颜色（种子偶数红、奇数蓝） */
export function sideForSeed(seed: number): Side {
  return Math.abs(Math.trunc(seed)) % 2 === 0 ? 'red' : 'blue';
}

export function otherSide(side: Side): Side {
  return side === 'red' ? 'blue' : 'red';
}
