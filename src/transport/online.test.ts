// @vitest-environment jsdom
// 邀请链接是联机模式唯一的"入口契约"：房主把自己的 URL 换成对方视角那一份。
// 这里只测纯函数 —— createOnlineHost/Client 要真 WebRTC，交给手测（见 README「联网」）。

import { expect, test } from 'vitest';

import { inviteUrl } from './online';

test('邀请链接把视角翻成对方那一方，并带上 host 与种子', () => {
  window.history.replaceState(null, '', '/battlechess-web/?mode=online&seed=42&side=red&ai=net');
  const link = inviteUrl('battlechess-42', 42, 'red');
  expect(link).toBeTruthy();

  const url = new URL(link!);
  expect(url.pathname).toBe('/battlechess-web/');
  expect(url.searchParams.get('mode')).toBe('online');
  expect(url.searchParams.get('host')).toBe('battlechess-42');
  expect(url.searchParams.get('seed')).toBe('42');
  expect(url.searchParams.get('side'), '房主是红方，邀请来的就是蓝方').toBe('blue');
  expect(url.searchParams.get('ai'), '单机参数不该带进邀请链接').toBeNull();
});

test('房主执蓝时，邀请来的是红方', () => {
  window.history.replaceState(null, '', '/battlechess-web/');
  const url = new URL(inviteUrl('battlechess-7', 7, 'blue')!);
  expect(url.searchParams.get('side')).toBe('red');
  expect(url.searchParams.get('seed')).toBe('7');
});

// ── 装配层 ────────────────────────────────────────────────
// `online.ts` 的价值全在"async 世界里的同步外壳"：createSession 必须同步返回，
// 所以客人在连上之前发送的消息要排队、收到的消息要压着。这里用假 peer 模块钉住这些时序。

vi.mock('./peer', () => ({
  createPeerClient: vi.fn(),
  attachPeerHost: vi.fn(),
}));

// 中继探测这里换成假的：真实现会去打 VITE_TURN_ENDPOINT（测试不许上网）
vi.mock('./ice', () => ({
  iceEnvFromImportMeta: () => ({}),
  clearIceCache: vi.fn(),
  resolveIceServers: vi.fn(),
}));

import { afterEach, vi } from 'vitest';
import * as peerModule from './peer';
import { createOnlineClient, createOnlineHost, loadPeer, probeRelay } from './online';
import { resolveIceServers } from './ice';
import type { Client } from './local';
import type { ClientMsg, ServerMsg } from '../core/types';

const createPeerClient = vi.mocked(peerModule.createPeerClient);
const resolveIce = vi.mocked(resolveIceServers);
const attachPeerHost = vi.mocked(peerModule.attachPeerHost);

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

afterEach(() => {
  vi.clearAllMocks();
});

/** 假 Client：记录发出的消息，可以手动塞服务端消息 */
function fakeClient(side: 'red' | 'blue') {
  const sent: ClientMsg[] = [];
  let handler: (msg: ServerMsg) => void = () => {};
  let closed = false;
  const client: Client = {
    side,
    get onmessage() {
      return handler;
    },
    set onmessage(fn: (msg: ServerMsg) => void) {
      handler = fn;
    },
    send(msg) {
      sent.push(msg);
    },
    close() {
      closed = true;
    },
  };
  return {
    client,
    sent,
    isClosed: () => closed,
    deliver: (msg: ServerMsg) => handler(msg),
  };
}

test('loadPeer 只动态加载一次（多次调用复用同一个 promise）', () => {
  expect(loadPeer()).toBe(loadPeer());
});

test('客人：连上之前 send 排队，连上后按序补发', async () => {
  let resolveReady: (c: Client) => void = () => {};
  createPeerClient.mockReturnValueOnce(
    new Promise<Client>((resolve) => {
      resolveReady = resolve;
    }),
  );

  const client = createOnlineClient('battlechess-1', 1, 'blue');
  client.send({ t: 'flip', at: [0, 0] });
  client.send({ t: 'flip', at: [0, 1] });

  const inner = fakeClient('blue');
  resolveReady(inner.client);
  await tick();
  await tick();

  expect(inner.sent).toEqual([
    { t: 'flip', at: [0, 0] },
    { t: 'flip', at: [0, 1] },
  ]);
});

test('客人：onmessage 挂上之前收到的消息不丢（赋值那一刻同步冲出来）', async () => {
  let resolveReady: (c: Client) => void = () => {};
  createPeerClient.mockReturnValueOnce(
    new Promise<Client>((resolve) => {
      resolveReady = resolve;
    }),
  );

  const client = createOnlineClient('battlechess-1', 1, 'blue');
  const inner = fakeClient('blue');
  resolveReady(inner.client);
  await tick();

  // 还没挂 onmessage，先来一条
  inner.deliver({ t: 'reject', reason: '房主已经关闭了这个房间' });

  const got: ServerMsg[] = [];
  client.onmessage = (msg) => got.push(msg);
  expect(got).toHaveLength(1);
  expect(got[0]).toEqual({ t: 'reject', reason: '房主已经关闭了这个房间' });
});

test('客人：连不上时变成一条 reject（UI 拿它当错误行）', async () => {
  createPeerClient.mockRejectedValueOnce(new Error('房间不存在，或房主已经关闭了这个房间'));

  const client = createOnlineClient('battlechess-1', 1, 'blue');
  const got: ServerMsg[] = [];
  client.onmessage = (msg) => got.push(msg);
  await tick();
  await tick();

  expect(got).toEqual([{ t: 'reject', reason: '联机失败：房间不存在，或房主已经关闭了这个房间' }]);
});

test('客人：连上之前就 close，则丢弃排队消息并把底层连接直接关掉', async () => {
  let resolveReady: (c: Client) => void = () => {};
  createPeerClient.mockReturnValueOnce(
    new Promise<Client>((resolve) => {
      resolveReady = resolve;
    }),
  );

  const client = createOnlineClient('battlechess-1', 1, 'blue');
  client.send({ t: 'flip', at: [0, 0] });
  client.close();

  const inner = fakeClient('blue');
  resolveReady(inner.client);
  await tick();
  await tick();

  expect(inner.isClosed()).toBe(true);
  expect(inner.sent, 'close 之后不该再补发').toHaveLength(0);
});

test('房主：invitation 是邀请链接本身（host/seed/对方视角都在）', async () => {
  window.history.replaceState(null, '', '/battlechess-web/');
  attachPeerHost.mockResolvedValueOnce({ hostId: 'battlechess-7', destroy: vi.fn() });

  const host = createOnlineHost(7, 'red');
  const url = new URL(await host.invitation);

  expect(url.searchParams.get('mode')).toBe('online');
  expect(url.searchParams.get('host')).toBe('battlechess-7');
  expect(url.searchParams.get('seed'), '缺 seed 会被房主自己判"不是这一盘棋"').toBe('7');
  expect(url.searchParams.get('side')).toBe('blue');

  host.destroy();
});

test('房主：邀请链接用 attachPeerHost 返回的 hostId（撞号退化成随机 id 时靠它）', async () => {
  window.history.replaceState(null, '', '/battlechess-web/');
  attachPeerHost.mockResolvedValueOnce({ hostId: 'battlechess-7-ab12cd34', destroy: vi.fn() });

  const host = createOnlineHost(7, 'red');
  const url = new URL(await host.invitation);
  expect(url.searchParams.get('host')).toBe('battlechess-7-ab12cd34');
  host.destroy();
});

test('房主：房间起不来时，错误塞给自己的 client（界面会当 toast / 错误行）', async () => {
  attachPeerHost.mockRejectedValueOnce(new Error('信令服务器连不上（PeerJS 公共云）'));

  const host = createOnlineHost(8, 'red');
  const got: ServerMsg[] = [];
  host.client.onmessage = (msg) => got.push(msg);

  await host.invitation.catch(() => {});
  await tick();

  expect(got.some((m) => m.t === 'reject' && m.reason.includes('信令服务器连不上'))).toBe(true);
  host.destroy();
});

test('房主：destroy 之后房间才起来 → 立刻关掉并拒绝 invitation', async () => {
  let resolveAttach: (v: { hostId: string; destroy: () => void }) => void = () => {};
  attachPeerHost.mockReturnValueOnce(
    new Promise((resolve) => {
      resolveAttach = resolve;
    }),
  );

  const host = createOnlineHost(9, 'red');
  host.destroy();
  const destroy = vi.fn();
  resolveAttach({ hostId: 'battlechess-9', destroy });

  await expect(host.invitation).rejects.toThrow('房间已关闭');
  expect(destroy, '起来之后发现已经销毁，要把 peer 关掉，别留个孤儿房间').toHaveBeenCalled();
});

test('房主：客人握手成功时回调 onGuest（界面靠它从"等待房间"切到棋盘）', async () => {
  let fireGuest: ((side: 'red' | 'blue') => void) | undefined;
  let captured: { onGuest?: (side: 'red' | 'blue') => void } | undefined;
  attachPeerHost.mockImplementationOnce(async (_auth, _seed, _side, opts) => {
    captured = opts as { onGuest?: (side: 'red' | 'blue') => void };
    return { hostId: 'battlechess-5', destroy: vi.fn() };
  });

  const seen: string[] = [];
  const host = createOnlineHost(5, 'red', { onGuest: (side) => seen.push(side) });
  await host.invitation;

  fireGuest = captured?.onGuest;
  expect(fireGuest, 'onGuest 要透传给 attachPeerHost').toBeTypeOf('function');
  fireGuest!('blue');
  expect(seen).toEqual(['blue']);
  host.destroy();
});

// ── 掉线自动重连 ──────────────────────────────────────────
// "连上之后断一下这局就没了"是非局域网体验里最伤的一环：房主那一侧的棋局还在，
// 客人只是连接断了。重连成功时房主会回全量快照，棋局原样继续。

test('客人：连上之后掉线会自动重连，断线期间的操作在重连后补发', async () => {
  let lost: (() => void) | null = null;
  const first = fakeClient('blue');
  createPeerClient.mockImplementationOnce(async (opts) => {
    lost = opts!.onlost!;
    return first.client;
  });

  const client = createOnlineClient('battlechess-1', 1, 'blue');
  const got: ServerMsg[] = [];
  client.onmessage = (msg) => got.push(msg);
  await tick();
  await tick();
  expect(got, '第一次就连上了，不该有消息').toHaveLength(0);

  expect(lost, 'onlost 必须交给装配层处理（而不是底层甩一条 reject）').toBeTypeOf('function');
  lost!();
  await tick();
  expect(got[0]).toMatchObject({ t: 'reject' });
  expect((got[0] as { reason: string }).reason).toContain('正在重连');

  // 断线期间玩家还在点：先排队，重连成功后按序补发
  client.send({ t: 'flip', at: [0, 0] });
  client.send({ t: 'flip', at: [0, 1] });

  const second = fakeClient('blue');
  createPeerClient.mockImplementationOnce(async () => second.client);
  await new Promise((resolve) => setTimeout(resolve, 1_200)); // 第一次重试在 1s 后

  expect(second.sent).toEqual([
    { t: 'flip', at: [0, 0] },
    { t: 'flip', at: [0, 1] },
  ]);
  expect(got.at(-1)).toEqual({ t: 'reject', reason: '已重新连接' });

  client.close();
  createPeerClient.mockReset();
});

test('客人：重连次数用尽 → 一条「重连失败」，别无限转圈', async () => {
  vi.useFakeTimers();
  try {
    let lost: (() => void) | null = null;
    createPeerClient.mockImplementationOnce(async (opts) => {
      lost = opts!.onlost!;
      return fakeClient('blue').client;
    });

    const client = createOnlineClient('battlechess-1', 1, 'blue');
    const got: ServerMsg[] = [];
    client.onmessage = (msg) => got.push(msg);
    await vi.advanceTimersByTimeAsync(0);
    expect(lost).toBeTypeOf('function');

    createPeerClient.mockImplementation(async () => {
      throw new Error('连不上对方：双方网络都受限，需要 TURN 中继');
    });
    lost!();
    await vi.advanceTimersByTimeAsync(300_000); // 足够把所有退避走完

    const last = got.at(-1) as { t: string; reason: string };
    expect(last.t).toBe('reject');
    expect(last.reason).toMatch(/^重连失败：/);
    expect(last.reason).toMatch(/已重试 8 次/);

    client.close();
  } finally {
    createPeerClient.mockReset();
    vi.useRealTimers();
  }
});

test('客人：重连时发现房间没了 → 立刻收手，不重试', async () => {
  vi.useFakeTimers();
  try {
    let lost: (() => void) | null = null;
    createPeerClient.mockImplementationOnce(async (opts) => {
      lost = opts!.onlost!;
      return fakeClient('blue').client;
    });

    const client = createOnlineClient('battlechess-1', 1, 'blue');
    const got: ServerMsg[] = [];
    client.onmessage = (msg) => got.push(msg);
    await vi.advanceTimersByTimeAsync(0);

    createPeerClient.mockImplementation(async () => {
      throw new Error('房间不存在，或房主已经关闭了这个房间');
    });
    lost!();
    await vi.advanceTimersByTimeAsync(1_500);

    const reasons = got.map((m) => (m as { reason: string }).reason);
    expect(reasons.at(-1)).toContain('房间不存在');
    expect(reasons.filter((r) => r.includes('正在重连')), '房间没了就别再重试').toHaveLength(1);

    client.close();
  } finally {
    createPeerClient.mockReset();
    vi.useRealTimers();
  }
});

test('中继探测：第一次没探到会重试一次（瞬时失败不该被写成"没有中继"）', async () => {
  vi.useFakeTimers();
  try {
    resolveIce.mockResolvedValueOnce({ relay: false, source: 'stun-only', servers: [] });
    resolveIce.mockResolvedValueOnce({ relay: true, source: 'endpoint', servers: [] });

    const pending = probeRelay();
    await vi.advanceTimersByTimeAsync(5_000);
    await expect(pending).resolves.toEqual({ relay: true, source: 'endpoint' });
  } finally {
    resolveIce.mockReset();
    vi.useRealTimers();
  }
});

test('中继探测：退避几次都没探到 → 明确回报"没有中继"', async () => {
  vi.useFakeTimers();
  try {
    resolveIce.mockResolvedValue({ relay: false, source: 'stun-only', servers: [] });
    const pending = probeRelay();
    await vi.advanceTimersByTimeAsync(20_000);
    await expect(pending).resolves.toEqual({ relay: false, source: 'stun-only' });
  } finally {
    resolveIce.mockReset();
    vi.useRealTimers();
  }
});
