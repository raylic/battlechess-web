// 联机自检（Chrome + CDP，零依赖）：真开两个页面，把 RTCPeerConnection 强制成
// `iceTransportPolicy: 'relay'` —— 两个页面**只能**走 TURN 中继，等于在同一台机器上
// 模拟「双方都在对称 NAT / 移动网络后面」，然后跑一遍：建房 → 客人进 → 同步一手 →
// 客人刷新重连。全过才说明「非局域网能玩」，而不只是「同网段能连」。
//
// 用法：
//   VITE_TURN_ENDPOINT=https://turn.raylic.work pnpm build
//   pnpm preview &
//   pnpm online:check                       # 默认 http://localhost:4173/battlechess-web/
//   pnpm online:check https://raylic.github.io/battlechess-web/   # 对着线上验
//
// 为什么用 --disable-web-security：TURN 凭据端点只放行线上 origin（ALLOWED_ORIGIN），
// 从 localhost 直接拉会被 CORS 挡掉，页面就会退回"没有中继"，这个自检也就失去意义。
// 这里只是想验「中继链路通不通」，不验 CORS —— CORS 那一条用线上页面手测。
//
// 需要本机有 Chrome、能访问 PeerJS 公共云和 TURN 端点。CI 上不跑，也不进 pnpm test。

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';

const CHROME_PATHS = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
];
const PORT = 9350;
const PROFILE = '/tmp/bc-online-check-profile';
const BASE = process.argv[2] ?? 'http://localhost:4173/battlechess-web/';
const ROOM_URL = `${BASE}?mode=online`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const chromePath = CHROME_PATHS.find((p) => existsSync(p));

let failures = 0;
const check = (ok, what) => {
  if (!ok) failures++;
  console.log(`  ${ok ? '✓' : '✗ 失败'} ${what}`);
};

/**
 * 强制只走中继。
 *
 * peerjs 自己不传 iceTransportPolicy，所以在 document-start 把构造函数包一层 ——
 * 只有在浏览器真的能拿到 relay candidate 时，连接才可能成功。
 */
const RELAY_ONLY = `(() => {
  const Orig = window.RTCPeerConnection;
  function Patched(config, constraints) {
    return new Orig({ ...(config || {}), iceTransportPolicy: 'relay' }, constraints);
  }
  Patched.prototype = Orig.prototype;
  window.RTCPeerConnection = Patched;
})();`;

async function main() {
  if (!chromePath) {
    console.log(`跳过：本机没找到 Chrome / Chromium\n  找过这些路径：${CHROME_PATHS.join(' ')}`);
    return;
  }

  const chrome = spawn(
    chromePath,
    [
      '--headless=new',
      `--remote-debugging-port=${PORT}`,
      `--user-data-dir=${PROFILE}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-web-security',
      '--window-size=1100,760',
      'about:blank',
    ],
    { stdio: 'ignore' },
  );

  let ws;
  const cleanup = async () => {
    try {
      ws?.close();
    } catch {}
    try {
      chrome.kill('SIGKILL');
    } catch {}
    // Chrome 被 kill 之后句柄不一定马上释放，重试几轮（同 click-check.mjs）
    const { rmSync } = await import('node:fs');
    for (let i = 0; i < 10; i++) {
      try {
        rmSync(PROFILE, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
        return;
      } catch {
        await sleep(300);
      }
    }
  };

  try {
    await run(chrome, (socket) => {
      ws = socket;
    });
  } finally {
    await cleanup();
    console.log(failures === 0 ? '\n全部通过：中继链路能建房、能同步、能重连' : `\n${failures} 项失败`);
    // 不在这里 exit：抛出去的错误要能被下面的 catch 变成非零退出码
    process.exitCode = failures === 0 ? 0 : 1;
  }
}

async function run(chrome, keepSocket) {
  let wsUrl;
  for (let i = 0; i < 80 && !wsUrl; i++) {
    await sleep(250);
    try {
      wsUrl = (await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json()).webSocketDebuggerUrl;
    } catch {}
  }
  if (!wsUrl) throw new Error('Chrome 没起来（找不到 CDP 端口）');

  const ws = new WebSocket(wsUrl);
  keepSocket(ws);
  await new Promise((resolve) => (ws.onopen = resolve));

  let id = 0;
  const pending = new Map();
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) {
      pending.get(m.id)(m);
      pending.delete(m.id);
    }
  };
  const call = (method, params = {}, sessionId) =>
    new Promise((resolve, reject) => {
      const my = ++id;
      pending.set(my, (m) => (m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result)));
      ws.send(JSON.stringify({ id: my, method, params, ...(sessionId ? { sessionId } : {}) }));
    });

  async function openPage(url) {
    const { targetId } = await call('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await call('Target.attachToTarget', { targetId, flatten: true });
    const send = (m, p = {}) => call(m, p, sessionId);
    await send('Page.enable');
    await send('Runtime.enable');
    await send('Page.addScriptToEvaluateOnNewDocument', { source: RELAY_ONLY });
    await send('Page.navigate', { url });
    return {
      relayOnlyPatch: () => send('Page.addScriptToEvaluateOnNewDocument', { source: RELAY_ONLY }),
      navigate: (to) => send('Page.navigate', { url: to }),
      eval: async (expr) =>
        (await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })).result.value,
    };
  }

  const cells = (page) => page.eval(`document.querySelectorAll('[data-testid^="cell-"]').length`);
  const revealed = (page) => page.eval(`document.querySelectorAll('.piece.is-revealed').length`);
  const toast = (page) => page.eval(`document.querySelector('#toast')?.textContent ?? ''`);
  const hasButton = (page, text) =>
    page.eval(
      `!![...document.querySelectorAll('button')].find((x) => x.textContent.trim() === ${JSON.stringify(text)})`,
    );
  const clickText = (page, text) =>
    page.eval(`(() => {
      const b = [...document.querySelectorAll('button')].find((x) => x.textContent.trim() === ${JSON.stringify(text)});
      if (!b) return 'none';
      b.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      return 'ok';
    })()`);

  /** 轮询到有值为止；返回值本身（不是 true），超时返回 null */
  async function waitFor(label, fn, timeoutMs = 30000) {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      const value = await fn();
      if (value) {
        console.log(`  ✓ ${label}（${Date.now() - started}ms）`);
        return value;
      }
      await sleep(300);
    }
    console.log(`  ✗ ${label} 超时`);
    failures += 1;
    return null;
  }

  console.log(`中继专用自检：${ROOM_URL}\n`);

  const host = await openPage(ROOM_URL);
  // 对着线上跑时首屏要下 1.5 MB 资源（还带 SW 注册），按钮不会立刻在 —— 等它渲染出来再点，
  // 否则点到空气，后面每一条都会跟着超时
  await waitFor('大厅渲染完成', () => hasButton(host, '创建'), 45_000);
  check((await clickText(host, '创建')) === 'ok', '点了「创建」');

  const link = await waitFor(
    '房主拿到邀请链接',
    async () => (await host.eval(`document.querySelector('[data-testid="invite-link"]')?.value ?? ''`)) || false,
    30_000,
  );
  const relayLine = await host.eval(`document.querySelector('[data-testid="relay-status"]')?.textContent ?? ''`);
  check(relayLine.includes('中继已就绪'), `邀请屏写明中继可用（实际：${relayLine || '空'}）`);
  if (!link) return;

  const guest = await openPage(link);
  const guestOk = await waitFor('客人拿到棋盘（只能走中继）', async () => (await cells(guest)) >= 36, 30_000);
  check(guestOk, '客人经 TURN 连上并收到投影');
  check((await cells(host)) >= 36, '房主切到棋盘（客人握手成功）');

  // 房主执红先手：翻一子，客人那边应当同步看到
  // （棋子在揭晓动画/首帧里可能还不可操作，所以先等"真的有可点的格子"，再等对面同步）
  const before = await revealed(guest);
  const clickMove = () =>
    host.eval(`(() => {
      const cell = [...document.querySelectorAll('[data-testid^="cell-"]')].find((c) => c.className.includes('is-hoverable'));
      if (!cell) return 'none';
      cell.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      return 'clicked';
    })()`);
  const clicked = await waitFor('房主有可落子的格子', async () => ((await clickMove()) === 'clicked' ? true : null), 15_000);
  const synced = clicked
    ? await waitFor('这步棋同步到客人那边', async () => ((await revealed(guest)) > before ? true : null), 15_000)
    : false;
  check(synced, `一步棋经中继同步到对面（${before} → ${await revealed(guest)}）`);
  const hostToast = await toast(host);
  if (hostToast) console.log(`    （房主那边的提示：${hostToast}）`);

  // 客人刷新 = 断开重连：视角要被释放、重新 join、棋局接着走
  await guest.relayOnlyPatch();
  await guest.navigate(link);
  const rejoin = await waitFor('客人刷新后回到同一盘', async () => (await cells(guest)) >= 36, 30_000);
  check(rejoin, '重连（刷新）能拿回全量快照');
  check(!(await toast(guest)).includes('已经有人'), '没有被「这一方已经有人了」挡住');
}

main().catch((err) => {
  console.error(`自检崩了：${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});
