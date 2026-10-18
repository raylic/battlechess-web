#!/usr/bin/env python3
"""把棋子精灵图裁成"侧栏面板用的迷你图标"。

为什么需要它：`chess.webp` 的每个格子是 145×145，棋子在格子里只占中间一小块，
直接压到 28px 会小得认不出来（实际只有 5~6px）。

做法：每颗棋子按**自己的包围盒**裁紧，再按同一高度落到 48×48 格子里、底边对齐。
也就是说面板里国王和刺客一样高 —— 这是刻意的：侧栏是"还剩哪些子"的清单，不是棋盘，
28px 下保住"认得出是谁"比保住"国王比刺客大"更重要（棋盘上的相对大小不受影响）。

输出两张（都进版本库，都在 public/assets 里被引用）：
  chess-mini.webp  6 列(等级) × 2 行(上红下蓝)，每格 48×48（显示 28px，够 2x 屏）
  back-mini.webp   暗面棋子，48×48

用法：python3 scripts/make-mini-sheet.py   （需要 Pillow，不参与构建也不参与测试）
"""

from pathlib import Path

import numpy as np
from PIL import Image

ASSETS = Path(__file__).resolve().parent.parent / "public" / "assets"
CELL = 48

# 图标最多占格子的这么多（剩下是呼吸空间，28px 下相邻两颗才不会粘在一起）
FILL = 0.94


def tight(img: Image.Image) -> Image.Image:
    """按 alpha 包围盒裁紧（原图格子四周有大量透明留白）"""
    box = img.getchannel("A").getbbox()
    return img.crop(box) if box else img


def fit_cell(img: Image.Image) -> Image.Image:
    """裁紧后等比缩放到 FILL × CELL 高，水平居中、底边对齐（棋子都"站"在同一基线上）"""
    img = tight(img)
    w, h = img.size
    scale = (CELL * FILL) / h
    nw, nh = max(1, round(w * scale)), max(1, round(h * scale))
    if nw > CELL * FILL:  # 极宽的棋子按宽度兜底
        nw, nh = round(CELL * FILL), max(1, round(h * (CELL * FILL) / w))
    img = img.resize((nw, nh), Image.LANCZOS)
    cell = Image.new("RGBA", (CELL, CELL), (0, 0, 0, 0))
    cell.alpha_composite(img, ((CELL - nw) // 2, CELL - nh))
    return cell


def back_cell(img: Image.Image) -> Image.Image:
    """暗面：原图四周有半透明空边，按不透明像素裁紧后再按同一高度落格"""
    alpha = np.array(img)[:, :, 3]
    ys, xs = np.where(alpha > 128)
    pad = 6
    box = (
        max(0, int(xs.min()) - pad),
        max(0, int(ys.min()) - pad),
        min(img.size[0], int(xs.max()) + pad),
        min(img.size[1], int(ys.max()) + pad),
    )
    return fit_cell(img.crop(box))


def main() -> None:
    sprite = Image.open(ASSETS / "chess.webp").convert("RGBA")
    cw, ch = sprite.size[0] // 6, sprite.size[1] // 2
    sheet = Image.new("RGBA", (CELL * 6, CELL * 2), (0, 0, 0, 0))
    for row in range(2):
        for col in range(6):
            cell = fit_cell(sprite.crop((col * cw, row * ch, (col + 1) * cw, (row + 1) * ch)))
            sheet.alpha_composite(cell, (col * CELL, row * CELL))
    sheet.save(ASSETS / "chess-mini.webp", "WEBP", lossless=True, quality=100, method=6)

    back = back_cell(Image.open(ASSETS / "unopen.webp").convert("RGBA"))
    back.save(ASSETS / "back-mini.webp", "WEBP", lossless=True, quality=100, method=6)

    for name in ("chess-mini.webp", "back-mini.webp"):
        kb = (ASSETS / name).stat().st_size / 1024
        print(f"{name}: {kb:.1f} KB")


if __name__ == "__main__":
    main()
