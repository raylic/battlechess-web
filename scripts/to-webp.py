#!/usr/bin/env python3
"""把 public/assets 里的 PNG 无损转成 WebP。

为什么值得：这批图是手绘渐变 + 精灵图，PNG 的 DEFLATE 压不动它们；同一份像素
用 WebP 无损重编码能小 14~35%（与已经用过这个做法的 begin.webp 一致）。
**不是量化**——转完解码出来的像素必须和原图逐字节相同，脚本会验，不一致就不换。

不转的：
  · icon-192.png —— favicon / apple-touch-icon / manifest 图标。
    favicon 用 WebP 在 Safari 和老浏览器上不可靠，apple-touch-icon 规范要求 PNG。

用法：
    python3 scripts/to-webp.py            # 转换 WANTED 列表里的文件
    python3 scripts/to-webp.py --dry-run  # 只报数字，不改文件
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

import numpy as np
from PIL import Image

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
ASSETS = ROOT / "public" / "assets"

# 转哪些。改这里之前先想想引用处（styles.css / 组件里的模板串）要不要跟着改。
WANTED = [
    "chess.png",
    "unopen.png",
    "button_mode.png",
    "button_giveup.png",
    "button_ok.png",
    "head_red.png",
    "head_blue.png",
]


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    before = after = 0
    changed: list[str] = []
    for name in WANTED:
        src = ASSETS / name
        if not src.exists():
            print(f"  跳过 {name}（不存在，可能已经转过了）")
            continue
        img = Image.open(src).convert("RGBA")
        dst = src.with_suffix(".webp")
        img.save(dst, "WEBP", lossless=True, quality=100, method=6)

        # 必须"看得见的像素"逐字节相同：这不是量化，只是换了个编码器。
        # 完全透明的像素 WebP 会把 RGB 清零（alpha=0 看不见，也正是省下体积的那部分），
        # 所以只对 alpha>0 的像素要求严格相等，alpha 通道本身必须整体一致。
        back = np.asarray(Image.open(dst).convert("RGBA"))
        orig = np.asarray(img)
        visible = orig[..., 3] > 0
        same = (
            back.shape == orig.shape
            and np.array_equal(back[..., 3], orig[..., 3])
            and np.array_equal(back[visible], orig[visible])
        )
        if not same:
            dst.unlink()
            print(f"  ✗ {name}：解码结果和原图不一致，已放弃", file=sys.stderr)
            return 1

        a, b = src.stat().st_size, dst.stat().st_size
        before += a
        after += b
        changed.append(name)
        print(f"  {name:<20} {a / 1024:7.1f} KB  →  {dst.name:<20} {b / 1024:7.1f} KB  ({(b - a) / a * 100:+.0f}%)")
        if args.dry_run:
            dst.unlink()

    if args.dry_run:
        print(f"\n（dry-run，未改动文件）合计 {before / 1024:.1f} KB → {after / 1024:.1f} KB")
        return 0

    for name in changed:
        (ASSETS / name).unlink()
    print(f"\n合计 {before / 1024:.1f} KB → {after / 1024:.1f} KB（{(after - before) / before * 100:+.0f}%，省 {(before - after) / 1024:.1f} KB）")
    print("⚠ 记得把引用处的扩展名一起改（styles.css、组件里的模板串）")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
