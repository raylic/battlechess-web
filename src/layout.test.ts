// 布局自检：把 styles.css 里的几何参数解析出来，用和浏览器一样的投影公式验算一遍。
/// <reference types="node" />
// 目的：守住"看图才发现"的几件事 —— 棋盘投影后落在画布内、不压头像框/按钮、
// 6 列格子必须放得进棋盘盒子（border-box 下加 border 会吃掉 12px，这个坑踩过一次）、
// 以及"几何参数的单一事实来源"不被写歪。

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';

import { BOARD_ART, CELL, PIECE_SCALE, PIECE_SIZE, PIECE_Z, TILT_DEG } from './game/geometry';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const css = readFileSync(join(ROOT, 'src/styles.css'), 'utf8');
const html = readFileSync(join(ROOT, 'index.html'), 'utf8');

const num = (text: string, re: RegExp): number | null => {
  const m = re.exec(text);
  return m ? Number(m[1]) : null;
};
const blockOf = (selector: string): string => {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = new RegExp(`${escaped}\\s*\\{([^}]*)\\}`).exec(css);
  expect(m, `styles.css 里找不到 ${selector}`).not.toBeNull();
  return m![1];
};

const rootVars = blockOf(':root');
const stage = blockOf('#stage');
const board = blockOf('#board');

const cssCell = num(rootVars, /--cell:\s*([\d.]+)px/);
const tiltDeg = num(rootVars, /--tilt:\s*([\d.]+)deg/);
const perspective = num(rootVars, /--persp:\s*([\d.]+)px/);
const cssPieceScale = num(rootVars, /--piece-scale:\s*([\d.]+)/);
const cssPieceZ = num(rootVars, /--piece-z:\s*([\d.]+)px/);
const stageLeft = num(stage, /left:\s*(-?[\d.]+)px/);
const stageTop = num(stage, /top:\s*(-?[\d.]+)px/);
const boardBorder = num(board, /border:\s*([\d.]+)px/) ?? 0;
const cssArtSize = num(rootVars, /--board-art:\s*(-?[\d.]+)%/);
const cssArtX = num(rootVars, /--board-art-x:\s*(-?[\d.]+)%/);
const cssArtY = num(rootVars, /--board-art-y:\s*(-?[\d.]+)%/);

const design = { w: 1000, h: 650 };
const boardSize = cssCell! * 6;
const center = { x: stageLeft! + boardSize / 2, y: stageTop! + boardSize / 2 };
const tilt = (tiltDeg! * Math.PI) / 180;

/** 与 CSS 的 rotateX(θ) + perspective(d) 等价的正投影 */
function project(u: number, v: number) {
  const z = v * Math.sin(tilt);
  const f = perspective! / (perspective! - z);
  return { x: center.x + u * f, y: center.y + v * Math.cos(tilt) * f };
}

const half = boardSize / 2;

/* 棋盘外观是一张贴图，四周自带金边：它会画到 6×6 盒子**外面**去（见 .board-art）。
   投影后的实际占位得把这一圈算上，否则“不压头像框/面板”那几条断言是虚的。
   贴图不对称（左边距 25、右边距 23），这里取较大的一侧，宁可保守。 */
const art = BOARD_ART.area;
const artPx = {
  left: (art.left / art.width) * boardSize,
  top: (art.top / art.width) * boardSize,
  right: ((BOARD_ART.size - art.left - art.width) / art.width) * boardSize,
  bottom: ((BOARD_ART.size - art.top - art.height) / art.width) * boardSize,
};
const halfW = half + Math.max(artPx.left, artPx.right);
const halfH = half + Math.max(artPx.top, artPx.bottom);
const quad = {
  tl: project(-halfW, -halfH),
  tr: project(halfW, -halfH),
  br: project(halfW, halfH),
  bl: project(-halfW, halfH),
};

/** 投影后的棋盘在某个 y 高度上的左右边界 */
function extentAt(y: number) {
  const lerp = (a: { x: number; y: number }, b: { x: number; y: number }) =>
    a.x + ((y - a.y) / (b.y - a.y)) * (b.x - a.x);
  return { left: lerp(quad.tl, quad.bl), right: lerp(quad.tr, quad.br) };
}

test('几何参数都解析到了', () => {
  for (const [name, v] of Object.entries({
    cssCell,
    tiltDeg,
    perspective,
    cssPieceScale,
    cssPieceZ,
    stageLeft,
    stageTop,
  })) {
    expect(Number.isFinite(v), `${name} 没解析到`).toBe(true);
  }
});

test('单一事实来源：CSS 里的 --cell / --piece-scale 必须等于 geometry.ts 的常量', () => {
  expect(cssCell).toBe(CELL);
  expect(cssPieceScale).toBe(PIECE_SCALE);
});

test('棋子必须整个落在棋盘平面之前，否则下半身会被格子挡住', () => {
  // 棋子是绕自身中心反向旋转 tilt 度"站起来"的，于是下边缘会往平面之后掉：
  //     下边缘深度 = PIECE_Z − (PIECE_SIZE / 2) · sin(tilt)
  // 这个值 ≤ 0 时，格子就把棋子下半身盖住（真实症状：每枚棋子被横着切掉一截，约 20%）。
  const need = (PIECE_SIZE / 2) * Math.sin((TILT_DEG * Math.PI) / 180);
  expect(
    PIECE_Z,
    `PIECE_Z=${PIECE_Z} 必须 > ${need.toFixed(1)}（写死 26 时等于 −${(need - 26).toFixed(1)}，棋子会被切掉）`,
  ).toBeGreaterThan(need);
  expect(cssPieceZ, 'CSS 的 --piece-z 必须等于 geometry.ts 的 PIECE_Z').toBe(PIECE_Z);
  expect(tiltDeg, 'CSS 的 --tilt 必须等于 geometry.ts 的 TILT_DEG').toBe(TILT_DEG);
  expect(blockOf('.piece'), '深度别写死在 .piece 规则里，要走变量').toContain('var(--piece-z)');
});

test('6 列格子必须放得进棋盘盒子（border-box 下不能加 border）', () => {
  expect(boardBorder, '#board 不要用 border，会吃掉 12px 导致最后一列溢出').toBe(0);
  expect(boardSize + boardBorder * 2).toBeLessThanOrEqual(boardSize);
});

test('棋盘贴图的放大倍数/偏移必须与 geometry.ts 的 BOARD_ART 一致', () => {
  // 贴图里的棋格区（area）要正好压在 6×6 个格子上：放大 = 全长/棋格区宽，偏移 = −内边距/棋格区宽。
  // 写歪的表现很阴：格子边缘和贴图色块错开 1~2px，只有在棋盘四角才看得出来。
  const want = {
    size: (BOARD_ART.size / art.width) * 100,
    x: -(art.left / art.width) * 100,
    y: -(art.top / art.width) * 100,
  };
  expect(cssArtSize, '解析不到 --board-art').not.toBeNull();
  expect(cssArtSize!).toBeCloseTo(want.size, 2);
  expect(cssArtX!).toBeCloseTo(want.x, 2);
  expect(cssArtY!).toBeCloseTo(want.y, 2);
  expect(blockOf('.board-art')).toContain('url("/assets/board-flat.webp")');
});

test('投影后的棋盘整个落在 1000x650 画布内（含棋子外溢）', () => {
  const pad = (cssCell! * cssPieceScale!) / 2 - cssCell! / 2 + 4;
  for (const [name, p] of Object.entries(quad)) {
    expect(p.x - pad, `${name} 越出画布左右`).toBeGreaterThan(0);
    expect(p.x + pad, `${name} 越出画布左右`).toBeLessThan(design.w);
    expect(p.y).toBeGreaterThan(0);
    expect(p.y).toBeLessThan(design.h);
  }
});

test('棋盘不与左右头像框重叠（头像框 y 50~270、x 20~220 / 780~980）', () => {
  for (const y of [50, 120, 200, 270]) {
    const { left, right } = extentAt(y);
    expect(left, `y=${y} 时压到红方头像框`).toBeGreaterThan(220);
    expect(right, `y=${y} 时压到蓝方头像框`).toBeLessThan(780);
  }
});

test('棋盘不与剩余子数面板、回合条、认输按钮重叠', () => {
  for (const y of [300, 350, 400]) {
    const { left, right } = extentAt(y);
    expect(left, `y=${y} 时压到左侧面板`).toBeGreaterThan(195);
    expect(right, `y=${y} 时压到右侧面板`).toBeLessThan(805);
  }

  // 回合条 y 112~146
  expect(quad.tl.y).toBeGreaterThan(146);

  // 认输按钮在 (440,584) 120x43 → 底边 627
  const giveup = blockOf('.imgbtn.b-giveup');
  const gTop = num(giveup, /top:\s*([\d.]+)px/);
  const gLeft = num(giveup, /left:\s*([\d.]+)px/);
  const gWidth = num(blockOf('.imgbtn.b-clean'), /width:\s*([\d.]+)px/);
  expect(gTop).toBe(584);
  expect(gLeft).toBe(440);
  expect(gWidth, '全站按钮只有一种尺寸（button_clean 120x43）').toBe(120);
  expect(quad.bl.y, '棋盘下缘压到认输按钮了').toBeLessThan(gTop!);
});

test('开始界面的两个模式按钮在棋盘区域之外（它俩是独立的一屏）', () => {
  const a = blockOf('.imgbtn.b-start-a');
  const b = blockOf('.imgbtn.b-start-b');
  expect(num(a, /top:\s*([\d.]+)px/)).toBe(500);
  expect(num(b, /top:\s*([\d.]+)px/)).toBe(500);
  expect(num(a, /left:\s*([\d.]+)px/)).toBe(300);
  expect(num(b, /left:\s*([\d.]+)px/)).toBe(555);

  // 四字按钮回到原素材的 145x52（button_clean 等比放大），两枚之间才留得出间隙
  const long = blockOf('.imgbtn.b-clean.is-long');
  expect(num(long, /width:\s*([\d.]+)px/)).toBe(145);
  expect(num(long, /height:\s*([\d.]+)px/)).toBe(52);
  expect(num(long, /font-weight(?:\s*|:\s*)(\d+)/)).toBe(400);
});

test('结算面板不能复用 HUD 的 .panel（会多出一圈蓝框）', () => {
  const panel = blockOf('#modal .result-panel');
  expect(panel).toContain('wait_panel.webp');
  expect(panel, '结算面板只要那张共用底板，不要边框/渐变').not.toMatch(/border(-radius)?:\s*[1-9]/);
  expect(css, '结算面板别再用 .panel 这个类名').not.toMatch(/#modal\s+\.panel\s*\{/);
});

test('引用的素材都存在', () => {
  const files = [
    join(ROOT, 'index.html'),
    join(ROOT, 'src/styles.css'),
    ...readdirSync(join(ROOT, 'src'), { recursive: true, encoding: 'utf8' })
      .filter((f) => /\.tsx?$/.test(f))
      .filter((f) => !/\.test\.tsx?$/.test(f))
      .map((f) => join(ROOT, 'src', f)),
  ];
  const referenced = new Set<string>();
  for (const file of files) {
    const text = readFileSync(file, 'utf8');
    // 两种写法都覆盖：'/assets/a.png' 与模板串 `${A}/a.png`
    // webp / svg 也收进来 —— 素材换成这两种格式后，漏检等于没检
    for (const m of text.matchAll(/[\w-]+\.(?:png|jpe?g|ico|webp|svg)/g)) referenced.add(m[0]);
  }
  expect(referenced.size).toBeGreaterThanOrEqual(8);
  for (const name of referenced) {
    expect(existsSync(join(ROOT, 'public/assets', name)), `素材缺失：${name}`).toBe(true);
  }
});

test('index.html 提供了挂载点与入口', () => {
  expect(html).toContain('id="root"');
  expect(html).toContain('/src/main.tsx');
  expect(html).toContain('lang="zh-CN"');
});

/* ---------------- 覆盖层不能吃掉棋盘的点击 ----------------
   这一组守的是 jsdom 结构性抓不到的一类问题：fireEvent.click 是直接派发到目标元素的，
   绕开了命中测试，所以"有层东西盖在棋盘上"在测试里完全看不出来，真机却一个子都翻不动。
   真实翻车：#heads / #controls 都是 inset:0 铺满舞台、DOM 顺序又排在 Board 之后，
   于是画在棋盘上方接管了全部点击（当时只有 #panels 写了 inert）。 */
test('铺满舞台的覆盖层必须关掉指针事件（否则真机上点不动棋盘）', () => {
  // 白名单：这几个确实需要指针事件，且都有理由
  const allowed = new Set([
    '#game', // 所有层的父容器，不是棋盘的同级覆盖层
    '#bg', // 排在棋盘之前画，在下面
    '#board', // 棋盘本体，格子就在它里
    '#start', // 开始界面那一屏，两个模式按钮就在它里
    '#lobby', // 联机大厅那一屏：和 #start 一样是整屏替换，不是盖在棋盘上的浮层
    '#reveal', // 开局揭晓颜色：故意挡住这 1.5 秒里的误点，播完就卸载
    '#modal', // 终局弹窗，本来就该挡住棋盘
  ]);
  const clean = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const fullCover: string[] = [];
  for (const m of clean.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
    const sel = m[1]!.trim();
    const decl = m[2]!;
    if (!/^#[a-z][\w-]*$/.test(sel)) continue; // 只看单 id 选择器（层级覆盖层）
    if (!/position:\s*absolute/.test(decl) || !/inset:\s*0/.test(decl)) continue;
    fullCover.push(sel);
    if (allowed.has(sel)) continue;
    expect(decl, `${sel} 铺满舞台又没关指针事件，会盖住棋盘`).toMatch(/pointer-events:\s*none/);
  }
  // 对照组：真掃到了几个满屏层，说明上面的正则没失效
  expect(fullCover.length).toBeGreaterThanOrEqual(5);
  expect(fullCover).toContain('#heads');
  expect(fullCover).toContain('#controls');
  // 认输按钮在 #controls 里：容器关掉之后，按钮必须自己把指针事件打开
  expect(blockOf('#controls .imgbtn'), '认输按钮还得能点').toMatch(/pointer-events:\s*auto/);
});

test('压在棋盘/按钮上方的小装饰层也不该拦截点击', () => {
  for (const sel of ['#banner', '#toast']) {
    expect(blockOf(sel), `${sel} 是纯展示层`).toMatch(/pointer-events:\s*none/);
  }
});

test('终局弹窗是反例：它必须保留指针事件（终局后本来就该挡住棋盘）', () => {
  const modal = blockOf('#modal');
  expect(modal).not.toMatch(/pointer-events:\s*none/);
  expect(modal, '弹窗要压在棋盘之上').toMatch(/z-index:\s*20/);
});
