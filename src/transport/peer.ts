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
//
// 跨网络不只靠 TURN，还要扛住"连上以后断掉"：
//   · 心跳（ping/pong）：DataChannel 是可靠有序的，但**半个连接**（手机从 WiFi 切到 4G、
//     对面进程被系统冻结）不会立刻触发 close，双方会各自僵在那儿；房主还占着视角，
//     对面重连会被"这一方已经有人了"挡回去 —— 死锁。所以两边都定期 ping，久无音讯就主动断开。
//   · 客人重连：在 `online.ts` 里做（断线后按退避重连、重新 join、房主回全量快照）。
//   · 信令掉线：房主的 peer 收 `disconnected` 就 `reconnect()`，否则新客人永远连不进来。

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
 * 心跳：这么久发一次 ping。两个作用 —— 让 NAT 绑定不过期、让"对面还活着吗"有答案。
 */
const HEARTBEAT_MS = 10_000;

/**
 * 判定"对面已经没了"的静默上限。
 *
 * 不能更短：后台标签页的定时器会被浏览器降到 **1 次/分钟**，ping 落后是正常的，
 * 阈值必须留出这个余量，否则自己人杀自己人。
 */
const SILENCE_MS = 75_000;

/** 本地页面在后台时不判死（我们自己的 ping 也是被节流的） */
function pageHidden(): boolean {
  return typeof document !== 'undefined' && document.visibilityState === 'hidden';
}

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
  /** 信令掉线（和 DataChannel 无关：棋局照下，但新客人要靠它才找得到房间） */
  on(event: 'disconnected', handler: () => void): void;
  connect(id: string, options?: { reliable?: boolean }): PeerConnectionLike;
  /** peerjs 自带：信令断开后重连 */
  reconnect?(): void;
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

/** 传输层自己的心跳帧：**不进** core/types 的协议，Authority 永远看不到它 */
type Beat = { t: 'ping' } | { t: 'pong' };

function safeSend(conn: PeerConnectionLike, msg: ClientMsg | ServerMsg | Beat): void {
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
  /** 心跳间隔 / 静默判死上限（默认 10s / 75s）。测试里调小，生产别动 */
  heartbeatMs?: number;
  silenceMs?: number;
  /** 握手成功、开始给这位客人推送投影时回调（界面用它从"等待房间"切到棋盘） */
  onGuest?: (side: Side) => void;
}

/** 一个已接入客人占着的座位 */
interface Seat {
  readonly conn: PeerConnectionLike;
  /** 最后一次收到它的消息（含心跳）的时刻 */
  lastSeen(): number;
  /** 踢掉它（不需要确认：close 回调会自己释放） */
  kick(): void;
}

export interface PeerHostHandle {
  /** 真正的 peer id（可能因为撞号退化成随机值），邀请链接要用它 */
  hostId: string;
  destroy(): void;
}

/** 只认传输层心跳帧（形状不对的一律当业务消息往下走，交给 Authority 拒） */
function beatOf(data: unknown): Beat | null {
  if (!isRecord(data)) return null;
  return data.t === 'ping' || data.t === 'pong' ? { t: data.t } : null;
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
  const beatMs = opts.heartbeatMs ?? HEARTBEAT_MS;
  const silenceMs = opts.silenceMs ?? SILENCE_MS;
  const peer = await openHostPeer(factory, opts.hostId ?? hostIdForSeed(seed));
  const hostId = peer.id ?? opts.hostId ?? hostIdForSeed(seed);

  /**
   * 哪个视角被**哪条连接**占着。
   *
   * 两件事都靠它：
   *   1. 记 owner：连接断开时的释放是异步的，旧连接晚到的 close/error 会把新连接刚占上的
   *      视角删掉 —— 那之后就再没人"占着"这一方，随便谁都能顶进来。
   *   2. 认"占座的其实早就死了"：对面手机换网/被冻结时 close 可能永远不来，
   *      没有这一条，对面重连永远被"这一方已经有人了"挡回去（死锁：只能等心跳判死）。
   */
  const taken = new Map<Side, Seat>();
  const conns = new Set<PeerConnectionLike>();
  let destroyed = false;

  // 信令掉线（棋局还在下，但新客人要靠信令才找得到这个房间）
  peer.on('disconnected', () => {
    if (!destroyed) peer.reconnect?.();
  });

  peer.on('connection', (conn) => {
    if (destroyed) {
      conn.close();
      return;
    }
    conns.add(conn);
    let side: Side | null = null;
    let unsubscribe: (() => void) | null = null;
    let lastSeen = Date.now();
    let beatTimer: ReturnType<typeof setInterval> | undefined;
    const seat: Seat = { conn, lastSeen: () => lastSeen, kick: () => conn.close() };

    const release = () => {
      // 只释放**自己**占的那一方：新连接可能已经接手了同一个 side
      if (side && taken.get(side)?.conn === conn) taken.delete(side);
      unsubscribe?.();
      unsubscribe = null;
      conns.delete(conn);
      if (beatTimer !== undefined) clearInterval(beatTimer);
      beatTimer = undefined;
    };

    const timer = setTimeout(() => reject(conn, '握手超时'), handshakeMs);
    conn.on('close', release);
    conn.on('error', release);

    /**
     * 心跳：对面彻底没声了就自己断开，把视角空出来。
     *
     * 半开的连接（对面进程被冻结、WiFi 切 4G 但 ICE 还没失败）不会触发 close，
     * 不主动判死的话房主会一直占着视角 —— 对面再怎么重连都被"这一方已经有人了"挡住。
     */
    const startBeat = () => {
      beatTimer = setInterval(() => {
        if (destroyed) return;
        // 自己在后台时不判死：我们的 interval 也会被降到 1/min，测出来的是节流不是死亡
        if (!pageHidden() && Date.now() - lastSeen > silenceMs) {
          conn.close();
          return;
        }
        safeSend(conn, { t: 'ping' });
      }, beatMs);
    };

    conn.on('data', (data) => {
      lastSeen = Date.now();
      const frame = beatOf(data);
      if (frame) {
        if (frame.t === 'ping') safeSend(conn, { t: 'pong' });
        return;
      }

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
        // 房主自己那一方不走网络，撞上就一定是错的
        if (join.side === mySide) {
          clearTimeout(timer);
          release();
          reject(conn, `${join.side === 'red' ? '红' : '蓝'}方已经有人了`);
          return;
        }
        // 座位上那位已经很久没声了（对面掉线但连接没断）：踢掉让重连进来，
        // 否则"手机切网络 → 对面无限重连 → 永远被拒"就是个死锁
        const stale = taken.get(join.side);
        if (stale) {
          if (Date.now() - stale.lastSeen() <= silenceMs) {
            clearTimeout(timer);
            release();
            reject(conn, `${join.side === 'red' ? '红' : '蓝'}方已经有人了`);
            return;
          }
          stale.kick();
        }
        clearTimeout(timer);
        side = join.side;
        taken.set(side, seat);
        // 同步下发第一条投影；此时连接已经 open，直接就能发
        unsubscribe = authority.subscribe(side, (msg) => safeSend(conn, msg));
        startBeat();
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
  /** 心跳间隔 / 静默判死上限（默认 10s / 75s）。测试里调小，生产别动 */
  heartbeatMs?: number;
  silenceMs?: number;
  /**
   * 连上之后又断掉时回调（**代替**那条「和房主的连接断开了」的 reject）。
   *
   * 装配层（`online.ts`）拿它做自动重连 —— 断线本身不等于这局结束，
   * 直接甩一句 toast 就再也不动才是真正的"不稳定"。
   */
  onlost?: () => void;
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

/**
 * 这次的 ICE 里到底有没有中继 —— 只用来把**失败文案**说清楚。
 *
 * 拿不到配置本身不算错（`resolveIceServers` 已经把一切降级过了），只是文案没法更具体。
 */
async function iceHint(): Promise<string> {
  try {
    const ice = await resolveIceServers({ env: iceEnvFromImportMeta(import.meta.env) });
    return ice.relay
      ? '（中继已经配上了也没打通：凭据过期、或者中继端口被网络封了）'
      : '（本站没配 TURN 中继，只能同网段 / 开放 NAT 连）';
  } catch {
    return '';
  }
}

export async function createPeerClient(opts: CreatePeerClientOptions): Promise<Client> {
  const factory = opts.createPeer ?? (await defaultPeerFactory());
  const timeoutMs = opts.timeoutMs ?? HANDSHAKE_TIMEOUT_MS;
  const beatMs = opts.heartbeatMs ?? HEARTBEAT_MS;
  const silenceMs = opts.silenceMs ?? SILENCE_MS;
  const peer = factory(`bc-${randomSuffix()}`);
  let closed = false;
  let beatTimer: ReturnType<typeof setInterval> | undefined;

  const stopBeat = () => {
    if (beatTimer === undefined) return;
    clearInterval(beatTimer);
    beatTimer = undefined;
  };

  try {
    await waitOpen(peer, timeoutMs);

    const conn = peer.connect(opts.hostId, { reliable: true });
    // ICE 走到哪一步了：超时时靠它区分"对方没开房"和"网络打不通"
    let iceState = '';
    const iceable = conn as unknown as { on?: (event: string, handler: (state: string) => void) => void };
    iceable.on?.('iceStateChanged', (state) => {
      iceState = state;
    });

    /** 连上之后的各种死法都要走这里，保证只会触发一次 */
    const lost = (reason: string) => {
      if (closed) return; // 自己 close() 的不算丢
      closed = true;
      stopBeat();
      try {
        conn.close();
      } catch {}
      peer.destroy();
      if (opts.onlost) opts.onlost();
      else client.deliver({ t: 'reject', reason });
    };

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
                ? '网络打洞失败：需要 TURN 中继'
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
        stopBeat();
        conn.close();
        peer.destroy();
      },
    );

    let lastSeen = Date.now();
    conn.on('data', (data) => {
      lastSeen = Date.now();
      const frame = beatOf(data);
      if (frame) {
        if (frame.t === 'ping') safeSend(conn, { t: 'pong' });
        return;
      }
      if (isServerMsg(data)) client.deliver(data);
    });

    // 心跳（和房主那一侧对称）：对面冻结/换网之后，close 可能永远不来
    beatTimer = setInterval(() => {
      if (closed) return;
      if (!pageHidden() && Date.now() - lastSeen > silenceMs) {
        lost('和房主的连接断开了（长时间没有响应）');
        return;
      }
      safeSend(conn, { t: 'ping' });
    }, beatMs);

    conn.on('close', () => lost('和房主的连接断开了'));
    conn.on('error', () => lost('和房主的连接出错了'));

    conn.send({ t: 'join', seed: opts.seed, side: opts.side } satisfies ClientMsg);
    return client;
  } catch (err) {
    stopBeat();
    peer.destroy();
    // 超时类文案补一句"中继到底有没有配"，省得对着"网络打洞失败"猜
    if (err instanceof Error && /TURN 中继/.test(err.message)) {
      const hint = await iceHint();
      if (hint) throw new Error(err.message + hint, { cause: err });
    }
    throw err;
  }
}
