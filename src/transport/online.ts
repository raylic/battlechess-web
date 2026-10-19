// 联机模式的装配层 —— 也是 peerjs 的**唯一动态入口**。
//
// 这个文件刻意不 import peerjs：真正的实现（`peer.ts`）只经 `loadPeer()` 的
// `import()` 拉取，于是 Vite 把它切成独立 chunk。单机 / 热座 / 双窗口的玩家
// 一个字节都不用为 88 KB（24 KB gzip）的 peerjs 付费。
//
// 两种角色：
//   房主：Authority 跑在本页（同单机），自己这一方走本地直连，背景里挂一个 WebRTC 监听；
//   客人：`createOnlineClient` 先同步返回一个 Client，连上之前发的消息排队，
//         收到的消息也先攒着 —— 让 `createSession` 保持同步，React 那边不用改成 async。

import type { Authority } from '../core/authority';
import type { ClientMsg, ServerMsg, Side } from '../core/types';
import { createLocalTransport, type Client } from './local';

type PeerModule = typeof import('./peer');

let loading: Promise<PeerModule> | null = null;

/** 唯一切入点：动态加载 peerjs 实现。重复调用只加载一次 */
export function loadPeer(): Promise<PeerModule> {
  loading ??= import('./peer');
  return loading;
}

const noop = () => {};

/** 拼邀请链接：把自己的 URL 换成"对方视角"的那一份 */
export function inviteUrl(hostId: string, seed: number, hostSide: Side): string | null {
  try {
    const url = new URL(window.location.href);
    url.search = '';
    url.searchParams.set('mode', 'online');
    url.searchParams.set('host', hostId);
    url.searchParams.set('seed', String(seed));
    url.searchParams.set('side', hostSide === 'red' ? 'blue' : 'red');
    return url.toString();
  } catch {
    return null;
  }
}

export interface OnlineHostOptions {
  /** 客人握手成功时回调（UI 用它从"等待房间"切到棋盘） */
  onGuest?: (side: Side) => void;
}

export interface OnlineHost {
  /** 房主自己这一方的客户端（本地直连，不走网络） */
  client: Client;
  authority: Authority;
  /** 房间起来之后给出邀请链接；起不来就 reject */
  invitation: Promise<string>;
  destroy(): void;
}

/**
 * 房主：在本地 Authority 上挂一个 WebRTC 监听。
 *
 * 同步返回，房间在后台起来 —— 邀请链接通过 `invitation` 这个 Promise 交出去，
 * 界面拿它填 ②那屏的链接框。
 */
export function createOnlineHost(seed: number, side: Side, opts: OnlineHostOptions = {}): OnlineHost {
  const transport = createLocalTransport(seed);
  const client = transport.connect(side);
  let handle: { hostId: string; destroy(): void } | null = null;
  let destroyed = false;

  const invitation = loadPeer()
    .then((mod) => mod.attachPeerHost(transport.authority, seed, side, { onGuest: opts.onGuest }))
    .then((attached) => {
      handle = attached;
      if (destroyed) {
        attached.destroy();
        throw new Error('房间已关闭');
      }
      return inviteUrl(attached.hostId, seed, side) ?? attached.hostId;
    });

  void invitation.catch((err: unknown) => {
    const reason = err instanceof Error ? err.message : String(err);
    console.warn(`[联机] 房间启动失败：${reason}`);
    // 让界面也能看到：当成一条 reject 塞给自己的 client（会变成 toast）
    client.onmessage({ t: 'reject', reason: `联机失败：${reason}` });
  });

  return {
    client,
    authority: transport.authority,
    invitation,
    destroy() {
      if (destroyed) return;
      destroyed = true;
      handle?.destroy();
      client.close();
    },
  };
}

/**
 * 客人：同步返回一个 Client，背后异步连房主。
 *
 * 缓冲存在的理由和 `local.ts` 里那段注释一样：`useGame` 在 layout effect 里才挂
 * `onmessage`，第一条 state 可能先到；而 `send` 也可能发生在连上之前。
 */
export function createOnlineClient(hostId: string, seed: number, side: Side): Client {
  const outbox: ClientMsg[] = [];
  const inbox: ServerMsg[] = [];
  let inner: Client | null = null;
  let handler: ((msg: ServerMsg) => void) | null = null;
  let closed = false;

  const emit = (msg: ServerMsg) => {
    if (handler) handler(msg);
    else inbox.push(msg);
  };

  const client: Client = {
    side,
    get onmessage() {
      return handler ?? noop;
    },
    set onmessage(fn: (msg: ServerMsg) => void) {
      handler = fn;
      if (inner) inner.onmessage = emit;
      for (const msg of inbox.splice(0)) fn(msg);
    },
    send(msg) {
      if (closed) return;
      if (inner) inner.send(msg);
      else outbox.push(msg);
    },
    close() {
      closed = true;
      inner?.close();
    },
  };

  loadPeer()
    .then((mod) => mod.createPeerClient({ hostId, seed, side }))
    .then((ready) => {
      if (closed) {
        ready.close();
        return;
      }
      inner = ready;
      ready.onmessage = emit;
      for (const msg of outbox.splice(0)) ready.send(msg);
    })
    .catch((err: unknown) => {
      if (closed) return;
      const reason = err instanceof Error ? err.message : String(err);
      emit({ t: 'reject', reason: `联机失败：${reason}` });
    });

  return client;
}
