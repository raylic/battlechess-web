// @vitest-environment jsdom
// ICE 配置：来源优先级、端点的各种返回形状、降级行为。这是"跨网络能不能连"的唯一开关。
import { beforeEach, expect, test, vi } from 'vitest';

import {
  clearIceCache,
  iceEnvFromImportMeta,
  mergeIceServers,
  normalizeIceResponse,
  parseUrls,
  resolveIceServers,
  staticIceServers,
  STUN_SERVERS,
} from './ice';

beforeEach(() => {
  clearIceCache();
});

test('环境变量：去掉空串，trim 掉空白', () => {
  expect(iceEnvFromImportMeta({ VITE_TURN_URLS: ' turn:a:3478 , turn:b:3478 ' })).toEqual({
    turnUrls: 'turn:a:3478 , turn:b:3478',
    turnUser: undefined,
    turnCred: undefined,
    endpoint: undefined,
  });
  expect(iceEnvFromImportMeta({ VITE_TURN_URLS: '   ' }).turnUrls).toBeUndefined();
  expect(iceEnvFromImportMeta({ VITE_TURN_ENDPOINT: 'https://w.dev' }).endpoint).toBe('https://w.dev');
});

test('url 解析：逗号、空格、换行都能分', () => {
  expect(parseUrls('turn:a:3478,turns:b:5349')).toEqual(['turn:a:3478', 'turns:b:5349']);
  expect(parseUrls('turn:a:3478\n  turns:b:5349 ')).toEqual(['turn:a:3478', 'turns:b:5349']);
  expect(parseUrls(undefined)).toEqual([]);
  expect(parseUrls('')).toEqual([]);
});

test('静态凭据：三样缺一不可', () => {
  const full = { turnUrls: 'turn:a:3478', turnUser: 'u', turnCred: 'c' };
  expect(staticIceServers(full)).toEqual([{ urls: ['turn:a:3478'], username: 'u', credential: 'c' }]);
  expect(staticIceServers({ ...full, turnUser: undefined })).toEqual([]);
  expect(staticIceServers({ ...full, turnCred: undefined })).toEqual([]);
  expect(staticIceServers({ ...full, turnUrls: undefined })).toEqual([]);
});

test('合并：按 url 去重，后写的覆盖前面的', () => {
  const merged = mergeIceServers(
    [{ urls: 'turn:a:3478', username: 'old', credential: 'old' }],
    [{ urls: ['turn:a:3478', 'turn:b:3478'], username: 'new', credential: 'new' }],
  );
  expect(merged).toHaveLength(2);
  expect(merged.find((s) => s.urls === 'turn:a:3478')).toMatchObject({ username: 'new' });
  expect(merged.find((s) => s.urls === 'turn:b:3478')).toMatchObject({ credential: 'new' });
});

test('端点返回形状都认：Cloudflare 的 iceServers 数组 / 裸对象 / url 单数', () => {
  expect(
    normalizeIceResponse({
      iceServers: [{ urls: ['turn:cf:3478?transport=udp'], username: 'u1', credential: 'c1' }],
    }),
  ).toEqual([{ urls: 'turn:cf:3478?transport=udp', username: 'u1', credential: 'c1' }]);

  expect(normalizeIceResponse({ urls: 'turn:x:3478', username: 'u', credential: 'c' })).toEqual([
    { urls: 'turn:x:3478', username: 'u', credential: 'c' },
  ]);

  expect(normalizeIceResponse({ url: 'turns:y:5349' })).toEqual([{ urls: 'turns:y:5349' }]);
  // 垃圾输入不炸
  expect(normalizeIceResponse(null)).toEqual([]);
  expect(normalizeIceResponse({ nope: 1 })).toEqual([]);
});

test('什么都没配：只剩 STUN（多组），且明确标出没有中继', async () => {
  const ice = await resolveIceServers({ env: {} });
  expect(ice.source).toBe('stun-only');
  expect(ice.relay).toBe(false);
  // mergeIceServers 会把一组里的多个 url 摊成多条，所以按 url 集合比
  const urls = ice.servers.map((s) => s.urls);
  const expected = STUN_SERVERS.flatMap((s) => (Array.isArray(s.urls) ? s.urls : [s.urls]));
  expect(urls).toEqual(expected);
  expect(urls.every((u) => String(u).startsWith('stun:'))).toBe(true);
});

test('STUN 有国内备胎：Google 挂了也能拿到公网映射（实测成都电信全通）', () => {
  const urls = STUN_SERVERS.flatMap((s) => (Array.isArray(s.urls) ? s.urls : [s.urls]));
  expect(urls).toContain('stun:stun.l.google.com:19302');
  expect(urls).toContain('stun:stun.miwifi.com:3478');
  expect(urls).toContain('stun:stun.chat.bilibili.com:3478');
  expect(urls).toContain('stun:stun.cloudflare.com:3478');
  // 实测只有 host、拿不到 srflx 的服务器别放进来
  expect(urls).not.toContain('stun:stun.qq.com:3478');
});

test('配了静态凭据：TURN 在前、STUN 兜底，标出有中继', async () => {
  const ice = await resolveIceServers({
    env: { turnUrls: 'turn:a:3478', turnUser: 'u', turnCred: 'c' },
  });
  expect(ice.source).toBe('static');
  expect(ice.relay).toBe(true);
  expect(ice.servers[0]).toMatchObject({ username: 'u' });
  expect(ice.servers.map((s) => s.urls)).toContain('stun:stun.l.google.com:19302');
});

test('端点优先：拿到短时凭据就用它，不再叠静态凭据', async () => {
  const fetchImpl = vi.fn(async () =>
    new Response(JSON.stringify({ iceServers: [{ urls: 'turn:cf:3478', username: 'tmp', credential: 'tok' }] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }),
  );
  const ice = await resolveIceServers({
    env: { endpoint: 'https://w.dev', turnUrls: 'turn:a:3478', turnUser: 'u', turnCred: 'c' },
    fetchImpl: fetchImpl as unknown as typeof fetch,
  });
  expect(ice.source).toBe('endpoint');
  expect(ice.relay).toBe(true);
  expect(fetchImpl).toHaveBeenCalledOnce();
  expect(ice.servers.map((s) => s.urls)).toContain('turn:cf:3478');
  expect(ice.servers.map((s) => s.urls)).toContain('stun:stun.l.google.com:19302');
});

test('端点挂了：静默降级到静态凭据，不能把开房流程弄挂', async () => {
  const fetchImpl = vi.fn(async () => {
    throw new Error('network down');
  });
  const ice = await resolveIceServers({
    env: { endpoint: 'https://w.dev', turnUrls: 'turn:a:3478', turnUser: 'u', turnCred: 'c' },
    fetchImpl: fetchImpl as unknown as typeof fetch,
  });
  expect(ice.source).toBe('static');
  expect(ice.relay).toBe(true);
});

test('端点返回 500 或空 body：同样降级', async () => {
  const bad = vi.fn(async () => new Response('boom', { status: 500 }));
  expect((await resolveIceServers({ env: { endpoint: 'x' }, fetchImpl: bad as unknown as typeof fetch })).source).toBe(
    'stun-only',
  );

  clearIceCache();
  const empty = vi.fn(async () => new Response(JSON.stringify({ iceServers: [] }), { status: 200 }));
  expect(
    (await resolveIceServers({ env: { endpoint: 'x' }, fetchImpl: empty as unknown as typeof fetch })).source,
  ).toBe('stun-only');
});

test('缓存：短时间内只打一次端点（凭据本来就有 TTL）', async () => {
  const fetchImpl = vi.fn(async () =>
    new Response(JSON.stringify({ iceServers: [{ urls: 'turn:cf:3478', username: 'u', credential: 'c' }] }), {
      status: 200,
    }),
  );
  let now = 1_000_000;
  const opts = { env: { endpoint: 'https://w.dev' }, fetchImpl: fetchImpl as unknown as typeof fetch, now: () => now };

  await resolveIceServers(opts);
  now += 60_000; // 1 分钟后：还在缓存里
  await resolveIceServers(opts);
  expect(fetchImpl).toHaveBeenCalledTimes(1);

  now += 31 * 60_000; // 过了 30 分钟 TTL：重新取
  await resolveIceServers(opts);
  expect(fetchImpl).toHaveBeenCalledTimes(2);
});
