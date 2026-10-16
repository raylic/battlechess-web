// @vitest-environment jsdom
// PWA 自检：manifest / 图标 / 竖屏遮罩 / 横屏锁。
//
// 为什么值得写成测试：这一整套东西全是「错了也不报错，只在真机上静默失效」的类型 ——
// manifest 路径写歪、图标声明 512 而文件其实 200、媒体查询方向写反，
// 在桌面浏览器里一切正常，只有把手机装到主屏才发现。所以在这里用文件级断言钉死。

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';

import { lockLandscape } from './lockOrientation';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const html = readFileSync(join(ROOT, 'index.html'), 'utf8');
const css = readFileSync(join(ROOT, 'src/styles.css'), 'utf8');

type Icon = { src: string; sizes: string; type?: string; purpose?: string };
type Manifest = {
  name?: string;
  short_name?: string;
  start_url?: string;
  scope?: string;
  display?: string;
  orientation?: string;
  theme_color?: string;
  background_color?: string;
  lang?: string;
  icons?: Icon[];
};

const manifest = JSON.parse(readFileSync(join(ROOT, 'public/manifest.webmanifest'), 'utf8')) as Manifest;
const icons: Icon[] = manifest.icons ?? [];

/** 从 PNG 字节里读真实尺寸：签名 8 + 长度 4 + 'IHDR' 4 + 宽 4 + 高 4 */
function pngSize(file: string): { w: number; h: number } {
  const buf = readFileSync(file);
  expect(buf.subarray(1, 4).toString('latin1'), `${file} 不是 PNG`).toBe('PNG');
  return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
}

/* ------------------------------- manifest ------------------------------- */

test('manifest 的必备字段都在（缺一个就不能安装）', () => {
  expect(manifest.name).toBeTruthy();
  expect(manifest.short_name, 'short_name 太长会被主屏截断').toBeTruthy();
  expect(manifest.lang).toBe('zh-CN');
  expect(manifest.display).toBe('standalone');
  expect(manifest.theme_color).toBe('#0d1117');
  expect(manifest.background_color, 'background_color 要和启动时的底色一致，否则开屏闪白').toBe('#0d1117');
});

test('manifest 强制横屏：orientation 必须是 landscape', () => {
  // 这一条只在"装到主屏 / 独立窗口"后生效（规范：display mode = browser 时忽略），
  // 浏览器标签页里靠的是 styles.css 的 #rotate 遮罩 + lockOrientation() 补刀。
  expect(manifest.orientation).toBe('landscape');
});

test('manifest 里的 URL 全是相对路径（换 base / 换域名都不用改它）', () => {
  // Vite 只处理 index.html 与 src/ 里的引用，public/ 下的文件是原样拷贝的。
  // 所以 manifest 里不能写 /battlechess-web/ 这种绝对路径 —— 否则 BASE_PATH=/ 打出来的包，
  // 装到主屏后 start_url 会指向一个不存在的路径。相对 URL 按"manifest 自身的位置"解析，
  // 天然跟着 base 走。
  expect(manifest.start_url).toBe('./');
  expect(manifest.scope).toBe('./');
  for (const u of [manifest.start_url, manifest.scope, ...icons.map((i) => i.src)]) {
    expect(u?.startsWith('/'), `${u} 是绝对路径，会被 base 坑到`).toBe(false);
  }
});

test('manifest 引用的图标都真的存在，且声明尺寸 == 文件真实尺寸', () => {
  expect(icons.length).toBeGreaterThan(0);
  for (const icon of icons) {
    const file = join(ROOT, 'public', icon.src);
    expect(existsSync(file), `manifest 引用了不存在的图标：${icon.src}`).toBe(true);
    expect(icon.type).toBe('image/png');
    const [w, h] = icon.sizes.split('x').map(Number);
    // 声明 512 而文件是 200 的话，Chrome 会静默判定"不满足安装条件"，很难查
    expect(pngSize(file), `${icon.src} 声称 ${icon.sizes}`).toEqual({ w, h });
  }
});

test('图标覆盖 Chrome 的安装门槛，并且带一个 maskable 变体', () => {
  const sizes = new Set(icons.map((i) => i.sizes));
  expect(sizes.has('192x192'), '缺 192x192（Chrome 的安装门槛之一）').toBe(true);
  expect(sizes.has('512x512'), '缺 512x512（Chrome 的安装门槛之一）').toBe(true);
  // Android 会把主屏图标裁成圆形/方形，没有 maskable 变体的话图案边缘会被切掉
  expect(
    icons.some((i) => i.purpose === 'maskable'),
    '缺 purpose: maskable 的图标',
  ).toBe(true);
});

test('apple-touch-icon 是 iOS 认的 PNG（iOS 不认 .ico）', () => {
  const file = join(ROOT, 'public/assets/apple-touch-icon.png');
  expect(existsSync(file)).toBe(true);
  expect(pngSize(file)).toEqual({ w: 180, h: 180 });
});

/* ------------------------------ index.html ------------------------------ */

test('index.html 挂上了 PWA 需要的标签', () => {
  expect(html).toMatch(/rel="manifest"\s+href="\/manifest\.webmanifest"/);
  expect(html).toMatch(/rel="apple-touch-icon"/);
  expect(html).toMatch(/name="theme-color"\s+content="#0d1117"/);
  expect(html, 'iOS 全屏需要这个（Safari 不读 manifest 的 display）').toContain(
    'name="apple-mobile-web-app-capable"',
  );
});

test('viewport 允许铺到刘海区并禁掉缩放', () => {
  expect(html, 'viewport-fit=cover：横屏时刘海在左右两侧').toContain('viewport-fit=cover');
  expect(html).toContain('width=device-width');
  expect(html).toContain('user-scalable=no');
});

/* ----------------------------- 竖屏遮罩 ----------------------------- */

test('竖屏遮罩写在 index.html 里，而不是 React 里', () => {
  // 放在 React 根之外是为了"首帧就对"：JS 还没挂载（甚至挂了）的时候，
  // 竖屏用户看到的已经是提示，而不是一个缩成 390x253 的棋盘。
  expect(html).toContain('id="rotate"');
  expect(html).toMatch(/请把手机横过来/);
});

test('竖屏遮罩：默认隐藏，只在「竖屏 + 触屏」时出现', () => {
  const clean = css.replace(/\/\*[\s\S]*?\*\//g, '');

  const base = /#rotate\s*\{([^}]*)\}/.exec(clean);
  expect(base, 'styles.css 里找不到 #rotate 的基础规则').not.toBeNull();
  expect(base![1], '默认必须隐藏').toMatch(/display:\s*none/);

  // 必须是 fixed：竖屏时舞台只缩到 0.39 倍，遮罩挂在舞台里会跟着一起缩
  expect(base![1], '遮罩要相对视口定位').toMatch(/position:\s*fixed/);

  const mq = /@media\s*\(orientation:\s*portrait\)\s*and\s*\(pointer:\s*coarse\)\s*\{([\s\S]*?)\n\}/.exec(clean);
  expect(mq, '找不到「竖屏 + 触屏」这条媒体查询').not.toBeNull();
  expect(mq![1], '媒体查询里要把它打开').toMatch(/#rotate\s*\{[^}]*display:\s*flex/);

  // 反面：不能有第二处把它打开（比如手滑写成无条件 display:flex）
  const shown = [...clean.matchAll(/#rotate\s*\{([^}]*)\}/g)].filter((m) => /display:\s*flex/.test(m![1]));
  expect(shown.length, '打开 #rotate 的地方只该有那条媒体查询').toBe(1);

  // (pointer: coarse) 是为了不误伤桌面：桌面把窗口拉窄拉高不该弹这个
  expect(clean, '缺 (pointer: coarse) 会在桌面上误弹').toContain('(pointer: coarse)');
});

/* ------------------------------ 横屏锁 ------------------------------ */

/** 临时替换 screen.orientation，跑完还原（jsdom 里它默认不存在） */
function withOrientation(value: unknown, fn: () => void): void {
  const original = Object.getOwnPropertyDescriptor(screen, 'orientation');
  Object.defineProperty(screen, 'orientation', { value, configurable: true });
  try {
    fn();
  } finally {
    if (original) Object.defineProperty(screen, 'orientation', original);
    else delete (screen as { orientation?: unknown }).orientation;
  }
}

const pointerdown = () => window.dispatchEvent(new Event('pointerdown'));

test('能锁就锁成 landscape，并在首次交互后再补一次', () => {
  // 页面加载时 Chrome 通常拒绝（要求用户手势），所以首次 pointerdown 要再试
  const calls: string[] = [];
  withOrientation(
    {
      lock: (o: string) => {
        calls.push(o);
        return Promise.resolve();
      },
    },
    () => {
      lockLandscape();
      expect(calls).toEqual(['landscape']);
      pointerdown();
      expect(calls).toEqual(['landscape', 'landscape']);
      pointerdown();
      expect(calls, '只补一次（once: true）').toHaveLength(2);
    },
  );
});

test('锁失败不能抛出去（被拒是常态，不该污染控制台）', () => {
  withOrientation(
    { lock: () => Promise.reject(new Error('NotAllowedError')) },
    () => {
      expect(() => lockLandscape()).not.toThrow();
      expect(() => pointerdown()).not.toThrow();
    },
  );
});

test('iOS Safari（没有 screen.orientation）时安全跳过', () => {
  withOrientation(undefined, () => {
    expect(() => lockLandscape()).not.toThrow();
  });
  // 有 orientation 但没 lock 的情况也要挡住
  withOrientation({}, () => {
    expect(() => lockLandscape()).not.toThrow();
    expect(() => pointerdown()).not.toThrow();
  });
});

/* ---------------------- 移动端手感（CSS） ---------------------- */

test('移动端画布的手感补丁都在', () => {
  const clean = css.replace(/\/\*[\s\S]*?\*\//g, '');
  expect(clean, '防下拉刷新').toMatch(/overscroll-behavior:\s*none/);
  expect(clean, '去掉双击缩放').toMatch(/touch-action:\s*manipulation/);
  expect(clean, '防长按选中').toMatch(/user-select:\s*none/);
});
