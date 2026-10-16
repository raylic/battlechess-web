# 皇家战棋 · Web（Vite + React + TS）

原作：[MemoryD/BattleChess](https://github.com/MemoryD/BattleChess)（Python + pygame + twisted，2019）。
本仓库是它的 Web 复刻：**规则内核逐行迁移，视图层重写为 React**。没有服务端、没有账号、没有积分。

本目录**自给自足**：`package.json` / `pnpm-lock.yaml` / `node_modules` / `public/assets` / 各类配置都在自己目录内，不 import 任何外部文件，也没有 workspace。实测把整个目录拷到仓库外，`pnpm install && pnpm test && pnpm build` 全过。

---

## 1. 怎么跑

```sh
cd battlechess-web
pnpm install
pnpm dev            # http://localhost:5173/battlechess-web/
pnpm test           # vitest run
pnpm coverage       # 覆盖率报告
pnpm build          # tsc -b && vite build
pnpm assets         # 从原仓库重新拉取美术素材（只拷用到的那 12 张）⚠️ 见 §8
```

### URL 参数

| 参数 | 作用 |
|---|---|
| `?mode=ai` | 直接开人机对局 |
| `?mode=hotseat` | 直接开单机热座（一个人控制两方） |
| `?mode=dual&side=blue&seed=123` | 双窗口：以蓝方视角加入 123 号棋局 |
| `?seed=123` | 指定棋盘种子（同种子 = 同一盘棋） |
| `?debug=1` | 右下角显示"真面目"面板（只有单机模式拿得到真相） |

---

## 2. 怎么玩

| 开始界面按钮 | 实际模式 | 说明 |
|---|---|---|
| 本地对战 | **单人 vs 电脑** | 你执红先手；AI 只看得到蓝方视角，和你受同样的信息限制 |
| 联网对战 | **双人 · 两个视角** | 点一下自动再开一个窗口：本窗口红方、新窗口蓝方，各看各的视角，只能在自己的回合操作 |

> 双窗口基于 `SharedWorker`（Chrome / Firefox / Safari 16.4+）。若浏览器拦截弹窗，手动打开开始界面显示的 URL：`?mode=dual&side=blue&seed=<种子>`。

### 规则

- 棋盘 6×6，**36 格开局全部摆满、全部背面朝上**。背面棋子红蓝共用一张图：**翻之前谁也不知道它是谁的**（双盲）。
- 每方 18 子：国王 1、将军 1、骑士 2、弓箭手 2、禁卫军 4、刺客 8。等级越小越强。
- 轮到你时**二选一**（各算一步）：① 翻开任意一张背面棋子（包括对方的）；② 移动自己已翻开的棋子，上下左右**走一格**，目标是空格或可吃的敌子。
- 吃子：目标必须已翻开且是敌方；`自己等级 <= 对方等级` 即可吃。**刺客能吃国王，国王吃不了刺客。**
- 结束：一方被吃光 / 双方各剩 1 子比大小 / 连续 30 步无吃子无翻棋判和 / 认输（需走过 20 步）。

---

## 3. 架构

```
authority（持有真相的纯函数状态机，core/authority.ts）
   │  只接受 action（类型是 unknown，边界处显式校验），只发出 state(已按视角投影) + reject
   ▼
transport（local 直连 / SharedWorker；将来换 WebSocket 不改规则与视图）
   ▼
view:red / view:blue（各自只有 viewFor(side) 的投影）
   ▼
React 组件（纯展示 + 纯交互策略，不含规则）
```

```
src/
├── core/                纯逻辑，零 DOM 依赖，跑在 node 环境下
│   ├── pieces.ts        兵种、每方数量、克制矩阵（含刺客/国王特例）
│   ├── rng.ts           mulberry32 种子随机
│   ├── board.ts         36 子洗牌落位（双方数量严格对称）
│   ├── rules.ts         legalActions / movesFrom
│   ├── judge.ts         四条结束条件 + stalemate 兜底
│   ├── reduce.ts        applyAction：唯一能改状态的地方（action: unknown）
│   ├── visibility.ts    viewFor(state, side)：隐藏信息只在这一层发生
│   ├── ai.ts            简易 AI（只用 ViewState，绝不偷看真相）
│   ├── authority.ts     权威：持有真相、校验回合、下发投影
│   └── test-helpers.ts  紧凑摆棋记号（'r0' / 'b3*' / '.'），仅测试用
├── transport/           local.ts（单机）/ worker.ts（SharedWorker）
├── worker/              authority.worker.ts
├── game/
│   ├── useSession.ts    会话生命周期：建会话 / 回开始界面 / 再来一局
│   ├── useGame.ts       订阅 client → view / toast
│   ├── useAi.ts         AI 侧 client + 思考定时器
│   ├── useEatenGhosts.ts 被吃棋子的淡出幽灵
│   ├── useFitScale.ts   整个 1000x650 舞台按视口等比缩放
│   ├── geometry.ts      棋盘几何常量（CSS 变量的单一事实来源）
│   ├── boardInteraction.ts 点击策略 + 高亮（纯函数）
│   └── hudText.ts       HUD 文案 + 结算面板映射（纯函数）
└── components/          Board / Piece / Hud / StartScreen / ResultModal / Toast / TruthPanel
```

### 不变量

- **隐藏信息只发生在 `visibility.ts` 一个函数里。** 组件没有"要不要隐藏"的判断 —— 它拿到的数据里就没有暗子身份。
- **合法着法由权威算好随视角下发**，组件不重复实现规则，也不能自己造合法着法。
- **`core/` 不 import 任何 DOM** → 规则可以在 node 环境里跑 1000 局自对弈。

### 相对原生版，React 化时做的几处结构改动

| 改动 | 为什么 |
|---|---|
| `dire`（棋子朝向）从 UI 挪回核心状态 | 原版存在 `boardView` 的私有 Map 里；挪进 `Piece` 后组件彻底无状态，且朝向也能被规则测试覆盖 |
| 点击策略抽成 `resolveClick()` 纯函数 | 原来埋在 `handleClick` 里，是"不是自己回合/终局后不能操作"两条守卫**零测试**的根源 |
| HUD 文案与结算面板映射抽成纯函数 | "赢了显示失败""按钮该亮不亮"这类问题现在能被单测钉死 |
| 被吃棋子的淡出改成 `useEatenGhosts` | React 里棋子消失会立刻卸载，淡出必须显式记住"刚消失的那些" |
| 几何常量集中在 `geometry.ts` 并写入 CSS 变量 | CSS 与 JS 不会各写一份 88px |

---

## 4. 有意偏离原版的地方（4 处，都可以改回来）

| # | 原版行为 | 这里 | 理由 |
|---|---|---|---|
| 1 | 残局同级时**判红胜**（代码先算 `red.eat(blue)`） | **判和棋** | 原版是执行顺序带来的不对称，不是规则 |
| 2 | 某方完全无子可动时**无限空转** | **判和棋**（`stalemate`） | 单机没有计时规则，不兜底会卡死 |
| 3 | 终局仍扣着未翻开的棋子 | **终局全亮** | 当复盘用，此时无信息可藏 |
| 4 | 20 秒/步、3 次超时判负 | **不做** | 本期无真人实时对手 |

另外 AI 加了一条"无子可吃时朝最近敌子靠拢"的启发式：没有它时 AI 会在残局和对手随机游走，**92% 的对局撞上 30 步和棋规则**；加上之后降到 ~34%。

---

## 5. 双盲口径

原版是**双盲**（`unopen.png` 红蓝共用一张），本期照此实现。必然结果：**两个视角的信息完全对称**，`viewFor('red')` 与 `viewFor('blue')` 只差 `you` 和 `legal`（谁能操作）—— 这是玩法固有性质，测试里专门编码了这条。

`visibility.ts` 里留了另一个口径 `OWN_KNOWN`（自己的暗子自己可见），只差一个常量：

```ts
export const DEFAULT_POLICY: Policy = POLICY.OWN_KNOWN;
```

---

## 6. 测试

`pnpm test`（vitest）。分四层：

| 层 | 文件 | 覆盖 |
|---|---|---|
| 规则内核 | `core/rules` `core/judge` `core/reduce` | 克制矩阵 36 种组合全枚举、棋盘对称性与种子可复现、走子/吃子/翻棋边界、四条结束条件、**畸形 action 一律 rejected 不抛异常** |
| 隐藏信息 | `core/visibility` | **双盲不可区分性**：只打乱未翻开棋子的身份，两个视角的投影必须完全等价（最强的"不泄漏"断言）；口径开关；投影是纯数据 |
| 压测 | `core/selfplay` | 随机 300 局 + AI 自对弈 1000 局全部收敛、四类结束条件都被走到、同 seed 完全可复现 |
| 应用层 | `game/*` `components/*` `App.test.tsx` `layout.test.ts` | 点击策略与两条守卫、HUD 文案与结算面板映射、幽灵淡出、会话拆卸（退订真的生效）、组件渲染与交互、**App 级人机对局端到端**、几何投影验算、素材存在性、**覆盖层不得拦截棋盘点击**、**棋子不得被棋盘平面裁切** |

规则内核测试跑在 node 环境（快），组件测试用 `// @vitest-environment jsdom` 标注。

### 真浏览器点击自检（不在 `pnpm test` 里）

```sh
pnpm dev            # 另开一个终端
pnpm click:check    # Chrome headless + CDP，派发真实鼠标事件
```

它守的是 jsdom **结构性覆盖不到**的一类问题：`fireEvent.click` 是直接派发到目标元素的，绕开了浏览器的命中测试 —— 于是"有一层东西盖在棋盘上方"在单测里完全看不出来，真机上却一个子都点不动（真实翻过车：`#heads` / `#controls` 是 `inset:0` 铺满舞台、DOM 顺序又排在 Board 之后，接管了棋盘上的全部点击）。脚本会真实点击并断言翻棋 / 选中 / 吃子走子 / 认输按钮，另外做一组 A/B 对照：把覆盖层的 `pointer-events` 改回 `auto` 就能复现"点不动"。

需要本机有 Chrome / Chromium；没有就跳过（退出码 2 并提示）。

---

## 7. 已知限制

- **纯前端防不住作弊**：真相 state 就在浏览器内存里，devtools 可见。双窗口模式把门槛抬高一档（真相在 SharedWorker 里），但不是安全边界。
- 双窗口要求同浏览器同源且支持 `SharedWorker`；不支持时自动退回单机热座。
- 不做计时/超时判负，对局可以无限思考。
- AI 是一步贪心，不会算两步以上。
- 像素级效果（透视角度、棋子重叠/裁切、字重）只能靠眼睛确认。`pnpm click:check` 能把"点击能不能落到棋子上"自动化，但"画面对不对"得看图 —— 本次两个真实 bug（覆盖层吃掉棋盘点击、`--piece-z` 太小导致棋子下半身被格子盖住）都是靠它 + Chrome 截图发现的。

---

## 8. 素材与许可

- 代码：MIT（与原作一致）。
- 美术素材（`public/assets/*`）来自原作仓库，由原作者加工，其中棋子/头像含 **QQ 宠物 IP**，版权归原作者与相关权利人。本仓库公开**仅为了托管 GitHub Pages 试玩**，不是为了推广或分发这些素材，也**不得商用**；若权利人提出要求，会立即移除。
- 重新拉取素材：`pnpm assets`。脚本只拷本作**真正用到的那 12 张** —— 原仓库里登录 / 匹配 / 取消等界面的图本作没有实现，不拷，所以 `public/assets` 一直是“每个文件都被引用”。
  ⚠️ 这个脚本是把上游原图**直接覆盖进 `public/assets/`**。但 `public/assets/` 现在装的是流水线产出的版本（去掉了边缘杂色的 1x、`begin.png` 抹掉了原作的纪念文字、`wait.png` 裁成了单行），跑一次 `pnpm assets` 会把它们全部冲回原样。要用请先确认。

---

## 9. 部署与缓存

### base path

本站按 **GitHub Pages 项目页**（`https://<user>.github.io/battlechess-web/`）部署，所以 `vite.config.ts` 里配了：

```ts
base: process.env.BASE_PATH ?? '/battlechess-web/'
```

- **`base` 对 dev server 同样生效** —— 本地地址是 `http://localhost:5173/battlechess-web/`（访问根路径会 302 跳过去，所以旧书签还能用）。开发与生产同路径，base 写错在本地就能发现。
- Vite 会自动给 `index.html` 和 CSS 里的 `url(...)` 加前缀；但 **JSX 里写成字符串的 `src` 不会**，那几处必须自己用 `import.meta.env.BASE_URL`（见 `Hud.tsx` / `GameScreen.tsx` / `StartScreen.tsx`）。
- 改传到 `<user>.github.io` 用户主页或绑自定义域名时，把 base 改回 `/`（或用 `BASE_PATH=/ pnpm build`）。

### 客户端缓存（Service Worker）

GitHub Pages **不允许自定义响应头** —— 全站固定 `Cache-Control: max-age=600`。所以那 12 张不带内容 hash 的素材每 10 分钟就要重新校验一次，换了内容还最长吃 10 分钟旧图。`public/sw.js` 是 Pages 上唯一能真正控制客户端缓存的机制：

- 导航请求（HTML）→ **网络优先**，失败回退缓存 → 永远先拿最新版，断网也能进游戏
- 其余同源静态资源 → **缓存优先 + 后台更新**（stale-while-revalidate）
- 只在**生产构建**注册（`src/registerSw.ts`），开发期不注册，免得缓存和 HMR 打架
- `sw.js` 里的 `VERSION` **只影响旧缓存清理，不影响正确性**：不 bump 也不会出错，只是带 hash 的 JS/CSS 旧文件会一直留在 Cache Storage 里（每版约 250 KB）。

### 构建产物

`dist/` 约 **1.9 MB** = 12 张素材约 1.65 MB + 代码（JS/CSS/HTML）约 0.25 MB。`dist` 在 `.gitignore` 里，由 CI 发布，不进版本库。
