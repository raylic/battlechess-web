#!/usr/bin/env python3
"""把上游的两行 wait 图拆成「每行 N 张顶栏 + 1 张共用面板」。

源图的布局（1280x591，4 列 x 2 行，cell 320x295.5）：

    上行 y=0..295    胜利 / 失败 / 平局 / 掉线   （带积分，联网口径）
    下行 y=296..590  红胜 / 蓝胜 / 平局 / 掉线   （本机口径，不带积分）

为什么要拆：每一行的四列，上半部分（王冠颜色 + 标题字）各画各的，下半部分的
面板（米色底 + 青边框 + 两侧桂冠）是完全一样的，唯一的差别是烤在面板里的文字。
而面板里那些文案在本作里是重复内容 —— ResultModal 已经在面板下方用 DOM 渲染
`resultWhy()`（如「红方获胜 · 吃光了对方的全部棋子」），面板里的句子从没被用过，
所以直接抹掉。拆开后每行只需要「每列一张顶栏 + 一张共用面板」。

实测差异（行内各列两两比对，x=55..265，逐 15 行的差异像素占比）：

    下行（红胜/蓝胜/平局）
        y= 17.. 91   50~87%   ← 王冠 + 标题，各画各的
        y=107..121    2.25%
        y=122..166    0.00%   ← 完全一致
        y=167..196   23~75%   ← 正文红字
        y=197..294    0.00%   ← 完全一致

    上行（胜利/失败）
        y=  0.. 89   57~90%   ← 王冠 + 标题
        y=105..149    0.06~0.76%
        y=150..164   10.76%
        y=165..179   72.48%   ← 正文第一行
        y=180..194    0.32%
        y=195..209   23.97%   ← 积分行
        y=225..295    0~2%     ← 完全一致

两行都切在 CUT_Y=122。上行的面板与下行的面板**不是同一张**（星形纹理不同，
对齐后仍有约 15% 像素不一致），所以两行各出一张面板。

用法：
    python3 scripts/split-wait.py                  # 两行都切
    python3 scripts/split-wait.py --row top        # 只切上行（胜利/失败）
    python3 scripts/split-wait.py --row bottom
    python3 scripts/split-wait.py --src 某图.png --dst DIR

源图是上游那份两行原图（assets-rebuild/assets/assets-1x/wait.png，不入库）。
仓库里的 public/assets 只有拆好的成品，没有这张两行原图 —— 找不到就直接报错。
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

import numpy as np
from PIL import Image
from scipy import ndimage

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent

CELL_W = 320
CELL_H = 295
CUT_Y = 122  # 见模块头部的实测表
SAVE_KW: dict = {"lossless": True, "quality": 100, "method": 6}  # WebP 无损，比 PNG 小 ~23%

# 两行的切法。row=(起, 止) 是源图里这一行的 y 范围
ROWS = {
    "top": {
        "row": (0, 296),
        "label": "上行（联网口径，带积分）",
        "tops": [
            ("wait_top_win.webp", "胜利", 0),
            ("wait_top_lose.webp", "失败", 1),
        ],
        # 平局、掉线这一行不做（本作用不到；要的话在这里加一行即可）
        # 向上行复用下行那张共用面板：两行的面板只差星纹相位（对齐后约 15% 像素不同），
        # 肉眼分辨不出，没必要为它多存 55 KB。要单独出一张就把这里改成文件名。
        "panel": None,
        "panel_col": 0,
        # 实测文字带（面板内坐标）：正文 y=36..60、积分行 y=68..95，两边各留 5 行
        "bands": None,
    },
    "bottom": {
        "row": (296, 591),
        "label": "下行（本机口径）",
        "tops": [
            ("wait_top_red.webp", "红胜", 0),
            ("wait_top_blue.webp", "蓝胜", 1),
            ("wait_top_draw.webp", "平局", 2),
            ("wait_top_offline.webp", "掉线", 3),
        ],
        "panel": "wait_panel.webp",
        "panel_col": 0,
        # 实测文字带（面板内坐标）：正文 y=43..67，两边各留 5 行
        "bands": [(38, 72)],
    },
}

# 面板里文字可能出现的范围（面板内坐标）。
# 上边 y<32 是顶部那个卷曲装饰、下边 y>=130 是底部那条金线 —— 两处都是暖色，
# 放宽就会连它们一起抹掉（踩过：整块面板被抹出两道白带）。
TEXT_X = (45, 275)
TEXT_Y = (32, 130)
# 取纹理用的干净横条：两条文字带都在它上面，且这段实测各列差异 0.00%
CLEAN_STRIP = (96, 152)


def text_mask(panel: np.ndarray, thr: float = 0.15) -> np.ndarray:
    """找出面板里烤的文字（含外描边的浅红一并收）。

    只用"偏红"这一条判据，行带由调用方按连通的行自动分段 —— 上行有两行字
    （正文 + 积分），下行只有一行，写死行带会漏。
    """
    r, g, b = panel[..., 0], panel[..., 1], panel[..., 2]
    # 这里只负责"定位文字带"（哪几行有字），不负责精确勾边 —— 抹除时整条横带都会换掉。
    # 阈值 0.15：干净区（含星形纹理）的 r-g 最大 0.078，字芯 0.3~0.85，取 0.15 刚好分开。
    # 不能取低（0.05 会把星纹算进来，行带糊成一片），也不能用强红配精确勾边 ——
    # 外晕的 r-g 只有 0.01~0.05，挑不干净，1 倍下会留一层能读出字的残影。
    m = ((r - g) > thr) & ((r - b) > 0.06) & (r > 0.5) & (panel[..., 3] > 0.5)
    keep = np.zeros_like(m)
    keep[TEXT_Y[0] : TEXT_Y[1], TEXT_X[0] : TEXT_X[1]] = True
    return m & keep


def text_bands(mask: np.ndarray, gap: int = 4) -> list[tuple[int, int]]:
    """把红像素所在的行聚成若干条横带，上下各放宽 gap 行（吃进抗锯齿）。"""
    hits = mask.sum(axis=1)
    rows = np.where(hits >= 3)[0]
    if len(rows) == 0:
        return []
    bands: list[list[int]] = [[rows[0], rows[0]]]
    for y in rows[1:]:
        if y - bands[-1][1] <= gap:
            bands[-1][1] = y
        else:
            bands.append([y, y])
    h = mask.shape[0]
    return [(max(0, a - gap), min(h, b + gap + 1)) for a, b in bands]


def erase_bands(panel: np.ndarray, bands: list[tuple[int, int]]) -> np.ndarray:
    """把每条文字带整块换成下方干净条的纹理。

    为什么按整块而不是按像素挑颜色：字的浅粉外晕 r-g 只有 0.01~0.05，
    但整片字形结构人眼照样看得见 —— 按颜色挑像素一定会漏，1 倍下就是一层残影。
    所以只用颜色来"定位"文字带（哪几行有字），抹除时整条横带换掉。
    纹理取自下方干净条，保留星形花纹；纯色平铺会让那一片"没有星星"，也看得出来。
    """
    out = panel.copy()
    h, w = panel.shape[:2]
    src0, src1 = CLEAN_STRIP[0], min(CLEAN_STRIP[1], h)
    span = max(1, src1 - src0)
    for a, b in bands:
        for y in range(a, b):
            # 三角波映射：纹理条用完之后镜像折返，接头处不会跳变
            # （直接取模绕回去会在接头留一道横向接缝 —— 踩过）
            d = (y - a) % (2 * span)
            sy = src0 + (d if d < span else 2 * span - 1 - d)
            sel = panel[y, TEXT_X[0] : TEXT_X[1], 3] > 0.9  # 只换不透明的面板内部
            out[y, TEXT_X[0] : TEXT_X[1]][sel] = panel[sy, TEXT_X[0] : TEXT_X[1]][sel]
    return out


def erase(panel: np.ndarray, mask: np.ndarray) -> np.ndarray:
    """用「干净区的真实纹理」填掉 mask 处，并按行校正色调。

    两种朴素做法都不行：
      · 按左右最近像素插值 —— 把星形纹理横向拖成一道道拖影；
      · 按行取中位色平铺 —— 平是平了，但那一片星星没了，1 倍下能看出比周围"干净"。
    改成从文字带下方的干净条（y=100..130）取像素，按 (y - 起点) mod 条高 映射过去，
    再减去源行中位色、加上目标行中位色，这样纹理真实、色调也对得上。
    """
    out = panel.copy()
    h, w = panel.shape[:2]
    cy0, cy1 = 100, min(130, h)          # 干净纹理条：两条文字带都在它上面
    if cy1 - cy0 < 4:
        cy0, cy1 = max(0, h - 30), h
    span = cy1 - cy0

    def tone(row: np.ndarray) -> np.ndarray | None:
        clean = row[:, 3] > 0.95
        return np.median(row[clean, :3], axis=0) if clean.sum() > 50 else None

    for y in range(h):
        row = mask[y]
        if not row.any():
            continue
        dst_tone = tone(panel[y])
        sy = cy0 + ((y - cy0) % span)
        src_tone = tone(panel[sy])
        for x in np.where(row)[0]:
            v = panel[sy, x].copy()
            if dst_tone is not None and src_tone is not None:
                v[:3] = np.clip(v[:3] - src_tone + dst_tone, 0.0, 1.0)
            out[y, x] = v
    return out


def default_src() -> Path:
    return ROOT.parent / "assets-rebuild/assets/assets-1x/wait.png"


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--src", default=None, help="两行原图；缺省找上游那份")
    ap.add_argument("--dst", default=str(ROOT / "public/assets"))
    ap.add_argument("--row", choices=["top", "bottom", "both"], default="both")
    args = ap.parse_args()

    src = Path(args.src) if args.src else default_src()
    dst = Path(args.dst)
    if not src.exists():
        print(f"找不到源图：{src}", file=sys.stderr)
        return 1
    dst.mkdir(parents=True, exist_ok=True)

    arr = np.asarray(Image.open(src).convert("RGBA")).astype(np.float32) / 255.0
    h, w = arr.shape[:2]
    print(f"源图 {src.name}  {w}x{h}  ->  {dst}")
    if w != CELL_W * 4:
        print(f"  宽度应为 {CELL_W * 4}", file=sys.stderr)
        return 1

    rows = ["top", "bottom"] if args.row == "both" else [args.row]
    total = 0
    for key in rows:
        job = ROWS[key]
        y0, y1 = job["row"]
        if h < y1:  # 单行源图只能切下行
            if key == "top":
                print(f"  跳过{job['label']}：源图只有 {h} 行高，没有这一行")
                continue
            y0, y1 = 0, h
        row = arr[y0:y1]
        print(f"\n{job['label']}  y={y0}..{y1 - 1}")

        cols = [row[:, i * CELL_W : (i + 1) * CELL_W] for i in range(4)]
        for name, label, idx in job["tops"]:
            top = (cols[idx][:CUT_Y] * 255).astype(np.uint8)
            p = dst / name
            Image.fromarray(top).save(p, "WEBP", **SAVE_KW)
            total += p.stat().st_size
            print(f"  {name:<24} {CELL_W}x{CUT_Y}  {p.stat().st_size / 1024:7.1f} KB  ({label})")

        if job["panel"] is None:
            print("    面板复用 wait_panel.webp，不单独生成")
            continue

        panel = cols[job["panel_col"]][CUT_Y:]
        bands = job["bands"] or []
        # 自检：按颜色检测出来的行带应该落在实测带附近，源图换了就会报出来
        detected = text_bands(text_mask(panel), gap=18)
        for a, b in bands:
            print(f"    文字带（面板内坐标） y={a}..{b - 1}  （检测到 {detected}）")
        panel = erase_bands(panel, bands)
        p = dst / job["panel"]
        Image.fromarray((panel * 255).astype(np.uint8)).save(p, "WEBP", **SAVE_KW)
        total += p.stat().st_size
        print(f"  {job['panel']:<24} {CELL_W}x{CELL_H - CUT_Y}  {p.stat().st_size / 1024:7.1f} KB  (共用面板，已去字)")

    print(f"\n合计 {total / 1024:.1f} KB")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
