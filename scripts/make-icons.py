#!/usr/bin/env python3
"""从 begin.png 生成 PWA 图标（PNG）。

为什么需要它：原作的图标只有 `icon.ico`（ICO 格式）。
但 **PWA 装到主屏 / 桌面要求 PNG**（192 与 512 两个尺寸是 Chrome 的安装门槛），
而 **iOS 完全不认 ICO**，只认 `apple-touch-icon`（PNG）。

裁剪框沿用现有 `icon.ico` 的那一块（1x 设计坐标 x400~600 / y50~250）——
两个图标同源，用户不会觉得"图标换了"。这里用 4x 派生图当源再降采样，
而不是放大 1x：1x 的 200px 拉到 512px 会糊。

用法：
    python3 scripts/make-icons.py                  # 默认读 ../assets-rebuild/...
    python3 scripts/make-icons.py <begin.png 路径>

依赖 Pillow（只在重新生成图标时需要，不参与构建、不参与测试）。
"""

from __future__ import annotations

import sys
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
DEFAULT_SRC = ROOT.parent / "assets-rebuild" / "assets" / "assets-4x" / "begin.png"
OUT = ROOT / "public" / "assets"

# 和现有 icon.ico 完全相同的裁剪框（1x 设计坐标，200x200）
BOX_1X = (400, 50, 600, 250)

# 应用背景色，和 index.html 的 theme-color / manifest 的 background_color 一致。
# 需要"不透明背景"的两处用它：iOS 会把 apple-touch-icon 的透明像素渲成黑色，
# 而 maskable 图标会被系统裁成圆形/方形，得自己铺底。
BG = (13, 17, 23, 255)  # #0d1117

# 各尺寸的"图案占画布比例"。透明背景的普通图标直接满铺；
# 需要铺底的两种要留边：iOS 会加圆角、Android 的 maskable 安全区是中心 80% 圆。
JOBS = [
    # (文件名, 边长, 是否铺底, 图案占比)
    ("icon-192.png", 192, False, 1.0),
    ("icon-512.png", 512, False, 1.0),
    ("apple-touch-icon.png", 180, True, 0.88),
    ("icon-maskable-512.png", 512, True, 0.78),
]


def render(art: Image.Image, size: int, flatten: bool, ratio: float) -> Image.Image:
    """把裁剪出的图案渲染成一张 size×size 的图标。"""
    if ratio >= 1.0 and not flatten:
        return art.resize((size, size), Image.LANCZOS)

    inner = round(size * ratio)
    scaled = art.resize((inner, inner), Image.LANCZOS)
    canvas = Image.new("RGBA", (size, size), BG if flatten else (0, 0, 0, 0))
    off = (size - inner) // 2
    canvas.alpha_composite(scaled, (off, off))
    return canvas


def main() -> int:
    src = Path(sys.argv[1]) if len(sys.argv) > 1 else DEFAULT_SRC
    if not src.exists():
        print(f"找不到源图：{src}", file=sys.stderr)
        print("（assets-rebuild/ 不在版本库里，从别处拷一张 begin.png 进来，或用参数指定路径）", file=sys.stderr)
        return 1

    source = Image.open(src).convert("RGBA")
    # 裁剪框是 1x 坐标，按源图与 1000x650 设计稿的倍率换算 —— 免得换 2x/4x 源图时对不上
    factor = source.width // 1000
    box = tuple(v * factor for v in BOX_1X)
    if factor < 2:
        print(f"警告：源图只有 {source.width}px 宽（{factor}x），生成的 512 图标会糊", file=sys.stderr)
    art = source.crop(box)
    print(f"源图 {source.width}x{source.height}（{factor}x），裁剪 {box} → {art.width}x{art.height}")

    OUT.mkdir(parents=True, exist_ok=True)
    for name, size, flatten, ratio in JOBS:
        icon = render(art, size, flatten, ratio)
        # 量化到 256 色调色板：这是扁色卡通，肉眼几乎无差，体积却只有 1/5
        # （512 图标 411 KB → 67 KB，整套 810 KB → 150 KB）。
        # PWA 图标不在首屏关键路径上，但也没理由让它肥。
        # FASTOCTREE 是唯一能保住 alpha 通道的量化方式（另两种会把透明压平）。
        icon = icon.quantize(colors=256, method=Image.FASTOCTREE)
        icon.save(OUT / name, "PNG", optimize=True)
        (OUT / name).chmod(0o644)
        kb = (OUT / name).stat().st_size / 1024
        print(f"  {name:24s} {size}x{size}  铺底={str(flatten):5s} 图案={ratio:.0%}  {kb:6.1f} KB")

    # 这份 ICO 是给浏览器标签页 / 老环境用的，和 PWA 图标同源。
    # 它自己就带 256 色限制，PIL 会处理，不用手动量化。
    ico_sizes = [(s, s) for s in (16, 32, 48, 64, 128, 256)]
    art.resize((256, 256), Image.LANCZOS).save(OUT / "icon.ico", sizes=ico_sizes)
    print(f"  {'icon.ico':24s} 16/32/48/64/128/256        {(OUT / 'icon.ico').stat().st_size / 1024:.1f} KB")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
