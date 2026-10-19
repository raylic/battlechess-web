// 联机传输：PeerJS（WebRTC DataChannel）。
//
// 结构和双窗口模式一模一样，只是把 SharedWorker 换成 WebRTC：
//   房主标签页里跑 `Authority`（唯一权威），自己那一方走本地直连（同 local.ts）；
//   对方通过 DataChannel 发 `ClientMsg` 上来，只收到**自己视角**的 `ServerMsg` 投影
//   （`viewFor(state, side)` 在 Authority 里，传输层一行都不碰隐藏信息）。
//
// ⚠️ 这个文件**静态** import peerjs（88 KB min / 24 KB gzip）。只允许经 `online.ts`
//    动态 `import()` 引入 —— 别从别处直接 import，否则它会被打进主包，单机玩家也要下载。
//
// 网络拓扑（和 Parti 学的）：
//   1. 房主 peer id 由种子派生（`battlechess-<seed>`），所以邀请链接可以口算出来；
//      万一撞上别人占用（`unavailable-id`，常见于上一次没退干净），指数退避重试，
//      仍失败就退回随机 id —— 这时只能靠 console 里的链接，不能靠猜。
//   2. 建连顺序：guest → host `connect()` → 第一条消息必须是 `join`（带 seed 和 side）
//      → 校验通过才 `authority.subscribe(side, ...)`，之后双向直通。
//   3. 信令走 PeerJS 公共云（`0.peerjs.com`）；**中继（TURN）必须自己配** —— 免费公共 TURN
//      实测都拿不到 relay candidate（见 ice.ts 的注释），不配就只能在同网段/开放 NAT 下连。
//      配置走 `VITE_TURN_ENDPOINT`（短时凭据）或 `VITE_TURN_*`（静态凭据），
//      凭据端点的实现见 `workers/turn-credentials.js`。想自建信令时换 `createPeer` 即可。

import Peer from 'peerjs';

import type { Authority } from '../core/authority';
import { isRecord } from '../core/reduce';
import type { ClientMsg, ServerMsg, Side } from '../core/types';
import { iceEnvFromImportMeta, resolveIceServers, type IceServer } from './ice';
import type { Client } from './local';
import { hostIdForSeed } from './roomId';

/** 握手/建连超时：别让"对方没开""号被占"这类情况无限挂着 */
const HANDSHAKE_TIMEOUT_MS = 10_000;

/**
 * 信令层面的致命错误：出现就说明"再等也没用"，直接失败。
 *
 * 注意 `peer-unavailable` 不在这里 —— 它的语义是"这个房间号没人"，文案不同，
 * 单独处理（见 createPeerClient）。
 */
const FATAL_SIGNAL_ERRORS = new Set(['network', 'server-error', 'socket-error', 'socket-closed', 'ssl-unavailable']);

/** peerjs 的错误对象形状：`{ type, message }`（PeerError 继承 Error，带 type） */
function errorType(err: unknown): string {
  if (typeof err !== 'object' || err === null) return '';
  const type = (err as { type?: unknown }).type;
  return typeof type === 'string' ? type : '';
}

// ── 可注入的最小 Peer 形状（生产用 peerjs，测试用假实现，见 peer.test.ts） ──

export interface PeerConnectionLike {
  readonly peer: string;
  on(event: 'open', handler: () => void): void;
  on(event: 'data', handler: (data: unknown) => void): void;
  on(event: 'close', handler: () => void): void;
  on(event: 'error', handler: (err: unknown) => void): void;
  send(data: unknown): void;
  close(): void;
}

export interface PeerLike {
  readonly id?: string;
  on(event: 'open', handler: (id: string) => void): void;
  on(event: 'connection', handler: (conn: PeerConnectionLike) => void): void;
  on(event: 'error', handler: (err: { type?: string } | undefined) => void): void;
  connect(id: string, options?: { reliable?: boolean }): PeerConnectionLike;
  destroy(): void;
}

export type PeerFactory = (id: string) => PeerLike;

/**
 * 生产用的 Peer：带上 ICE 配置（STUN + TURN）。
 *
 * 中继凭据是短时的，所以这一步是**异步**的；拿不到就退回只有 STUN，
 * 此时连接会表现为"同网段能连、跨网络连不上"（和没配 TURN 时一样）。
 */
async function defaultPeerFactory(): Promise<PeerFactory> {
  const ice = await resolveIceServers({ env: iceEnvFromImportMeta(import.meta.env) });
  const iceServers: IceServer[] = ice.servers;
  return (id) => new Peer(id, { config: { iceServers } }) as unknown as PeerLike;
}

function randomSuffix(): string {
  const raw =
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID().replaceAll('-', '')
      : Math.random().toString(36).slice(2);
  return raw.slice(0, 8);
}

function safeSend(conn: PeerConnectionLike, msg: ClientMsg | ServerMsg): void {
  try {
    conn.send(msg);
  } catch {
    // 对端已经走了；close/error 回调会负责清理
  }
}

function reject(conn: PeerConnectionLike, reason: string): void {
  safeSend(conn, { t: 'reject', reason });
  conn.close();
}

function isServerMsg(value: unknown): value is ServerMsg {
  return isRecord(value) && (value.t === 'state' || value.t === 'reject' && typeof value.reason === 'string');
}

interface JoinMsg {
  t: 'join';
  seed: number;
  side: Side;
}

function asJoinMsg(value: unknown): JoinMsg | null {
  if (!isRecord(value) || value.t !== 'join') return null;
  if (typeof value.seed !== 'number') return null;
  if (value.side !== 'red' && value.side !== 'blue') return null;
  return { t: 'join', seed: value.seed, side: value.side };
}

function waitOpen(peer: PeerLike, timeoutMs: number): Promise<void> {
  return new Promise((resolve, rejectPromise) => {
    const timer = setTimeout(() => rejectPromise(new Error('信令服务器连不上（PeerJS 公共云）')), timeoutMs);
    peer.on('open', () => {
      clearTimeout(timer);
      resolve();
    });
    peer.on('error', (err) => {
      clearTimeout(timer);
      if (err instanceof Error) rejectPromise(err);
      else rejectPromise(new Error('信令服务器拒绝了连接'));
    });
  });
}

/**
 * 打开房主 peer：先试稳定 id，撞 `unavailable-id` 就退避重试，仍失败退回随机 id。
 *
 * 重试是"房主刷新后邀请码不变"能成立的关键 —— 刷新瞬间旧 peer 往往还没从
 * PeerJS 那边释放，第一次 `new Peer(id)` 必然撞车。
 */
async function openHostPeer(factory: PeerFactory, wanted: string, retries = 3): Promise<PeerLike> {
  let id = wanted;
  let allowRandomFallback = true;
  for (let attempt = 0; ; attempt += 1) {
    const peer = factory(id);
    try {
      await waitOpen(peer, HANDSHAKE_TIMEOUT_MS);
      return peer;
    } catch (err) {
      peer.destroy();
      const type = errorType(err);
      const unavailable = type === 'unavailable-id' || /unavailable-id/.test(String(err));
      if (unavailable && attempt < retries) {
        await new Promise((resolve) => setTimeout(resolve, 300 * 2 ** attempt));
        continue;
      }
      if (unavailable && allowRandomFallback) {
        // 稳定 id 被别人（含自己上一次没退干净的会话）长期占着：退化成随机 id 保命，
        // 代价是邀请链接得看 console 里打出来的那条。
        allowRandomFallback = false;
        id = `${wanted}-${randomSuffix()}`;
        continue;
      }
      throw err;
    }
  }
}

// ── 房主侧 ────────────────────────────────────────────────

export interface AttachPeerHostOptions {
  /** 覆盖默认的 `battlechess-<seed>`，主要给测试和自建信令用 */
  hostId?: string;
  createPeer?: PeerFactory;
  /** 客人连上之后多久必须发 join（默认 10s）。测试里调小，生产别动 */
  timeoutMs?: number;
  /** 握手成功、开始给这位客人推送投影时回调（界面用它从"等待房间"切到棋盘） */
  onGuest?: (side: Side) => void;
}

export interface PeerHostHandle {
  /** 真正的 peer id（可能因为撞号退化成随机值），邀请链接要用它 */
  hostId: string;
  destroy(): void;
}

/**
 * 在已有的 Authority 上挂一个 WebRTC 监听。
 *
 * 房主自己那一方**不走网络**（和单机模式一样直接连 Authority），所以本地玩家零延迟；
 * 只有对方的消息跨 DataChannel。
 */
export async function attachPeerHost(
  authority: Authority,
  seed: number,
  mySide: Side,
  opts: AttachPeerHostOptions = {},
): Promise<PeerHostHandle> {
  const factory = opts.createPeer ?? (await defaultPeerFactory());
  const handshakeMs = opts.timeoutMs ?? HANDSHAKE_TIMEOUT_MS;
  const peer = await openHostPeer(factory, opts.hostId ?? hostIdForSeed(seed));
  const hostId = peer.id ?? opts.hostId ?? hostIdForSeed(seed);

  /** 已经有人占用的视角：房主自己 + 已接入的客人。同一视角不允许两个连接 */
  const taken = new Set<Side>([mySide]);
  const conns = new Set<PeerConnectionLike>();
  let destroyed = false;

  peer.on('connection', (conn) => {
    if (destroyed) {
      conn.close();
      return;
    }
    conns.add(conn);
    let side: Side | null = null;
    let unsubscribe: (() => void) | null = null;

    const release = () => {
      if (side) taken.delete(side);
      unsubscribe?.();
      unsubscribe = null;
      conns.delete(conn);
    };

    const timer = setTimeout(() => reject(conn, '握手超时'), handshakeMs);
    conn.on('close', release);
    conn.on('error', release);

    conn.on('data', (data) => {
      if (!side) {
        // 第一条消息必须是 join：既确定视角，也确认"是同一盘棋"
        const join = asJoinMsg(data);
        if (!join) {
          clearTimeout(timer);
          release();
          reject(conn, '非法消息');
          return;
        }
        if (join.seed !== seed) {
          clearTimeout(timer);
          release();
          reject(conn, '不是这一盘棋（种子不一致）');
          return;
        }
        if (taken.has(join.side)) {
          clearTimeout(timer);
          release();
          reject(conn, `${join.side === 'red' ? '红' : '蓝'}方已经有人了`);
          return;
        }
        clearTimeout(timer);
        side = join.side;
        taken.add(side);
        // 同步下发第一条投影；此时连接已经 open，直接就能发
        unsubscribe = authority.subscribe(side, (msg) => safeSend(conn, msg));
        opts.onGuest?.(side);
        return;
      }

      // msg 是不可信输入，dispatch 自己会拒，不用在这里预校验
      const res = authority.dispatch(side, data);
      if ('rejected' in res) safeSend(conn, { t: 'reject', reason: res.rejected });
    });
  });

  return {
    hostId,
    destroy() {
      if (destroyed) return;
      destroyed = true;
      for (const conn of conns) conn.close();
      conns.clear();
      taken.clear();
      peer.destroy();
    },
  };
}

// ── 客人侧 ────────────────────────────────────────────────

export interface CreatePeerClientOptions {
  hostId: string;
  seed: number;
  side: Side;
  createPeer?: PeerFactory;
  timeoutMs?: number;
}

interface BufferedClient extends Client {
  /** 收到一条服务端消息；在 onmessage 挂上之前先攒着 */
  deliver(msg: ServerMsg): void;
}

/**
 * 把 `onmessage` 做成带缓冲的属性。
 *
 * `useGame` 是在 layout effect 里才挂 onmessage 的，而第一条 state 可能在这之前就到
 * （`local.ts` 那个 setTimeout(0) 的注释讲的是同一个坑）。挂之前到达的消息不能丢，
 * 否则整块棋盘渲染不出来。
 */
function createBufferedClient(side: Side, send: (msg: ClientMsg) => void, close: () => void): BufferedClient {
  let handler: ((msg: ServerMsg) => void) | null = null;
  const pending: ServerMsg[] = [];
  const noop = () => {};
  return {
    side,
    get onmessage() {
      return handler ?? noop;
    },
    set onmessage(fn: (msg: ServerMsg) => void) {
      handler = fn;
      for (const msg of pending.splice(0)) fn(msg);
    },
    send,
    close,
    deliver(msg) {
      if (handler) handler(msg);
      else pending.push(msg);
    },
  };
}

export async function createPeerClient(opts: CreatePeerClientOptions): Promise<Client> {
  const factory = opts.createPeer ?? (await defaultPeerFactory());
  const timeoutMs = opts.timeoutMs ?? HANDSHAKE_TIMEOUT_MS;
  const peer = factory(`bc-${randomSuffix()}`);
  let closed = false;

  try {
    await waitOpen(peer, timeoutMs);

    const conn = peer.connect(opts.hostId, { reliable: true });
    // ICE 走到哪一步了：超时时靠它区分"对方没开房"和"网络打不通"
    let iceState = '';
    const iceable = conn as unknown as { on?: (event: string, handler: (state: string) => void) => void };
    iceable.on?.('iceStateChanged', (state) => {
      iceState = state;
    });

    await new Promise<void>((resolve, rejectPromise) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const settle = (err?: Error) => {
        if (settled) return; // peerjs 会连发好几个 error，只认第一个
        settled = true;
        if (timer) clearTimeout(timer);
        if (err) rejectPromise(err);
        else resolve();
      };

      // ⚠️ 这里必须**同时**听 peer 的错误：目标房间号不存在时，peerjs 发的是
      //    `peer.on('error', { type: 'peer-unavailable' })`，而 conn 上什么都不会来。
      //    只听 conn 的话，过期链接要干等满 timeoutMs（10 秒）才报"连接超时"。
      peer.on('error', (err) => {
        const type = errorType(err);
        if (type === 'peer-unavailable') {
          settle(new Error('房间不存在，或房主已经关闭了这个房间'));
        } else if (FATAL_SIGNAL_ERRORS.has(type)) {
          settle(new Error('信令连接断了（PeerJS 公共云）'));
        }
      });
      conn.on('open', () => settle());
      conn.on('error', () => settle(new Error('和房主建立连接失败')));

      // 超时文案分三种：ICE 失败（要 TURN）/ ICE 一直协商中 / 对方根本没应答
      timer = setTimeout(
        () =>
          settle(
            new Error(
              iceState === 'failed' || iceState === 'disconnected'
                ? '网络打洞失败：需要 TURN 中继（还没配好，或已过期）'
                : iceState === 'checking' || iceState === 'new'
                  ? '连不上对方：双方网络都受限，需要 TURN 中继'
                  : '对方没有开房，或邀请链接已失效（连接超时）',
            ),
          ),
        timeoutMs,
      );
    });

    const client = createBufferedClient(
      opts.side,
      (msg) => {
        if (!closed) safeSend(conn, msg);
      },
      () => {
        closed = true;
        conn.close();
        peer.destroy();
      },
    );

    conn.on('data', (data) => {
      if (isServerMsg(data)) client.deliver(data);
    });
    conn.on('close', () => {
      if (!closed) client.deliver({ t: 'reject', reason: '和房主的连接断开了' });
    });
    conn.on('error', () => {
      if (!closed) client.deliver({ t: 'reject', reason: '和房主的连接出错了' });
    });

    conn.send({ t: 'join', seed: opts.seed, side: opts.side } satisfies ClientMsg);
    return client;
  } catch (err) {
    peer.destroy();
    throw err;
  }
}
