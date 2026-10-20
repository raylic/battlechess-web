// @vitest-environment jsdom
// 首页预热：清单要覆盖对局第一帧的图、省流量要跳过、重复调用只发一遍。
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { beforeEach, expect, test, vi } from 'vitest';

import { GAME_ASSETS, prefetchGameAssets, resetPrefetchForTest } from './prefetch';

const ROOT = join(import.meta.dirname, '..', '..');

beforeEach(() => {
  resetPrefetchForTest();
});

test('清单里的素材都真的存在（漏一个就是首帧白图）', () => {
  expect(GAME_ASSETS.length).toBeGreaterThanOrEqual(8);
  for (const name of GAME_ASSETS) {
    expect(existsSync(join(ROOT, 'public/assets', name)), `素材缺失：${name}`).toBe(true);
  }
});

test('第一帧要用的几张排在最前面（先到先得，弱网也只差这几张）', () => {
  expect(GAME_ASSETS.slice(0, 5)).toEqual([
    'board-flat.webp',
    'chess.webp',
    'unopen.webp',
    'chess-mini.webp',
    'back-mini.webp',
  ]);
  // 两块名牌也在棋盘之前用得上
  expect(GAME_ASSETS).toContain('head_red.webp');
  expect(GAME_ASSETS).toContain('head_blue.webp');
});

test('全部加载一遍：每张只请求一次，且都带 base 前缀', async () => {
  const seen: string[] = [];
  await prefetchGameAssets({
    load: async (url) => {
      seen.push(url);
    },
    idle: (run) => run(),
    shouldSkip: () => false,
  });
  expect(seen).toHaveLength(GAME_ASSETS.length);
  expect(new Set(seen).size).toBe(GAME_ASSETS.length);
  for (const url of seen) expect(url).toMatch(/^\/.*assets\/[\w.-]+\.(webp|jpg)$/);
});

test('幂等：第二次调用不再发请求（回首页 / StrictMode 双挂载）', async () => {
  const load = vi.fn(async () => {});
  const opts = { load, idle: (run: () => void) => run(), shouldSkip: () => false };
  await prefetchGameAssets(opts);
  const first = load.mock.calls.length;
  await prefetchGameAssets(opts);
  expect(load.mock.calls.length).toBe(first);
});

test('省流量 / 慢网：一张都不下', async () => {
  const load = vi.fn(async () => {});
  await prefetchGameAssets({ load, idle: (run) => run(), shouldSkip: () => true });
  expect(load).not.toHaveBeenCalled();
});

test('单张失败不影响其它（预热失败绝不能拖累首页）', async () => {
  const ok: string[] = [];
  await prefetchGameAssets({
    load: async (url) => {
      if (url.includes('chess.webp')) throw new Error('boom');
      ok.push(url);
    },
    idle: (run) => run(),
    shouldSkip: () => false,
  });
  // 失败那张不算数，但其余的应该都下完了
  expect(ok.length).toBe(GAME_ASSETS.length - 1);
});

test('空闲调度：不在调用栈里立刻开跑（不抢首页首帧）', async () => {
  const load = vi.fn(async () => {});
  let scheduled: (() => void) | null = null;
  const done = prefetchGameAssets({
    load,
    idle: (run) => {
      scheduled = run;
    },
    shouldSkip: () => false,
  });
  expect(load).not.toHaveBeenCalled();
  expect(scheduled).not.toBeNull();
  scheduled!();
  await done;
  expect(load).toHaveBeenCalledTimes(GAME_ASSETS.length);
});
