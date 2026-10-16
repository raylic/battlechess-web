// 注册 Service Worker（**仅生产构建**）。
//
// 为什么只在生产注册：开发期 Vite 的 HMR 会改模块 URL，而 SW 的"缓存优先"会把旧响应
// 喂回去 —— 表现是"改了代码、刷新还是旧页面"，非常难查。开发期干脆完全不注册。
//
// 缓存策略与取舍写在同一份代码里：public/sw.js 顶部的注释。

export function registerServiceWorker(): void {
  if (!import.meta.env.PROD) return;
  if (!('serviceWorker' in navigator)) return;

  // 等 load 之后再注册：不要和首屏资源抢带宽
  window.addEventListener('load', () => {
    navigator.serviceWorker.register(`${import.meta.env.BASE_URL}sw.js`).catch((err: unknown) => {
      // 注册失败不影响游戏本身（只是没有离线/客户端缓存能力），记一笔就够
      console.warn('Service Worker 注册失败：', err);
    });
  });
}
