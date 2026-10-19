// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { expect, test, vi } from 'vitest';

import type { Client } from '../transport/local';
import type { ServerMsg, Side, ViewState } from '../core/types';
import { useSession } from './useSession';

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const states = (msgs: ServerMsg[]): ViewState[] =>
  msgs.filter((m): m is { t: 'state'; state: ViewState } => m.t === 'state').map((m) => m.state);

/** jsdom 里没有 SharedWorker，双窗口模式注入一个假 client */
const fakeClient = (side: Side | null): Client & { sent: unknown[] } => {
  const sent: unknown[] = [];
  return {
    side,
    sent,
    onmessage: () => {},
    send: (msg) => sent.push(msg),
    close: () => {},
  };
};

test('start("ai")：建出人机会话，红方是人类、蓝方有独立 client，且拿得到真相', async () => {
  const { result } = renderHook(() => useSession(500));
  const received: ServerMsg[] = [];

  act(() => {
    const session = result.current.start('ai');
    // 挂 onmessage 必须在下一个宏任务之前完成（初始 state 是 setTimeout 0 下发的）
    session.client.onmessage = (m) => received.push(m);
    session.aiClient!.onmessage = (m) => received.push(m);
  });

  const session = result.current.session!;
  expect(session.mode).toBe('ai');
  expect(session.side, '人类执红').toBe('red');
  expect(session.aiClient, 'AI 也要有自己的 client').not.toBeNull();
  expect(session.authority, '单机模式才有真相').not.toBeNull();
  expect(session.seed).toBe(500);

  await tick();
  // 两个 client 各自收到自己的视角：红方先手、蓝方没有合法着法
  expect(received.length).toBeGreaterThanOrEqual(2);
  const views = states(received);
  expect(views.map((v) => v.you).sort()).toEqual(['blue', 'red']);
  expect(views.find((v) => v.you === 'red')!.legal.flips.length).toBe(36);
  expect(views.find((v) => v.you === 'blue')!.legal.flips.length).toBe(0);
});

test('start("hotseat")：side 为 null，可以替任意一方操作', () => {
  const { result } = renderHook(() => useSession(1));
  act(() => {
    result.current.start('hotseat');
  });
  expect(result.current.session!.side).toBeNull();
  expect(result.current.session!.aiClient, '热座没有 AI').toBeNull();
});

test('start("dual")：开第二个窗口，本窗口当红方；注入 openWindow / createWorker 便于测试', () => {
  const openWindow = vi.fn();
  const createWorker = vi.fn((_seed: number, side: Side) => fakeClient(side));
  const { result } = renderHook(() => useSession(777, { openWindow, createWorker }));

  act(() => {
    result.current.start('dual');
  });

  expect(result.current.session!.side).toBe('red');
  expect(createWorker).toHaveBeenCalledWith(777, 'red');
  expect(openWindow).toHaveBeenCalledTimes(1);
  const [url, name, features] = openWindow.mock.calls[0]!;
  expect(url).toContain('mode=dual');
  expect(url).toContain('side=blue');
  expect(url).toContain('seed=777');
  expect(name).toBe('battlechess-blue');
  expect(features).toContain('1030');
});

test('start("dual", "blue")：从 URL 直接进来的那一侧不再开窗口', () => {
  const openWindow = vi.fn();
  const createWorker = vi.fn((_seed: number, side: Side) => fakeClient(side));
  const { result } = renderHook(() => useSession(777, { openWindow, createWorker }));

  act(() => {
    result.current.start('dual', 'blue');
  });

  expect(result.current.session!.side).toBe('blue');
  expect(createWorker).toHaveBeenCalledWith(777, 'blue');
  expect(openWindow).not.toHaveBeenCalled();
});

test('不支持 SharedWorker 的浏览器：dual 自动退回单机热座，而不是把整页搞崩', () => {
  // 不注入 createWorker，而 jsdom 本来就没有 SharedWorker
  expect(typeof SharedWorker).toBe('undefined');
  const { result } = renderHook(() => useSession(1));
  act(() => {
    result.current.start('dual');
  });
  expect(result.current.session!.mode).toBe('hotseat');
  expect(result.current.session!.side).toBeNull();
});

test('restart：种子 +1，并把新种子发给权威（棋盘真的换了一盘）', async () => {
  const { result } = renderHook(() => useSession(100));
  act(() => {
    result.current.start('ai');
  });
  const session = result.current.session!;
  const boardBefore = JSON.stringify(session.authority!.truth().grid);

  act(() => {
    result.current.restart();
  });
  await tick();

  expect(result.current.seed, '界面上的种子要跟着变').toBe(101);
  expect(session.authority!.truth().seed, '权威真的换盘了').toBe(101);
  expect(JSON.stringify(session.authority!.truth().grid)).not.toBe(boardBefore);
  expect(result.current.session, '换盘不重建会话（同一局继续）').toBe(session);
});

test('连点两次"再来一局"：种子必须每次都往前走（曾经卡在 +1）', async () => {
  const { result } = renderHook(() => useSession(200));
  act(() => {
    result.current.start('ai');
  });
  const session = result.current.session!;

  const boards = [JSON.stringify(session.authority!.truth().grid)];
  const seeds: number[] = [];
  for (let i = 0; i < 3; i++) {
    act(() => {
      result.current.restart();
    });
    await tick();
    seeds.push(result.current.seed);
    boards.push(JSON.stringify(session.authority!.truth().grid));
  }

  expect(seeds).toEqual([201, 202, 203]);
  expect(session.authority!.truth().seed).toBe(203);
  // 四次盘面两两不同（真换了盘，不是发同一个种子）
  expect(new Set(boards).size).toBe(boards.length);
});

test('换盘会把种子写回地址栏（刷新/分享/复盘拿到的是同一盘）', async () => {
  window.history.replaceState(null, '', '/?mode=ai&seed=300');
  const { result } = renderHook(() => useSession(300));
  act(() => {
    result.current.start('ai');
  });
  act(() => {
    result.current.restart();
  });
  await tick();
  expect(new URL(window.location.href).searchParams.get('seed')).toBe('301');
  expect(new URL(window.location.href).searchParams.get('mode')).toBe('ai');
});

test('back：会话清空，且旧 client 的退订真的生效（再广播它收不到）', async () => {
  const { result } = renderHook(() => useSession(8));
  act(() => {
    result.current.start('ai');
  });
  const session = result.current.session!;
  const received: ServerMsg[] = [];
  session.client.onmessage = (m) => received.push(m);
  await tick();
  expect(received.length, '订阅后应当收到初始 state').toBe(1);

  act(() => {
    result.current.back();
  });
  expect(result.current.session).toBeNull();

  // 权威还在（被旧 session 引用着），但旧 client 已经不听了
  session.authority!.dispatch(null, { t: 'restart', seed: 999 });
  await tick();
  expect(received.length, '退订之后不该再收到广播').toBe(1);
});

test('切换模式：新建会话不会复用旧会话的 client', async () => {
  const { result } = renderHook(() => useSession(3));

  act(() => {
    result.current.start('ai');
  });
  const first = result.current.session!;

  act(() => {
    result.current.start('hotseat');
  });
  const second = result.current.session!;

  expect(second).not.toBe(first);
  expect(second.authority).not.toBe(first.authority);

  const stale: ServerMsg[] = [];
  first.client.onmessage = (m) => stale.push(m);
  await tick();
  expect(stale.length, '旧 client 已经退订，收不到任何东西').toBe(0);
});

// ── 联机（房主/客人） ────────────────────────────────────
// 真 peerjs 要 WebRTC，这里只验"会话层的账"：种子覆盖、host 句柄透出、房主/客人的角色。

test('start("online", "red", {seed})：房主会话带 host 句柄，种子按房间号覆盖', async () => {
  const { result } = renderHook(() => useSession(999));
  let session!: ReturnType<typeof result.current.start>;
  act(() => {
    session = result.current.start('online', 'red', { seed: 4821 });
  });

  expect(session.mode).toBe('online');
  expect(session.side).toBe('red');
  expect(session.seed, '房主建房时种子 = 四位数房号').toBe(4821);
  expect(result.current.seed).toBe(4821);
  expect(session.host, '房主才有 host 句柄').toBeTruthy();
  expect(session.authority, '房主的权威在本页').toBeTruthy();
  expect(session.host!.invitation).toBeInstanceOf(Promise);

  // 房间起不来（jsdom 里没有 WebRTC）也算正常：invitation 要么 resolve 要么 reject，
  // 关键是 onGuest 的订阅/退订不能抛
  const off = session.host!.onGuest(() => {});
  expect(off).toBeTypeOf('function');
  off();
  act(() => result.current.back());
});

test('start("online", "blue", {hostId, seed})：客人会话没有 host 句柄，种子跟着链接走', () => {
  const { result } = renderHook(() => useSession(1));
  let session!: ReturnType<typeof result.current.start>;
  act(() => {
    session = result.current.start('online', 'blue', { seed: 4821, hostId: 'battlechess-4821' });
  });

  expect(session.side).toBe('blue');
  expect(session.seed).toBe(4821);
  expect(session.host, '客人不建房').toBeUndefined();
  expect(session.authority, '真相在房主那边').toBeNull();
  act(() => result.current.back());
});
