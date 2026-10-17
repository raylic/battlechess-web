#!/usr/bin/env bash
# 从原仓库拉取美术素材 —— 只拷本作真正用到的那几张。
#
# 原仓库 battlechess/src/image/ 里还有登录 / 匹配 / 取消等界面的图，本作没有实现那些界面，
# 所以不拷：public/assets 保持"每个文件都被引用"。
#
# ⚠ public/assets 里已经是从上游重新做过的成品（WebP / 裁切 / 去字），
#   本脚本只负责把**上游原图**捞下来做参照，别直接覆盖 public/assets ——
#   落到 assets-src/（不入库、不参与构建）。
#
# 视图里新增素材时，记得同时把它加进下面的清单 —— 漏了会被 layout.test.ts 的
# "引用的素材都存在" 拦下（pnpm test 直接红），不会静默漏图。
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
REPO="https://github.com/MemoryD/BattleChess"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# 清单：文件名            用在哪
WANTED=(
  bg.jpg                 # 全局 / 开始界面背景
  begin.png              # 开始界面立绘
  chess.png              # 棋子精灵图（6 列等级 × 2 行红蓝）
  unopen.png             # 未翻开棋子的背面
  head_red.png           # 左侧红方头像
  head_blue.png          # 右侧蓝方头像
  time.png               # 双方剩余子数面板
  button_mode.png        # 开始界面两个模式按钮
  button_giveup.png      # 认输按钮
  button_ok.png          # 结算面板 OK
  wait.png               # 结算面板（4 列 × 2 行：红胜/蓝胜/和局）
  icon.ico               # favicon
)

echo "→ 克隆原仓库（浅克隆）..."
git clone --quiet --depth 1 "$REPO" "$TMP/repo"

mkdir -p "$ROOT/assets-src"
for f in "${WANTED[@]}"; do
  cp "$TMP/repo/battlechess/src/image/$f" "$ROOT/assets-src/$f"
done

echo "→ 已复制 ${#WANTED[@]} 个上游原图到 assets-src/（不要直接覆盖 public/assets）"
