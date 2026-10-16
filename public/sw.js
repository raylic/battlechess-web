/* 皇家战棋 · Service Worker —— 客户端缓存
 *
 * 为什么需要它：GitHub Pages **不允许自定义响应头**，全站固定 `Cache-Control: max-age=600`。
 * 于是那 12 张**不带内容 hash** 的素材（2.1 MB，其中 wait.png 485KB、begin.png 377KB、
 * chess.png 200KB）每过 10 分钟就要重新校验一次，而且换了内容 URL 不变、最长吃 10 分钟旧图。
 * SW 是 Pages 上唯一能真正控制客户端缓存的机制。
 *
 * 策略（刻意保持简单，不做构建期预缓存清单）：
 *   - 导航请求（HTML）        → **网络优先**，失败回退缓存。永远先拿最新 index.html。
 *   - 其余同源静态资源        → **缓存优先 + 后台更新**（stale-while-revalidate）。
 *
 * 为什么不做预缓存：带 hash 的文件名只有构建期才知道，而放在 public/ 里的这个文件拿不到；
 * "用到即缓存"效果一样，还少一层构建耦合。
 *
 * ⚠️ VERSION 的语义：它**只决定旧缓存的清理**，不影响正确性。
 *    因为静态资源走的是 stale-while-revalidate —— 就算不 bump，同一 URL 的旧内容
 *    也会在下次访问时被后台覆盖。不 bump 的唯一代价是：带 hash 的 JS/CSS 每发一版都会
 *    换名，旧的那份会一直留在 Cache Storage 里（每版约 250 KB）。定期 bump 一下即可。
 */
const VERSION = 'v1';
const CACHE = `battlechess-${VERSION}`;

/** 只碰同源 GET。跨域（字体 CDN 之类）一概不管，交给浏览器默认行为。 */
function isCacheable(request) {
  return request.method === 'GET' && new URL(request.url).origin === self.location.origin;
}

/** cache.put 对某些请求（如 mode: navigate）可能抛错；缓存写失败不该影响页面。 */
async function put(cache, key, response) {
  try {
    await cache.put(key, response);
  } catch (err) {
    console.warn('[sw] 写缓存失败', key.url ?? key, err);
  }
}

self.addEventListener('install', () => {
  // 刻意不 skipWaiting()：新 SW 等旧页面全部关掉再接管，避免"新 SW + 旧页面"混跑。
  // 代价是刷新一次才会生效 —— 但因为 HTML 是网络优先，用户下一次刷新就已经是新版本了。
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)));
      await self.clients.claim();
    })(),
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (!isCacheable(request)) return;

  event.respondWith(request.mode === 'navigate' ? networkFirst(request) : staleWhileRevalidate(request));
});

/** HTML：网络优先。拿不到网络时回退缓存，再不行退回应用外壳（离线也能进游戏）。 */
async function networkFirst(request) {
  const cache = await caches.open(CACHE);
  try {
    const fresh = await fetch(request);
    if (fresh.ok) await put(cache, request, fresh.clone());
    return fresh;
  } catch (err) {
    const cached = await cache.match(request, { ignoreSearch: true });
    if (cached) return cached;
    const shell = await cache.match(new URL('index.html', self.registration.scope).href);
    if (shell) return shell;
    throw err;
  }
}

/** 静态资源：有缓存立刻返回，同时后台拉一份新的覆盖掉（下次访问即最新）。 */
async function staleWhileRevalidate(request) {
  const cache = await caches.open(CACHE);
  const cached = await cache.match(request);

  const network = fetch(request)
    .then(async (res) => {
      // 只存正常的同源响应；opaque / 4xx / 5xx 一律不落盘（否则会把错误页缓存住）
      if (res.ok && res.type === 'basic') await put(cache, request, res.clone());
      return res;
    })
    .catch(() => null);

  if (cached) return cached;
  const fresh = await network;
  return fresh ?? Response.error();
}
