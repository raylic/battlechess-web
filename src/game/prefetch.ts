// 首页预热：把进入对局要用的图片提前拉下来（并解码）。
//
// 为什么要在首页做：点「本地对战」之后，棋盘第一帧就要用到棋子精灵图 / 暗面 / 两侧面板 /
// 两块名牌，加起来约 400 KB。不预热的话点下去会先出现"空棋盘 + 面板没图"的一两帧，
// 弱网下更明显。首页这时其实什么都闲着，正好拿来做这件事。
//
// 两个约束：
//   · **不拖慢首页**：等浏览器空闲（requestIdleCallback）才开工，2G/3G 或开了省流量就跳过；
//   · **只做一次**：模块级开关，重复挂载（StrictMode、返回首页）不会再发一遍请求。
//
// 注意这里列的是**图片**；JS 本身已经在主包里了（联机的 peerjs 是单独 chunk，
// 等真的点「联网对战」时才按需加载，不该在首页预热）。

/** 进入对局/结算会用到的图片，按"第一帧最急"的顺序排 */
export const GAME_ASSETS = [
  // 第一帧：棋盘外观、暗子、两侧面板、两块名牌
  'board-flat.webp',
  'chess.webp',
  'unopen.webp',
  'chess-mini.webp',
  'back-mini.webp',
  'head_red.webp',
  'head_blue.webp',
  // 结算时才用（wait_top_* 按胜负三选一，全下下来也就 125 KB）
  'wait_panel.webp',
  'wait_top_red.webp',
  'wait_top_blue.webp',
  'wait_top_draw.webp',
] as const;

export interface PrefetchDeps {
  /** 把一张图拉下来并解码；失败也要 resolve（预热失败不影响游戏） */
  load?: (url: string) => Promise<void>;
  /** 空闲调度，默认 requestIdleCallback（没有就退化成 setTimeout 200ms） */
  idle?: (run: () => void) => void;
  /** 省流量 / 慢网时整段跳过 */
  shouldSkip?: () => boolean;
}

let started = false;

/** 默认加载器：<img> 预热 + decode()，避免首帧才解码卡一下 */
function defaultLoad(url: string): Promise<void> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve();
    img.onerror = () => resolve(); // 预热失败就算了，真要用的时候浏览器还会再试
    img.src = url;
  });
}

function defaultIdle(run: () => void): void {
  const ric = (globalThis as { requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number })
    .requestIdleCallback;
  if (typeof ric === 'function') ric(run, { timeout: 2000 });
  else setTimeout(run, 200);
}

/** 省流量 / 2G / 3G 就别抢带宽了 —— 这点体验提升不值得让人多花流量 */
function defaultShouldSkip(): boolean {
  const conn = (navigator as { connection?: { saveData?: boolean; effectiveType?: string } }).connection;
  if (!conn) return false;
  if (conn.saveData) return true;
  return conn.effectiveType === 'slow-2g' || conn.effectiveType === '2g' || conn.effectiveType === '3g';
}

/**
 * 开始预热。重复调用直接返回同一个 promise（不会重复请求）。
 * 返回的 promise 在全部加载完（或跳过）后 resolve，方便测试与"预热完成"埋点。
 */
export function prefetchGameAssets(deps: PrefetchDeps = {}): Promise<void> {
  const load = deps.load ?? defaultLoad;
  const idle = deps.idle ?? defaultIdle;
  const shouldSkip = deps.shouldSkip ?? defaultShouldSkip;

  if (started) return Promise.resolve();
  started = true;

  const base = import.meta.env.BASE_URL;
  const urls = GAME_ASSETS.map((name) => `${base}assets/${name}`);

  return new Promise<void>((resolve) => {
    if (shouldSkip()) {
      resolve();
      return;
    }
    idle(() => {
      // 并发 3：足够跑满弱网带宽，又不至于把首页那一两个还在路上的请求挤掉
      let next = 0;
      let running = 0;
      const pump = () => {
        while (running < 3 && next < urls.length) {
          const url = urls[next++]!;
          running += 1;
          // 单张失败必须吞掉：预热只是提前把图拉下来，失败了真要用时浏览器还会再试，
          // 但漏掉的 rejection 会变成 unhandled rejection（vitest 直接算 error，`pnpm test` 退出码非 0，
          // CI 里就等于“测试不过不发版”）。
          void load(url)
            .catch(() => {})
            .finally(() => {
              running -= 1;
              if (next >= urls.length && running === 0) resolve();
              else pump();
            });
        }
        if (urls.length === 0) resolve();
      };
      pump();
    });
  });
}

/** 只给测试用：重置"已预热"开关 */
export function resetPrefetchForTest(): void {
  started = false;
}
