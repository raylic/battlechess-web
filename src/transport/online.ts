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
import { clearIceCache, iceEnvFromImportMeta, resolveIceServers } from './ice';
import { createLocalTransport, type Client } from './local';

/**
 * 这次能不能跨网络：有没有拿到 TURN 中继。
 *
 * 界面只拿它显示一行"中继已就绪 / 只能同网段"—— 连不上时，这一行比任何报错都先定位问题。
 */
export interface RelayStatus {
  relay: boolean;
  source: 'endpoint' | 'static' | 'stun-only';
}

/**
 * 探中继（走 ice.ts 的缓存，不会重复打端点）。
 *
 * 没探到会**退避重试几次**：失败会被负缓存 20 秒，而首屏那一下（页面刚起来就建房间）
 * 最容易赶上一次瞬时失败（移动网络、DNS 还没热）。直接把"暂时没通"写成"没有中继"
 * 比不显示更误导 —— 那一行是玩家判断"能不能跨网络"的唯一依据。
 */
export async function probeRelay(): Promise<RelayStatus> {
  const env = iceEnvFromImportMeta(import.meta.env);
  const attempts = RELAY_RETRY_DELAYS_MS.length + 1;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const ice = await resolveIceServers({ env });
      if (ice.relay) return { relay: true, source: ice.source };
    } catch {
      // 下面统一按"没探到"处理
    }
    const delay = RELAY_RETRY_DELAYS_MS[attempt];
    if (delay === undefined) break;
    await new Promise((resolve) => setTimeout(resolve, delay));
    clearIceCache(); // 不然下一次读到的还是那份失败缓存
  }
  return { relay: false, source: 'stun-only' };
}

/** 中继探测失败后的退避（首屏那一下最容易赶上瞬时失败） */
const RELAY_RETRY_DELAYS_MS = [1200, 3000, 6000];

type PeerModule = typeof import('./peer');

let loading: Promise<PeerModule> | null = null;

/** 唯一切入点：动态加载 peerjs 实现。重复调用只加载一次 */
export function loadPeer(): Promise<PeerModule> {
  loading ??= import('./peer');
  return loading;
}

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
  /** 中继状态（只用于界面提示，不阻塞建房） */
  relay: Promise<RelayStatus>;
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
    relay: probeRelay(),
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
 *
 * **连上之后掉线会自动重连**（这是"非局域网不稳定"的另一半）：重连成功时房主会重新下发
 * 全量投影，棋局原样继续 —— 断线不该等于这局结束。
 */
export function createOnlineClient(hostId: string, seed: number, side: Side): Client {
  const outbox: ClientMsg[] = [];
  const inbox: ServerMsg[] = [];
  let inner: Client | null = null;
  let handler: ((msg: ServerMsg) => void) | null = null;
  let closed = false;
  let everConnected = false;
  let attempt = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const emit = (msg: ServerMsg) => {
    if (handler) handler(msg);
    else inbox.push(msg);
  };

  const stopTimer = () => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
  };

  const giveUp = (reason: string, prefix: string) => {
    if (closed) return;
    closed = true;
    stopTimer();
    emit({ t: 'reject', reason: `${prefix}${reason}` });
  };

  /** 重连进行到第几次：连续失败的间隔（第一次是立刻重试） */
  const retryDelayMs = (n: number) => Math.min(1000 * 2 ** n, 15_000);
  const MAX_RETRIES = 8;

  // 这些原因重试也没用：房间没了、盘不对、视角被别人占着 —— 直接把话说清楚
  const FATAL = /房间不存在|已经关闭|不是这一盘|已经有人|非法消息|握手超时|房间已关闭/;

  function scheduleRetry(lastReason: string): void {
    if (closed) return;
    if (attempt >= MAX_RETRIES) {
      giveUp(`${lastReason}（已重试 ${MAX_RETRIES} 次）`, '重连失败：');
      return;
    }
    attempt += 1;
    // 每次都弹一条会像抽风：第 1 次说清楚，之后每 3 次提醒一次
    if (attempt === 1 || attempt % 3 === 0) {
      emit({ t: 'reject', reason: `连接断了，正在重连（${attempt}/${MAX_RETRIES}）…` });
    }
    stopTimer();
    timer = setTimeout(connectOnce, retryDelayMs(attempt - 1));
  }

  function connectOnce(): void {
    timer = null;
    loadPeer()
      .then((mod) =>
        mod.createPeerClient({
          hostId,
          seed,
          side,
          // 掉线交给这里处理：底层不要顺手甩一条"断开了"的 reject 出去
          onlost: () => {
            if (closed) return;
            inner = null;
            scheduleRetry('和房主的连接断开了');
          },
        }),
      )
      .then((ready) => {
        if (closed) {
          ready.close();
          return;
        }
        const retried = everConnected;
        inner = ready;
        everConnected = true;
        attempt = 0;
        ready.onmessage = emit;
        for (const msg of outbox.splice(0)) ready.send(msg);
        if (retried) emit({ t: 'reject', reason: '已重新连接' });
      })
      .catch((err: unknown) => {
        if (closed) return;
        const reason = err instanceof Error ? err.message : String(err);
        // 第一次就没连上：不重试，直接把原因摆出来（重试只会让人多等 30 秒）
        if (!everConnected) {
          giveUp(reason, '联机失败：');
          return;
        }
        if (FATAL.test(reason)) {
          giveUp(reason, '重连失败：');
          return;
        }
        scheduleRetry(reason);
      });
  }

  const client: Client = {
    side,
    get onmessage() {
      return handler ?? (() => {});
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
      stopTimer();
      inner?.close();
    },
  };

  connectOnce();
  return client;
}
