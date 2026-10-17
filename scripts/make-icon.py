#!/usr/bin/env python3
"""生成全站唯一那张图标 `public/assets/icon-192.png`，图案取自 `unopen`（棋子背面）。

为什么只有一个图标：favicon、apple-touch-icon、manifest 三处全指同一个文件。
早先分过 192 / 512 / maskable-512 / apple-touch-icon / ico 五份，实测下来多出来的
几份只在"装到主屏"时才用得上，代价是 28 KB 和一堆没人维护的路径。

为什么必须先裁紧：`unopen` 画布 283x283，但图案只占 31%x40%、缩在底部中间
（棋子背面四周留了大片透明）。直接拿它当图标，浏览器压到 16px 的标签页上就只剩一个小点 ——
曾经就这么错过一次，症状是"chrome 里的 icon 变得特别小"。

为什么仍然是 PNG：WebP 做 favicon 在 Safari / 老浏览器上不可靠，
apple-touch-icon 更是要求 PNG。所以只有这一张保持 PNG，其余素材都是 WebP。

用法：
    python3 scripts/make-icon.py                 # 默认读 public/assets/unopen.webp
    python3 scripts/make-icon.py --src X --size 192
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

import numpy as np
from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
DEFAULT_SRC = ROOT / "public" / "assets" / "unopen.webp"
DEFAULT_DST = ROOT / "public" / "assets" / "icon-192.png"

# 图案四周留的边（占边长比例）。留一点点，别让图案顶到画布边缘被圆角切掉；
# 留多了又会显得"图标特别小"。
MARGIN = 0.04


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--src", default=str(DEFAULT_SRC))
    ap.add_argument("--dst", default=str(DEFAULT_DST))
    ap.add_argument("--size", type=int, default=192)
    args = ap.parse_args()

    src, dst = Path(args.src), Path(args.dst)
    if not src.exists():
        print(f"找不到源图：{src}", file=sys.stderr)
        return 1

    img = Image.open(src).convert("RGBA")
    a = np.asarray(img)
    ys, xs = np.where(a[..., 3] > 8)
    if len(ys) == 0:
        print(f"{src} 全透明，抠不出图案", file=sys.stderr)
        return 1
    box = (int(xs.min()), int(ys.min()), int(xs.max()) + 1, int(ys.max()) + 1)
    art = img.crop(box)
    print(f"源图 {img.width}x{img.height}，图案 bbox {box} → {art.width}x{art.height}")

    # 铺到正方形画布上（只做留边，不裁掉图案），再缩到目标尺寸
    side = round(max(art.width, art.height) / (1 - 2 * MARGIN))
    canvas = Image.new("RGBA", (side, side), (0, 0, 0, 0))
    canvas.alpha_composite(art, ((side - art.width) // 2, (side - art.height) // 2))
    icon = canvas.resize((args.size, args.size), Image.LANCZOS)

    # 量化到 256 色：扁色卡通肉眼看不出差别，体积只有 1/4 左右。
    # FASTOCTREE 是唯一能保住 alpha 通道的量化方式（另两种会把透明压平）。
    icon = icon.quantize(colors=256, method=Image.FASTOCTREE)
    dst.parent.mkdir(parents=True, exist_ok=True)
    icon.save(dst, "PNG", optimize=True)
    dst.chmod(0o644)

    out = np.asarray(Image.open(dst).convert("RGBA"))
    ys, xs = np.where(out[..., 3] > 8)
    cover = (xs.max() - xs.min() + 1) / args.size, (ys.max() - ys.min() + 1) / args.size
    print(
        f"→ {dst.relative_to(ROOT)}  {args.size}x{args.size}  "
        f"{dst.stat().st_size / 1024:.1f} KB  图案占画布 {cover[0]:.0%}x{cover[1]:.0%}"
    )
    # 判显得小看的是**长边**：棋子是瘦高的，宽边天生填不满，那不是问题
    if max(cover) < 0.8:
        print("  ⚠ 图案长边占画布不足 80%，标签页上会显得很小", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
