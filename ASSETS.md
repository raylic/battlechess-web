# 素材说明（`public/assets/`）

这套就是线上用的全部素材，**共 16 个文件、约 1004 KB**。
上游原图那套是 1834.9 KB（16 个），这里是把它们逐个改造后的成品。

| | 体积 |
|---|---|
| 上游原图 | 1834.9 KB |
| 现在 | **约 1004 KB（−45%）** |

改造只用无损手段（WebP 无损 / 拆图去重 / 删重复文件 / 抹重复文字），没有做调色板量化 ——
量化那版试过，体积能再降 40%，但画面肉眼可见变糊，已回退。

## 逐个说明

| 文件 | 体积 | 做法 |
|---|---|---|
| `begin.webp` | 267.4 K | 开始界面立绘。WebP 无损（原 `begin.png` 解码逐像素相同） |
| `chess.webp` | 152.5 K | 棋子精灵图 6 列（等级）× 2 行（上红下蓝）。WebP 无损，棋盘用它 |
| `bg.jpg` | 81.6 K | 背景。JPEG q92 progressive |
| `wait_panel.webp` | 58.0 K | 结算面板的共用底板。原素材是 1280×591 的两行精灵图，拆成「顶栏 + 面板」，四列下半部分像素完全一致（实测差异 0.00%），只存一份；面板里烤的正文是重复内容（`ResultModal` 另用 DOM 渲染结论文案），已抹掉 |
| `button_mode.webp` | 51.6 K | 模式按钮精灵图（文字烤在图里，含 hover 行） |
| `head_red.webp` | 45.7 K | 头像。金环内侧挖成透明、抹掉「昵称:」「积分:」两行 |
| `head_blue.webp` | 45.3 K | 同上（蓝色版） |
| `button_giveup.webp` | 44.1 K | 认输按钮（同 `button_mode` 的精灵图做法） |
| `wait_top_blue.webp` | 41.9 K | 结算顶栏·蓝胜 |
| `wait_top_draw.webp` | 41.6 K | 结算顶栏·平局 |
| `wait_top_red.webp` | 41.5 K | 结算顶栏·红胜 |
| **`chess-mini.webp`** | **41.6 K** | **侧栏面板用的迷你棋子**，6 列 × 2 行、每格 48×48。由 `chess.webp` 逐格裁紧后按同一高度重排（面板只显示 28px，直接用棋盘那张的话每颗只有 5~6px）。`scripts/make-mini-sheet.py` 生成 |
| `unopen.webp` | 25.0 K | 棋子背面（棋盘上的暗子） |
| `icon-192.png` | 9.7 K | PWA 图标。**全站唯一一张** —— favicon、apple-touch-icon、manifest 都指向它 |
| **`back-mini.webp`** | **3.3 K** | **侧栏面板用的暗面**，48×48，裁掉原图四周的半透明空边。同上脚本生成 |
| `button_ok.webp` | 17.2 K | 确定按钮 |

拆图的切线（y=122）是量出来的，不是估的，见 `scripts/split-wait.py` 头部的逐行差异表。

## 相关脚本

| 脚本 | 作用 |
|---|---|
| `scripts/make-mini-sheet.py` | 生成面板用的 `chess-mini.webp` / `back-mini.webp`（Pillow，不参与构建也不参与测试） |
| `scripts/split-wait.py` | 把结算图拆成「每行 N 张顶栏 + 1 张共用面板」，并抹掉面板里的重复文字。源图是上游那份 1280×591 的两行原图（不在版本库里，路径 `../assets-rebuild/assets/assets-1x/wait.png`） |
| `scripts/make-icon.py` | 从上游立绘生成 PWA 图标（`icon-192.png`） |
| `scripts/fetch-assets.sh` | 从上游仓库捞**原图**做参照，落到 `assets-src/`（已 gitignore） —— **不要直接覆盖 `public/assets/`**，这里放的是改造后的成品 |

## 已删掉的素材

| 删掉 | 原因 |
|---|---|
| `time.png`（12.1 K） | 就是一块圆角铭牌，改用 CSS 画（侧栏面板） |
| `trans_bg`（约 6 K） | 80% 不透明的纯黑图，内容为零，改用 `background: rgba(0,0,0,.8)` |
| `icon.ico` / `icon-512` / `icon-maskable-512` / `apple-touch-icon` | 图标统一成一张 `icon-192.png` |
| `wait.png`（485.2 K） | 拆成 3 张顶栏 + 1 张共用面板，见上 |

> 面板的"剩余子数"从数字换成 5 行棋子后，**没有新增素材负担**：只是把已有的 `chess.webp` 重排了一份 45 KB 的小图。
