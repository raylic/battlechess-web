// 棋盘几何：与 style.css 里的 --cell / --piece-scale 保持一致（单一事实来源在 JS，写进 CSS 变量）
// 纯函数，方便单测。

export const CELL = 88;
export const PIECE_SCALE = 1.42;
export const PIECE_SIZE = CELL * PIECE_SCALE;

/** 棋盘倾斜角（度），与 styles.css 的 --tilt 一致 */
export const TILT_DEG = 45;

/**
 * 棋子沿**深度**方向的抬升（px），与 styles.css 的 --piece-z 一致。
 *
 * 为什么它不能随便小：棋子是绕自身中心反向旋转 tilt 度来"站起来面朝镜头"的，
 * 于是它的下边缘会往棋盘平面**之后**掉：
 *     下边缘深度 = PIECE_Z − (PIECE_SIZE / 2) · sin(tilt)
 * 这个值一旦 ≤ 0，格子（棋盘平面）就把棋子的下半身盖住 —— 真实症状是每枚
 * 棋子都被横着切掉一截。所以必须有 PIECE_Z > (PIECE_SIZE / 2) · sin(tilt)。
 * layout.test.ts 里守着这条不等式（之前写死 26px 时它是 −18.2，被切掉约 20%）。
 */
export const PIECE_Z = 52;

/**
 * 棋子锚点相对格子中心再额外上抬多少（斜面 y 方向的 px）。
 *
 * 0 就够了 —— 因为棋子已经“站”起来了：沿深度抬 PIECE_Z，在 45° 斜面上本身就会把棋子
 * 在屏幕上顶高约 PIECE_Z·sin45 ≈ 37px（还要乘透视放大），这就是“立在格子上”的观感。
 * 再往上加会飘；调成负数会显得棋子陷进格子里。
 *
 * 调这个值请对着浏览器看，别只看数字：棋子高 125 而格宽只有 88，视觉重心很敏感。
 * （踩过一次：开头把它拿去补深度位移，外框是回到原位了，但外框里原本有 20% 被裁掉、
 *   看不见，整块露出来之后视觉重心就掉下去，看起来“靠下”。）
 */
export const PIECE_RISE = 0;

/**
 * 棋子相对棋子层的偏移（px 字符串，直接喂给 CSS 变量）。
 * 棋子比格子大，所以要先减去半个差值居中，再按 PIECE_RISE 微调。
 */
export function piecePixel(row: number, col: number): { px: string; py: string } {
  const off = (PIECE_SIZE - CELL) / 2;
  return { px: `${col * CELL - off}px`, py: `${row * CELL - off - PIECE_RISE}px` };
}
