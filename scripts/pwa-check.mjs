// 真浏览器 PWA / 横屏自检（Chrome + CDP，零依赖：Node 22 自带 fetch / WebSocket）
//
// 为什么需要它：竖屏遮罩的开关是一句 CSS 媒体查询
//     @media (orientation: portrait) and (pointer: coarse)
// jsdom 里没有媒体查询求值、没有真实视口，所以 pwa.test.ts 只能断言"这句写在文件里"，
// 断言不了"它到底会不会显示"。这个脚本用 CDP 模拟真机视口 + 触摸，实测四个场景。
//
// 用法：先 `pnpm dev`，再 `pnpm pwa:check [url]`
// 也可以直接打线上：`pnpm pwa:check https://raylic.github.io/battlechess-web/`
// 需要本机有 Chrome；不进 pnpm test。

import { spawn } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';

const CHROME_PATHS = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
];
const PORT = 9334;
const URL_TARGET = process.argv[2] ?? 'http://localhost:5173/battlechess-web/?mode=hotseat&seed=42';
const PROFILE = '/tmp/bc-pwa-check-profile';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let failures = 0;
const check = (ok, what) => {
  if (!ok) failures++;
  console.log(`  ${ok ? '✓' : '✗ 失败'} ${what}`);
};

let ws;
let chrome;
const cleanup = async () => {
  try {
    ws?.close();
  } catch {}
  try {
    chrome?.kill('SIGKILL');
  } catch {}
  for (let i = 0; i < 10; i++) {
    try {
      rmSync(PROFILE, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
      return;
    } catch {
      await sleep(300);
    }
  }
  console.log(`（${PROFILE} 没删干净，可手工清理）`);
};

async function main() {
  const chromePath = CHROME_PATHS.find((p) => existsSync(p));
  if (!chromePath) {
    console.log(`跳过：本机没找到 Chrome / Chromium\n  找过这些路径：${CHROME_PATHS.join(' ')}`);
    process.exitCode = 2;
    return;
  }
  try {
    const head = await fetch(URL_TARGET, { method: 'HEAD' });
    if (!head.ok) throw new Error(String(head.status));
  } catch {
    console.log(`跳过：${URL_TARGET} 打不开。先跑 pnpm dev 再执行本脚本。`);
    process.exitCode = 2;
    return;
  }

  rmSync(PROFILE, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  // 故意不开 --window-size 之外的东西：下面用 CDP 自己模拟视口
  chrome = spawn(
    chromePath,
    [
      '--headless=new',
      `--remote-debugging-port=${PORT}`,
      `--user-data-dir=${PROFILE}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-gpu',
      '--window-size=1280,900',
      URL_TARGET,
    ],
    { stdio: 'ignore' },
  );

  let target = null;
  for (let i = 0; i < 150 && !target; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      target = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl) ?? null;
    } catch {}
    if (!target) await sleep(100);
  }
  if (!target) throw new Error('Chrome 调试端口没起来');

  ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.onopen = res;
    ws.onerror = () => rej(new Error('CDP WebSocket 连不上'));
  });

  let seq = 0;
  const pending = new Map();
  const consoleErrors = [];
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
      consoleErrors.push(m.params.args.map((a) => a.value ?? a.description ?? '').join(' '));
    }
    if (m.method === 'Runtime.exceptionThrown') {
      consoleErrors.push(m.params.exceptionDetails?.text ?? 'exception');
    }
    const done = pending.get(m.id);
    if (done) {
      pending.delete(m.id);
      done(m);
    }
  };
  const send = (method, params = {}) =>
    new Promise((res, rej) => {
      const id = ++seq;
      pending.set(id, res);
      ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => pending.has(id) && rej(new Error(`CDP 超时: ${method}`)), 20000);
    });
  const evalJs = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.result?.exceptionDetails) throw new Error(`${r.result.exceptionDetails.text} | ${expression}`);
    return r.result?.result?.value;
  };

  await send('Page.enable');
  await send('Runtime.enable');
  await send('Log.enable');

  let ready = false;
  for (let i = 0; i < 100 && !ready; i++) {
    ready = await evalJs(`!!document.querySelector('[data-cell="0,0"]')`);
    if (!ready) await sleep(100);
  }
  if (!ready) throw new Error('棋盘没渲染出来');

  /** 遮罩当前是否真的可见（display + 实际盒子，两个都看） */
  const maskState = () =>
    evalJs(`(() => {
      const el = document.getElementById('rotate');
      if (!el) return { found: false };
      const cs = getComputedStyle(el);
      const box = el.getBoundingClientRect();
      return {
        found: true,
        display: cs.display,
        pointerEvents: cs.pointerEvents,
        visible: cs.display !== 'none' && box.height > 0,
        text: el.textContent.replace(/\\s+/g, ' ').trim(),
        mqCoarse: matchMedia('(pointer: coarse)').matches,
        mqPortrait: matchMedia('(orientation: portrait)').matches,
        maxTouchPoints: navigator.maxTouchPoints,
        vw: innerWidth, vh: innerHeight,
        fit: getComputedStyle(document.documentElement).getPropertyValue('--fit').trim(),
      };
    })()`);

  /** 切到某个模拟设备；touch=false 就是"鼠标的桌面" */
  const emulate = async ({ width, height, touch, landscape }) => {
    await send('Emulation.setDeviceMetricsOverride', {
      width,
      height,
      deviceScaleFactor: touch ? 3 : 1,
      mobile: touch,
      ...(landscape ? { screenOrientation: { type: 'landscapePrimary', angle: 90 } } : {}),
    });
    await send('Emulation.setTouchEmulationEnabled', { enabled: touch, maxTouchPoints: touch ? 5 : 0 });
    await sleep(400);
  };

  console.log(`\n页面：${URL_TARGET}`);

  /* ---------------- A. manifest ---------------- */
  console.log('\nA. manifest（Chrome 真的解析了吗）');
  const mf = await send('Page.getAppManifest');
  const info = mf.result ?? {};
  check(!!info.url, `找到了 manifest：${info.url}`);
  check(
    !!info.url && new URL(info.url).pathname.endsWith('/manifest.webmanifest'),
    'manifest 的 URL 带上了 base 前缀',
  );
  check((info.errors ?? []).length === 0, `无解析错误${(info.errors ?? []).length ? `：${JSON.stringify(info.errors)}` : ''}`);
  let parsed = null;
  try {
    parsed = JSON.parse(info.data ?? '{}');
  } catch (e) {
    parsed = { __parseError: String(e) };
  }
  check(parsed.name === '皇家战棋 · Web', `name = ${parsed.name}`);
  check(parsed.display === 'standalone', `display = ${parsed.display}`);
  check(parsed.orientation === 'landscape', `orientation = ${parsed.orientation}`);
  // 图标已统一成一张 192
  check((parsed.icons ?? []).length === 1, `icons = ${(parsed.icons ?? []).length} 个（应为 1）`);

  const base = new URL('./', info.url ?? URL_TARGET).href;
  for (const icon of parsed.icons ?? []) {
    const abs = new URL(icon.src, info.url).href;
    const r = await fetch(abs, { method: 'HEAD' }).catch(() => null);
    check(r?.ok === true, `图标可访问（${r?.status}）：${abs.replace(base, './')}`);
  }

  /* ---------------- B. 竖屏遮罩 ---------------- */
  console.log('\nB. 竖屏遮罩：四种场景');

  // B0 桌面横窗（无任何模拟）：不该显示
  let s = await maskState();
  check(s.found, 'index.html 里有 #rotate');
  check(s.visible === false, `桌面横窗：不显示（display=${s.display}）`);
  check(s.pointerEvents === 'none', `遮罩不拦事件（pointer-events=${s.pointerEvents}）`);
  check(s.mqCoarse === false, '桌面是细指针（pointer: fine）');

  // B1 桌面竖窗（390x844，但仍是鼠标）：不该显示 —— 这条守的就是 (pointer: coarse)。
  //    必须放在触摸模拟**之前**：CDP 的 setTouchEmulationEnabled(false) 不会把
  //    pointer: coarse 干净地还原，之后再测这一条测到的是脏状态，不反映真实桌面。
  await emulate({ width: 390, height: 844, touch: false });
  s = await maskState();
  check(s.visible === false, `桌面窄高窗：不显示（display=${s.display}）`);
  check(s.mqCoarse === false, `(pointer: coarse) 在桌面上为 false（maxTouchPoints=${s.maxTouchPoints}）`);
  check(Number(s.fit) < 0.45, `它确实很窄（--fit=${Number(s.fit).toFixed(2)}），所以这条守的不是空测试`);

  // B2 竖屏手机：必须显示
  await emulate({ width: 390, height: 844, touch: true });
  s = await maskState();
  check(s.vw === 390 && s.vh === 844, `视口模拟到 390x844（实际 ${s.vw}x${s.vh}，说明 viewport meta 生效）`);
  check(s.mqCoarse === true, `(pointer: coarse) 为 true（maxTouchPoints=${s.maxTouchPoints}）`);
  check(Number(s.fit) < 0.45, `舞台只剩 ${Number(s.fit).toFixed(2)} 倍 —— 这就是竖屏没法玩的原因`);
  check(s.visible === true, '竖屏手机：显示遮罩');
  check(/请把手机横过来/.test(s.text), '文案是"请把手机横过来"');

  // B3 横屏手机：必须不显示
  await emulate({ width: 844, height: 390, touch: true, landscape: true });
  s = await maskState();
  check(s.vw === 844 && s.vh === 390, `视口模拟到 844x390（实际 ${s.vw}x${s.vh}）`);
  check(Number(s.fit) > 0.55, `舞台放大到 ${Number(s.fit).toFixed(2)} 倍，可以玩了`);
  check(s.visible === false, '横屏手机：不显示遮罩');

  /* ---------------- C. 横屏锁 ---------------- */
  console.log('\nC. 横屏锁能力探测（真机上锁不锁得上取决于系统和是否已安装）');
  const lock = await evalJs(
    `({ hasOrientation: typeof screen.orientation === 'object' && screen.orientation !== null,
        hasLock: typeof screen.orientation?.lock === 'function',
        type: screen.orientation?.type ?? null })`,
  );
  console.log(`  · screen.orientation 存在：${lock.hasOrientation}，lock() 存在：${lock.hasLock}，当前 type=${lock.type}`);
  console.log('  （headless 里锁不住是正常的；能锁的是"装到主屏后的 Android"，iOS 压根没这个方法）');

  /* ---------------- D. Service Worker ---------------- */
  console.log('\nD. Service Worker（PWA 的离线能力）');
  const sw = await evalJs(
    `navigator.serviceWorker.ready.then((r) => ({ scope: r.scope, active: !!r.active })).catch((e) => ({ error: String(e) }))`,
  );
  check(!!sw.active, `SW 已激活（scope=${sw.scope ?? sw.error}）`);

  await send('Page.reload', { ignoreCache: false });
  await sleep(1200);
  const controlled = await evalJs(`navigator.serviceWorker.controller !== null`);
  check(controlled === true, '刷新后页面已被 SW 接管（离线可用的前提）');

  /* ---------------- 收尾 ---------------- */
  const realErrors = consoleErrors.filter((e) => !/favicon|Download the React DevTools/i.test(e));
  console.log(`\n控制台错误：${realErrors.length === 0 ? '无' : realErrors.join(' | ')}`);
  check(realErrors.length === 0, '没有控制台错误');

  console.log(`\n结果：${failures === 0 ? '全部通过' : `${failures} 项失败`}`);
  if (failures > 0) process.exitCode = 1;
}

try {
  await main();
} catch (err) {
  console.error(`\n自检本身出错：${err.message}`);
  process.exitCode = 1;
} finally {
  await cleanup();
}
