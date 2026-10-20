// 真浏览器点击自检（Chrome + CDP，零依赖：Node 22 自带 fetch / WebSocket）
//
// 为什么需要它：vitest 跑在 jsdom 里，fireEvent.click 是**直接派发到目标元素**的，
// 绕开浏览器的命中测试。于是"有层东西盖在棋盘上方"这种 bug 在单测里完全看不出来，
// 真机上却一个子都点不动（这个坑真实发生过：#heads / #controls 是 inset:0 铺满舞台、
// DOM 顺序又排在 Board 之后，接管了棋盘上的全部点击）。本脚本用真实鼠标事件点棋盘，
// 并顺手做 A/B 对照：把覆盖层的 pointer-events 改回 auto 就能复现"点不动"。
//
// 用法：先 `pnpm dev`，再 `pnpm click:check [url]`
// 注意 URL 要带 vite.config.ts 里配的 base —— 本地开发地址是
//   http://localhost:5173/battlechess-web/
// 需要本机有 Chrome；CI 上不跑它，也不进 pnpm test。

import { spawn } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';

const CHROME_PATHS = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
];
const PORT = 9333;
const URL = process.argv[2] ?? 'http://localhost:5173/battlechess-web/?mode=hotseat&seed=42';
const PROFILE = '/tmp/bc-click-check-profile';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const chromePath = CHROME_PATHS.find((p) => existsSync(p));

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
  // Chrome 被 kill 后文件句柄不一定马上释放，重试几轮
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
  if (!chromePath) {
    console.log(`跳过：本机没找到 Chrome / Chromium（这个自检需要真浏览器）\n  找过这些路径：${CHROME_PATHS.join(' ')}`);
    process.exitCode = 2; // 退出码 2 = 跳过，不要和"通过"混为一谈
    return;
  }
  try {
    const head = await fetch(URL.replace(/\?.*$/, ''), { method: 'HEAD' });
    if (!head.ok) throw new Error(String(head.status));
  } catch {
    console.log(`跳过：${URL} 打不开。先跑 pnpm dev 再执行本脚本。`);
    process.exitCode = 2;
    return;
  }

  rmSync(PROFILE, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
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
      URL,
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
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
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
      setTimeout(() => pending.has(id) && rej(new Error(`CDP 超时: ${method}`)), 15000);
    });
  const evalJs = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.result?.exceptionDetails) throw new Error(`${r.result.exceptionDetails.text} | ${expression}`);
    return r.result?.result?.value;
  };

  let ready = false;
  for (let i = 0; i < 100 && !ready; i++) {
    ready = await evalJs(`!!document.querySelector('[data-cell="0,0"]')`);
    if (!ready) await sleep(100);
  }
  if (!ready) throw new Error('棋盘没渲染出来');

  /** 针对"最后一次点击的那个点"做命中测试 + 状态快照 */
  const probe = () =>
    evalJs(`(() => {
      const el = document.elementFromPoint.apply(document, window.__p ?? [0, 0]);
      const foot = document.querySelector('#foot');
      return {
        hit: el ? (el.id || el.className || el.tagName) : null,
        hitCell: el?.dataset?.cell ?? null,
        step: Number(foot?.getAttribute('data-step') ?? -1),
        revealed: document.querySelectorAll('.piece.is-revealed').length,
        selected: !!document.querySelector('.cell.is-selected'),
        targets: document.querySelectorAll('.cell.is-target').length,
      };
    })()`);
  const show = (label, o) =>
    console.log(
      `  ${label.padEnd(16)} 命中=${String(o.hit).padEnd(22)}(格=${String(o.hitCell).padEnd(4)}) 步=${o.step} 明子=${o.revealed} 选中=${o.selected} 落点=${o.targets}`,
    );

  const clickAt = async (x, y) => {
    await evalJs(`window.__p = [${x}, ${y}]; true`);
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
    await sleep(280);
  };
  const cellCenter = (row, col) =>
    evalJs(`(() => {
      const b = document.querySelector('[data-cell="${row},${col}"]').getBoundingClientRect();
      return { x: Math.round(b.left + b.width / 2), y: Math.round(b.top + b.height / 2) };
    })()`);
  const clickCell = async (row, col) => clickAt(...Object.values(await cellCenter(row, col)));
  /** 明子的位置与阵营（--side: 0=红 1=蓝）。格子用 data-at 读，不信命中测试猜；
   *  棋子会"站起来"高出棋盘，它的中心点可能落在棋盘外 → 退回格子中心点，避免空断言 */
  const revealedPieces = () =>
    evalJs(`[...document.querySelectorAll('.piece.is-revealed')].map((el) => {
      const at = el.dataset.at;
      const b = el.getBoundingClientRect();
      let x = Math.round(b.left + b.width / 2);
      let y = Math.round(b.top + b.height / 2);
      if (document.elementFromPoint(x, y)?.dataset?.cell !== at) {
        const cb = document.querySelector('[data-cell="' + at + '"]').getBoundingClientRect();
        x = Math.round(cb.left + cb.width / 2);
        y = Math.round(cb.top + cb.height / 2);
      }
      return { side: el.style.getPropertyValue('--side').trim(), cell: at, x, y };
    })`);
  const setOverlayPE = (v) =>
    evalJs(`(() => {
      for (const s of ['#controls', '#heads', '#banner', '#panels'])
        document.querySelector(s).style.pointerEvents = ${JSON.stringify(v)};
      return true;
    })()`);

  console.log(`页面：${URL}\n`);

  // ---------- A：复现"点不动"（把覆盖层的指针事件改回默认值）----------
  console.log('A 复现「点不动」：把 #controls/#heads/#banner 的 pointer-events 改回 auto');
  await setOverlayPE('auto');
  await clickCell(0, 0);
  const a = await probe();
  show('点(0,0)后', a);
  check(a.hit === 'controls' && a.step === 0, '点击被 #controls 接走、棋步不动 → 复现"一个子都翻不动"');

  // ---------- B：修复后的真实样式 ----------
  console.log('\nB 真实样式：翻棋 / 选中 / 吃子走子 / 认输按钮');
  await setOverlayPE('');
  const pe = await evalJs(
    `['#controls','#heads','#banner','#panels']
       .map((s) => s + '=' + getComputedStyle(document.querySelector(s)).pointerEvents).join(' ')`,
  );
  check(pe === '#controls=none #heads=none #banner=none #panels=none', `覆盖层指针事件已关掉（${pe}）`);

  await clickCell(0, 0);
  const flip = await probe();
  show('翻棋(0,0)', flip);
  check(flip.hitCell === '0,0' && flip.step === 1 && flip.revealed === 1, '真实点击命中的就是 (0,0)，翻棋生效');

  // 再翻一个另一阵营的（第 5 行与第 0 行必属不同阵营），凑出"自己的明子"
  await clickCell(5, 0);
  const mine = await revealedPieces();
  const mineSide = mine.find((m) => m.side === '0');
  check(mine.length === 2 && new Set(mine.map((m) => m.side)).size === 2, `第 0/5 行分属红蓝：${mine.map((m) => `(${m.cell})=${m.side}`).join(' ')}`);

  // 现在轮到红方：点自己的明子应当选中，点对方的明子不该选中
  const foe = mine.find((m) => m.side === '1');
  if (foe) {
    await clickAt(foe.x, foe.y);
    check(!(await probe()).selected, '点对方的明子不会被选中');
  }
  if (mineSide) {
    await clickAt(mineSide.x, mineSide.y);
    check((await probe()).selected, '点自己的明子能选中');
  }

  // ---------- 吃子走子：成对翻开第 2 行(蓝) / 第 3 行(红)，红方回合检查红子有无落点 ----------
  let moved = null;
  for (let k = 0; k < 6 && !moved; k++) {
    await clickCell(2, k); // 红方回合翻一格（翻棋不限颜色）
    await clickCell(3, k); // 蓝方回合翻一格 → 又轮到红方
    for (const p of (await revealedPieces()).filter((m) => m.side === '0')) {
      await clickAt(p.x, p.y);
      const sel = await probe();
      if (!sel.selected || sel.targets === 0) continue;
      const target = await evalJs(`document.querySelector('.cell.is-target')?.dataset.cell ?? null`);
      const before = sel.step;
      await clickCell(...target.split(',').map(Number));
      const after = await probe();
      moved = { from: p.cell, to: target, before, after };
      break;
    }
  }
  if (moved) {
    show(`吃子 ${moved.from}→${moved.to}`, moved.after);
    check(moved.after.step === moved.before + 1, '吃子走子生效：步数 +1');
    const now = (await revealedPieces()).filter((m) => m.side === '0').map((m) => m.cell);
    check(now.includes(moved.to), `红子确实落在 (${moved.to})（现在红方明子在 ${now.join(' ')}）`);
  } else {
    check(false, '翻遍了第 2/3 行也没构造出可吃的相邻对（种子太背？换个 seed 再跑）');
  }

  // 认输按钮：容器被关掉指针事件后，按钮自己必须还能被命中
  const g = await evalJs(`(() => {
    const b = document.querySelector('#giveup').getBoundingClientRect();
    return Math.round(b.left + b.width / 2) + ',' + Math.round(b.top + b.height / 2);
  })()`);
  const gHit = await evalJs(
    `(() => { const el = document.elementFromPoint(${g}); return el ? (el.id || el.className) : null })()`,
  );
  check(gHit === 'giveup', `认输按钮没被覆盖层挡住（命中 ${gHit}）`);

  console.log(`\n结果：${failures === 0 ? '全部通过' : `${failures} 项失败`}`);
  process.exitCode = failures === 0 ? 0 : 1;
}

try {
  await main();
} finally {
  await cleanup();
}
