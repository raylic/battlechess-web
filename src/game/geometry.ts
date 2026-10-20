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
 * 棋盘平面用的贴图（`public/assets/board-flat.webp`）：一张**俯视**的正方形棋盘，自带金边。
 * 45° 倾斜不归它管 —— 那是 CSS 的 `rotateX(var(--tilt))`，贴图只是贴在棋盘平面上。
 *
 * **注意四周的金边**：6×6 棋格区域并不铺满整张图。直接 `background-size: 100% 100%`
 * 会把金边也挤进棋格里，格线就和 `.cell` 的边界错开（症状：色块边缘和格子对不上、
 * 越往外圈越偏）。所以贴图必须放大到「棋格区 → 棋盘盒」并往左上挪一点，
 * 多出来的那圈金边画到棋盘盒外面去（CSS 变量见 styles.css 的 --board-art*）。
 *
 * 下面的数值是网格吸附后的量测结果（贴图像素）：棋盘边界 "7 条格线" 里 k=0/6 就是金边内侧那条深线，
 * 也就是格子边界（不是色块边缘 —— 两者差半个线宽，拿错会系统性错 ~2px）。
 * 重测/重跑：`../assets-build/snap-board.py`（它会把格线拉成精确的 o+k*p 并打印这几个数）。
 */
export const BOARD_ART = {
  file: 'board-flat.webp',
  /** 贴图边长（正方形，素材原尺寸 px） */
  size: 1536,
  /** 6×6 棋格区域在贴图里的位置（贴图像素，正方形）：left / top / 宽 = 高 */
  area: { left: 19.46, top: 18.11, width: 1496.46, height: 1496.46 },
} as const;

/**
 * 棋子相对棋子层的偏移（px 字符串，直接喂给 CSS 变量）。
 * 棋子比格子大，所以要先减去半个差值居中，再按 PIECE_RISE 微调。
 */
export function piecePixel(row: number, col: number): { px: string; py: string } {
  const off = (PIECE_SIZE - CELL) / 2;
  return { px: `${col * CELL - off}px`, py: `${row * CELL - off - PIECE_RISE}px` };
}
