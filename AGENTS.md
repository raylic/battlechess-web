# AGENTS.md · 皇家战棋 Web

原作 [MemoryD/BattleChess](https://github.com/MemoryD/BattleChess)（Python + pygame）的 Web 复刻：
**规则内核逐行迁移，视图层重写为 React**。纯前端，无服务端 / 账号 / 积分。

**README.md（495 行）是本项目的主要设计文档**，规则细节、AI 消融实验、性能取舍、踩坑记录都在里面。
本文件只放「动手前必须知道的东西」：命令、分层、硬约束、已知陷阱。

---

## 1. 命令

```sh
pnpm install
pnpm dev       # http://localhost:5173/battlechess-web/   ← base 是 /battlechess-web/，根路径会 302
pnpm test      # vitest run，23 文件 / 206 用例，约 36s（selfplay 压测占大头）
pnpm typecheck # tsc -b
pnpm lint      # oxlint，当前 8 条 warning、0 error（基线，别当成新问题）
pnpm build     # tsc -b && vite build → dist/（约 1.3 MB）
```

- **测试 / 构建都显式钉 `NODE_ENV`**（`package.json` 脚本里），因为有些 shell 导出了
  `NODE_ENV=production`，那会让 React 解析到生产构建、`React.act` 不存在、RTL 全线报错。不要去掉。
- `pnpm assets` 会把上游原图**直接覆盖** `public/assets/` 里流水线产出的成品，先看 ASSETS.md 再跑。

### 单跑一个测试

```sh
pnpm exec vitest run src/core/rules.test.ts
pnpm exec vitest run -t "判和"
```

### 不在 `pnpm test` 里的真浏览器自检（改了视图层就值得跑）

```sh
pnpm dev  &  pnpm click:check                  # Chrome headless + CDP，真实鼠标命中测试
pnpm build && pnpm preview
pnpm pwa:check "http://localhost:4173/battlechess-web/?mode=hotseat&seed=42"  # 竖屏遮罩 / manifest / SW
```

它们守的是 jsdom **结构性看不到**的问题：`fireEvent.click` 绕过命中测试（覆盖层盖住棋盘在单测里查不出来），
jsdom 没有媒体查询求值（竖屏遮罩显不显示断言不了）。两条都真实翻过车，见 README §6、§11。

### AI / 训练相关（离线，不进 CI）

```sh
pnpm exec tsx scripts/arena.ts --a search --b greedy --games 60   # 唯一裁判：谁更强
pnpm exec tsx scripts/check-parity.ts                             # TS 手写前向 ≡ PyTorch，必须过
pnpm exec tsx scripts/gen-data.ts                                 # 自对弈生成训练数据
```

训练侧在仓库外：`~/code/game/train`（Python + PyTorch）。
**自对弈是弱仪器**：同水平引擎对打大量和棋，60 局看不出 10 个点的差距，要拿共同参照物或拉到几百局。

---

## 2. 分层（改代码前先找到自己该动哪层）

```
core/authority.ts   持有真相的纯函数状态机；只接受 unknown action（边界显式校验），只下发投影
      │
transport/          local.ts（单机直连）/ worker.ts + worker/（SharedWorker，双窗口）
      │
core/visibility.ts  viewFor(state, side) —— 隐藏信息只在这一层发生
      │
game/               会话与交互策略（全部是纯函数或 hook）：useSession / useGame / useAi /
                    boardInteraction / hudText / geometry / gameLog / useFitScale / useEatenGhosts
      │
components/         纯展示：Board / Piece / Hud / StartScreen / ResultModal / Toast
```

```
src/core/       pieces(兵种+克制) rng board rules judge reduce visibility
                ai(贪心) search(默认老师) searchCore(make/unmake) nn(手写卷积) aiNet features authority
src/transport/  local.ts 单机； worker.ts + src/worker/authority.worker.ts 双窗口
src/game/       见上；netLoader.ts 是权重懒加载
scripts/        arena / check-parity / gen-data / review-log（TS）；fetch-assets / to-webp /
                split-wait / make-icon（py/sh）；click-check / pwa-check（CDP）
```

URL 参数：`?mode=ai|hotseat|dual`、`?side=red|blue`、`?seed=123`、`?ai=search|greedy|net`。
`?debug=1` 的真相面板**已被删除**。

---

## 3. 硬约束（不变量，破坏任何一条都算 bug）

1. **隐藏信息只允许发生在 `core/visibility.ts` 的 `viewFor()` 里。** 组件拿到的数据里就没有暗子身份，
   所以组件里不该出现"要不要隐藏"的判断。测试里编码了"双盲不可区分性"（打乱未翻开棋子的身份，
   两个视角的投影必须完全等价）。
2. **合法着法由权威算好随视角下发。** 组件不重复实现规则，也不能自己造合法着法。
3. **`core/` 零 DOM 依赖** —— 规则因此能在 node 环境里跑 1000 局自对弈。别在 core 里 import React 或 window。
4. **AI（含神经网络）只吃 `ViewState`。** 训练数据也走同一条投影路径，否则网络会依赖它线上拿不到的信息。
5. **`core/reduce.ts` 的 `applyAction` 是唯一能改状态的地方。** 畸形 action 一律返回 `rejected`，**不抛异常**。
6. **棋子位置 = 它在 `grid` 里的下标**，不存进 `Piece`（单一事实来源）。
7. **几何常量只在 `src/game/geometry.ts`**，CSS 通过 CSS 变量消费它，两边不许各写一份 88px。
8. **`JSX` 里写成字符串的 `src` 不会被 Vite 加 base 前缀**，必须用 `import.meta.env.BASE_URL`
   （见 `Hud.tsx` / `GameScreen.tsx` / `StartScreen.tsx`）；`public/` 下的 manifest 用相对路径。
9. **manifest 里不许写绝对路径**（`src/pwa.test.ts` 盯着这条），否则 `BASE_PATH=/` 构建会错。

---

## 4. 测试约定

- 默认环境是 **node**；组件测试文件头写 `// @vitest-environment jsdom`。
- `globals` 关闭，测试里显式 `import { test, expect } from 'vitest'`；RTL 的 cleanup 在 `test-setup.ts` 里接。
- **压测 / 自对弈循环里不要塞 `expect`**（vitest 的 expect 很重，几十万次会拖爆 5s 超时），只用 throw/if。
- 新增规则或结束条件 → 同时补 `core/*.test.ts`；新增交互策略 → 抽成纯函数放 `game/` 再测，
  不要写进组件事件处理器（这是原生版零测试的根源）。
- `src/core/test-helpers.ts` 提供紧凑摆棋记号（`'r0'` / `'b3*'` / `'.'`），仅在测试里用，已在覆盖率里排除。

---

## 5. 已知陷阱

- **覆盖层 `inset: 0` + DOM 顺序在 Board 之后 = 棋盘全点不动**，而 jsdom 完全查不出来。
  新加全屏层一律 `pointer-events: none`，并跑一次 `pnpm click:check`。
- **`--piece-z` 太小会让棋子下半身被格子盖住**（像素级问题只能看图确认）。
- **Service Worker 只在生产构建注册**（`src/registerSw.ts`）。改了 `public/sw.js` 的 `VERSION`
  只影响旧缓存清理，不影响正确性。
- **舞台写死 1000×650**，靠 `useFitScale` 等比缩放；竖屏靠 `index.html` 里的 `#rotate` 遮罩
  （`@media (orientation: portrait) and (pointer: coarse)`）兜底。改舞台尺寸要同时改几何与遮罩文案。
- **`pwa:check` 里桌面那两条必须跑在触摸模拟之前**：CDP 的 `setTouchEmulationEnabled(false)`
  不会干净还原 `pointer: coarse`。
- **浏览器跟人下（`useAi.think`）与训练/验收（`DEFAULT_SEARCH`）是两套参数**：前者 6 个世界，
  后者 8 个。改 AI 强度时别只改一处还以为两边都改了。
- 搜索类优化默认都要**在 `scripts/arena.ts` 上验收**才留；历史上 `ownThreatFull`、`splitQuiescenceBudget`
  都是"看起来更对、实测更弱"，开关与结论留在代码注释里，**别重试**。
- 对局记录（localStorage，上限 100 盘）只存「种子 + 动作序列」，整盘棋是确定性的，
  用 `createState(seed)` + 序列即可完整重放（含真相）。存真相反而更占地方。

---

## 6. 素材与文档

- **`ASSETS.md` 是素材的当前事实来源**（14 个文件、体积、每个文件的改造手段）。
  增删 `public/assets/` 里的文件要同步改它；`pnpm test` 里有"每个引用到的素材必须存在"的断言。
- 素材版权：棋子/头像含 **QQ 宠物 IP**，来自原作者。仓库公开只为托管试玩，**不得商用**；
  权利人要求时立即移除。代码 MIT。
- 改造只用**无损**手段（WebP 无损 / 拆图去重 / 抹重复文字）；量化试过，体积再降 40% 但肉眼变糊，已回退。

### README 有几处已过期（以代码与 ASSETS.md 为准）

| README 段落 | 现状 |
|---|---|
| §1 `?debug=1` / §3 架构图里的 `TruthPanel` | 面板与组件已删除（`src/transport/local.ts:20` 注释还留着旧说法） |
| §7 终局弹窗"⭐ 标记这局" | 已删除；只剩「确定」（回开始界面并换种子）+「导出对局记录」 |
| §9 `scripts/make-icons.py`、素材体积表 | 现为 `scripts/make-icon.py`；体积见 ASSETS.md |

改完功能后顺手把 README 对应段落更新，不要越攒越多。
