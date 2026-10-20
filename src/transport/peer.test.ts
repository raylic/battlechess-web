// 联机传输层测试 —— 用假 Peer 网络跑真实的 Authority。
//
// 钉住四件在真机上很难复现的事：
//   1) 每个客人只拿到自己视角的投影（隐藏信息不跨界）
//   2) join 的三道闸：视角被占、种子不符、非当前回合的操作
//   3) 断开后视角要释放（否则同一个人刷新就再也回不来）
//   4) onmessage 挂上之前到达的消息不能丢（useGame 在 layout effect 里才挂）

import { expect, test } from 'vitest';

import type { ServerMsg, ViewState } from '../core/types';
import { createLocalTransport } from './local';
import {
  attachPeerHost,
  createPeerClient,
  type PeerConnectionLike,
  type PeerLike,
  type PeerFactory,
} from './peer';

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

type Handler = (...args: never[]) => void;

/** 一对相连的 DataConnection 假实现：send 同步投递到对端 */
class FakeConn implements PeerConnectionLike {
  readonly peer: string;
  sent: unknown[] = [];
  closed = false;
  private handlers: Record<string, Handler[]> = {};
  private other: FakeConn | null = null;

  constructor(peerId: string) {
    this.peer = peerId;
  }

  link(other: FakeConn): void {
    this.other = other;
    other.other = this;
  }

  /** 对端那条连接（房主侧 / 客人侧各一个对象，打事件要打对那一个） */
  get partner(): FakeConn | null {
    return this.other;
  }

  on(event: 'open', handler: () => void): void;
  on(event: 'data', handler: (data: unknown) => void): void;
  on(event: 'close', handler: () => void): void;
  on(event: 'error', handler: (err: unknown) => void): void;
  on(event: string, handler: Handler): void {
    (this.handlers[event] ??= []).push(handler);
  }

  emit(event: string, value?: unknown): void {
    for (const handler of [...(this.handlers[event] ?? [])]) (handler as (value: unknown) => void)(value);
  }

  send(data: unknown): void {
    if (this.closed) throw new Error('connection closed');
    this.sent.push(data);
    this.other?.emit('data', data);
  }

  close(): void {
    this.shutdown();
  }

  private shutdown(): void {
    if (this.closed) return;
    this.closed = true;
    this.emit('close');
    this.other?.remoteClosed();
  }

  private remoteClosed(): void {
    if (this.closed) return;
    this.closed = true;
    this.emit('close');
  }
}

class FakePeer implements PeerLike {
  readonly id: string;
  private handlers: Record<string, Handler[]> = {};
  private readonly net: FakeNetwork;

  constructor(net: FakeNetwork, id: string) {
    this.net = net;
    this.id = id;
  }

  on(event: 'open', handler: (id: string) => void): void;
  on(event: 'connection', handler: (conn: PeerConnectionLike) => void): void;
  on(event: 'error', handler: (err: { type?: string } | undefined) => void): void;
  on(event: 'disconnected', handler: () => void): void;
  on(event: string, handler: Handler): void {
    (this.handlers[event] ??= []).push(handler);
  }

  emit(event: string, value?: unknown): void {
    for (const handler of [...(this.handlers[event] ?? [])]) (handler as (value: unknown) => void)(value);
  }

  connect(hostId: string, _options?: { reliable?: boolean }): PeerConnectionLike {
    const host = this.net.peers.get(hostId);
    if (!host) {
      // 照抄真实 peerjs 的行为：**不抛**，异步发一条 peer 级 `peer-unavailable`，
      // 返回一条永远不 open 的连接。这正是"只听 conn 就会干等满超时"的成因。
      const dangling = new FakeConn(hostId);
      setTimeout(() => this.emit('error', { type: 'peer-unavailable' }), 0);
      return dangling;
    }
    const guestSide = new FakeConn(hostId);
    const hostSide = new FakeConn(this.id);
    guestSide.link(hostSide);
    host.emit('connection', hostSide);
    // open 要晚于 connection 回调 —— 房主要先挂上 data 监听
    setTimeout(() => {
      hostSide.emit('open');
      guestSide.emit('open');
    }, 0);
    return guestSide;
  }

  destroy(): void {
    this.net.peers.delete(this.id);
    this.handlers = {};
  }
}

class FakeNetwork {
  readonly peers = new Map<string, FakePeer>();

  /** 注入给 attachPeerHost / createPeerClient 的工厂 */
  readonly create: PeerFactory = (id) => {
    const peer = new FakePeer(this, id);
    this.peers.set(id, peer);
    setTimeout(() => peer.emit('open', id), 0);
    return peer;
  };
}

async function bootHost(seed: number, net: FakeNetwork) {
  const transport = createLocalTransport(seed);
  const host = transport.connect('red');
  const handle = await attachPeerHost(transport.authority, seed, 'red', { createPeer: net.create });
  return { host, handle, authority: transport.authority };
}

function collect(client: { onmessage: (msg: ServerMsg) => void }) {
  const msgs: ServerMsg[] = [];
  client.onmessage = (msg) => msgs.push(msg);
  return msgs;
}

const states = (msgs: ServerMsg[]): ViewState[] =>
  msgs.filter((m): m is { t: 'state'; state: ViewState } => m.t === 'state').map((m) => m.state);

const rejects = (msgs: ServerMsg[]): string[] =>
  msgs.filter((m): m is { t: 'reject'; reason: string } => m.t === 'reject').map((m) => m.reason);

test('客人加入后只拿到自己视角的投影（未翻开的棋子不带身份）', async () => {
  const net = new FakeNetwork();
  const { handle, host } = await bootHost(4242, net);
  const guest = await createPeerClient({ hostId: handle.hostId, seed: 4242, side: 'blue', createPeer: net.create });

  await tick();
  const msgs = collect(guest);
  await tick();

  const view = states(msgs)[0];
  expect(view, '客人应当收到一条 state').toBeTruthy();
  expect(view!.you).toBe('blue');
  // 开局 36 格全暗：客人的投影里任何一格都没有 side/level
  expect(view!.cells.every((c) => !c.revealed && c.side === null && c.level === null)).toBe(true);

  guest.close();
  handle.destroy();
  host.close();
});

test('房主走一步，客人收到新快照；客人在非自己回合操作会被拒', async () => {
  const net = new FakeNetwork();
  const { handle, host } = await bootHost(777, net);
  const guest = await createPeerClient({ hostId: handle.hostId, seed: 777, side: 'blue', createPeer: net.create });
  await tick();
  const msgs = collect(guest);
  await tick();

  // 红方（房主）翻一格
  host.send({ t: 'flip', at: [0, 0] });
  await tick();
  expect(states(msgs).at(-1)!.step).toBe(1);
  expect(states(msgs).at(-1)!.turn).toBe('blue');

  // 现在轮到蓝方，但如果它再翻一次之后（轮到红方）继续操作，应该被拒
  guest.send({ t: 'flip', at: [0, 1] });
  await tick();
  guest.send({ t: 'flip', at: [0, 2] });
  await tick();
  expect(rejects(msgs).some((r) => r.includes('还没轮到你'))).toBe(true);

  guest.close();
  handle.destroy();
  host.close();
});

test('同一方不允许两个人：房主是红方时，红方再来一个会被拒', async () => {
  const net = new FakeNetwork();
  const { handle, host } = await bootHost(1, net);
  const guest = await createPeerClient({ hostId: handle.hostId, seed: 1, side: 'red', createPeer: net.create });
  await tick();
  const msgs = collect(guest);
  await tick();

  expect(rejects(msgs).join()).toMatch(/红方已经有人/);
  expect(states(msgs)).toHaveLength(0);

  guest.close();
  handle.destroy();
  host.close();
});

test('种子不一致直接拒：不能拿别的盘连进来', async () => {
  const net = new FakeNetwork();
  const { handle, host } = await bootHost(2, net);
  const guest = await createPeerClient({ hostId: handle.hostId, seed: 3, side: 'blue', createPeer: net.create });
  await tick();
  const msgs = collect(guest);
  await tick();

  expect(rejects(msgs).join()).toMatch(/不是这一盘/);

  guest.close();
  handle.destroy();
  host.close();
});

test('客人断开后视角要释放，同一个人刷新还能回来', async () => {
  const net = new FakeNetwork();
  const { handle, host } = await bootHost(5, net);

  const first = await createPeerClient({ hostId: handle.hostId, seed: 5, side: 'blue', createPeer: net.create });
  await tick();
  first.close();
  await tick();

  const second = await createPeerClient({ hostId: handle.hostId, seed: 5, side: 'blue', createPeer: net.create });
  await tick();
  const msgs = collect(second);
  await tick();
  expect(states(msgs).length, '第二个蓝方应当正常拿到快照').toBeGreaterThan(0);
  expect(rejects(msgs)).toHaveLength(0);

  second.close();
  handle.destroy();
  host.close();
});

test('onmessage 挂上之前到达的消息不丢', async () => {
  const net = new FakeNetwork();
  const { handle, host } = await bootHost(9, net);
  const guest = await createPeerClient({ hostId: handle.hostId, seed: 9, side: 'blue', createPeer: net.create });

  // 故意先不给 onmessage，让 state 先到
  await tick();
  await tick();

  const msgs: ServerMsg[] = [];
  guest.onmessage = (msg) => msgs.push(msg);
  // 不 await：缓冲区在赋值那一刻就该同步冲出来
  expect(msgs.filter((m) => m.t === 'state')).toHaveLength(1);

  guest.close();
  handle.destroy();
  host.close();
});

// ── 失败路径 ──────────────────────────────────────────────
// 这一组守的是"连不上时多久、说什么"。真机上最难复现的两件事：
//   · 房间号没人时 peerjs 报在 **peer** 上（conn 上什么都不来）→ 只听 conn 会干等满 10s
//   · peerjs 一次失败会连发好几条 error → 必须只认第一条，否则后到的会覆盖真正的文案

/** 可以手动打事件的 Peer：用来精确复现 peerjs 的各种失败形态 */
class ManualConn implements PeerConnectionLike {
  readonly peer = 'manual-host';
  sent: unknown[] = [];
  closed = false;
  private handlers: Record<string, Handler[]> = {};

  on(event: string, handler: Handler): void {
    (this.handlers[event] ??= []).push(handler);
  }

  emit(event: string, value?: unknown): void {
    for (const handler of [...(this.handlers[event] ?? [])]) (handler as (value: unknown) => void)(value);
  }

  send(data: unknown): void {
    this.sent.push(data);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.emit('close');
  }
}

class ManualPeer implements PeerLike {
  readonly id: string;
  destroyed = false;
  readonly conns: ManualConn[] = [];
  private handlers: Record<string, Handler[]> = {};

  constructor(id: string) {
    this.id = id;
  }

  get conn(): ManualConn {
    const conn = this.conns[0];
    if (!conn) throw new Error('还没 connect()');
    return conn;
  }

  on(event: string, handler: Handler): void {
    (this.handlers[event] ??= []).push(handler);
  }

  emit(event: string, value?: unknown): void {
    for (const handler of [...(this.handlers[event] ?? [])]) (handler as (value: unknown) => void)(value);
  }

  connect(): PeerConnectionLike {
    const conn = new ManualConn();
    this.conns.push(conn);
    return conn;
  }

  destroy(): void {
    this.destroyed = true;
  }
}

function manualClient(peer: ManualPeer, timeoutMs = 200) {
  return createPeerClient({
    hostId: 'battlechess-9',
    seed: 9,
    side: 'blue',
    createPeer: () => peer,
    timeoutMs,
  });
}

test('连接成功的路径：第一条消息必须是 join（带 seed 与 side）', async () => {
  const peer = new ManualPeer('bc-me');
  const pending = manualClient(peer);
  peer.emit('open', peer.id);
  await tick();
  peer.conn.emit('open');

  const client = await pending;
  expect(peer.conn.sent[0]).toEqual({ t: 'join', seed: 9, side: 'blue' });
  client.close();
  expect(peer.destroyed, 'close() 要把 peer 一起销毁').toBe(true);
});

test('房间号没人（peer-unavailable）：1 秒内失败，不干等满超时', async () => {
  const peer = new ManualPeer('bc-me');
  // timeoutMs 给 5s：如果实现退化成"等超时"，这条断言会失败
  const pending = manualClient(peer, 5000);
  peer.emit('open', peer.id);
  await tick();

  const started = Date.now();
  peer.emit('error', { type: 'peer-unavailable', message: 'Could not connect to peer battlechess-9' });

  await expect(pending).rejects.toThrow('房间不存在，或房主已经关闭了这个房间');
  expect(Date.now() - started, 'peer-unavailable 必须立刻失败').toBeLessThan(1000);
  expect(peer.destroyed).toBe(true);
});

test('信令层致命错误（network）：立刻失败，文案指向信令', async () => {
  const peer = new ManualPeer('bc-me');
  const pending = manualClient(peer, 5000);
  peer.emit('open', peer.id);
  await tick();

  peer.emit('error', { type: 'network' });
  await expect(pending).rejects.toThrow('信令连接断了');
});

test('只认第一条错误：先 peer-unavailable 再来一条 network，文案不变', async () => {
  const peer = new ManualPeer('bc-me');
  const pending = manualClient(peer, 5000);
  peer.emit('open', peer.id);
  await tick();

  peer.emit('error', { type: 'peer-unavailable' });
  peer.emit('error', { type: 'network' });
  await expect(pending).rejects.toThrow('房间不存在');
});

test('信令服务器一直不 open：超时报「信令服务器连不上」', async () => {
  const peer = new ManualPeer('bc-me');
  await expect(manualClient(peer, 30)).rejects.toThrow('信令服务器连不上');
  expect(peer.destroyed).toBe(true);
});

test('信令服务器报错（非 unavailable-id）：立刻失败', async () => {
  const peer = new ManualPeer('bc-me');
  const pending = manualClient(peer, 5000);
  peer.emit('error', { type: 'browser-incompatible' });
  await expect(pending).rejects.toThrow('信令服务器拒绝了连接');
});

test('连上了但连接一直不 open、也不报错：走超时文案', async () => {
  const peer = new ManualPeer('bc-me');
  const pending = manualClient(peer, 30);
  peer.emit('open', peer.id);
  // 没收到任何 ICE 状态 → 最可能是"对方没开房/链接过期"，而不是打洞失败
  await expect(pending).rejects.toThrow('对方没有开房，或邀请链接已失效（连接超时）');
  expect(peer.destroyed).toBe(true);
});

test('ICE 卡在 checking：超时文案指向 TURN 中继（跨网络连不上就是这么来的）', async () => {
  const peer = new ManualPeer('bc-me');
  const pending = manualClient(peer, 40);
  peer.emit('open', peer.id);
  await tick(); // 等 createPeerClient 真的走到 connect()
  peer.conn.emit('iceStateChanged', 'checking');
  await expect(pending).rejects.toThrow('双方网络都受限，需要 TURN 中继');
  expect(peer.destroyed).toBe(true);
});

test('ICE 直接 failed：文案直说打洞失败 + 中继没配好', async () => {
  const peer = new ManualPeer('bc-me');
  const pending = manualClient(peer, 40);
  peer.emit('open', peer.id);
  await tick();
  peer.conn.emit('iceStateChanged', 'failed');
  await expect(pending).rejects.toThrow('网络打洞失败：需要 TURN 中继');
  expect(peer.destroyed).toBe(true);
});

test('连接报错（未 open）：文案是「和房主建立连接失败」', async () => {
  const peer = new ManualPeer('bc-me');
  const pending = manualClient(peer, 5000);
  peer.emit('open', peer.id);
  await tick();
  peer.conn.emit('error', { type: 'webrtc' });
  await expect(pending).rejects.toThrow('和房主建立连接失败');
});

test('房主 destroy 时，客人收到「断开了」', async () => {
  const net = new FakeNetwork();
  const { handle, host } = await bootHost(13, net);
  const guest = await createPeerClient({ hostId: handle.hostId, seed: 13, side: 'blue', createPeer: net.create });
  await tick();
  const msgs = collect(guest);
  await tick();

  handle.destroy();
  await tick();
  expect(rejects(msgs).join()).toMatch(/断开了/);
  host.close();
});

test('客人自己 close 不会误报「断开了」', async () => {
  const net = new FakeNetwork();
  const { handle, host } = await bootHost(14, net);
  const guest = await createPeerClient({ hostId: handle.hostId, seed: 14, side: 'blue', createPeer: net.create });
  await tick();
  const msgs = collect(guest);
  await tick();

  guest.close();
  await tick();
  expect(rejects(msgs)).toHaveLength(0);
  handle.destroy();
  host.close();
});

test('第一条不是 join：拒「非法消息」并断开', async () => {
  const net = new FakeNetwork();
  const { handle, host } = await bootHost(11, net);

  const rawPeer = net.create('bc-raw');
  await tick();
  await tick();
  const conn = rawPeer.connect(handle.hostId);
  const got: ServerMsg[] = [];
  conn.on('data', (data) => got.push(data as ServerMsg));
  await tick();

  conn.send({ t: 'flip', at: [0, 0] });
  await tick();
  expect(rejects(got).join()).toMatch(/非法消息/);
  expect((conn as FakeConn).closed).toBe(true);

  handle.destroy();
  host.close();
});

test('连上但一直不发 join：握手超时后断开', async () => {
  const net = new FakeNetwork();
  const transport = createLocalTransport(12);
  const host = transport.connect('red');
  const handle = await attachPeerHost(transport.authority, 12, 'red', {
    createPeer: net.create,
    timeoutMs: 20,
  });

  const rawPeer = net.create('bc-raw2');
  await tick();
  await tick();
  const conn = rawPeer.connect(handle.hostId);
  const got: ServerMsg[] = [];
  conn.on('data', (data) => got.push(data as ServerMsg));

  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(rejects(got).join()).toMatch(/握手超时/);
  expect((conn as FakeConn).closed).toBe(true);

  handle.destroy();
  host.close();
});

// ── 跨网络的稳定层：心跳 / 死座位回收 / 掉线钩子 ─────────────
// 这一组守的是"连上之后"的死法 —— 真机上最难复现、也最让人以为"联机就是不稳"的那些。

test('心跳：对面久无音讯就断开它，把视角空出来（不用等 close，那个可能永远不来）', async () => {
  const net = new FakeNetwork();
  const transport = createLocalTransport(21);
  const host = transport.connect('red');
  const handle = await attachPeerHost(transport.authority, 21, 'red', {
    createPeer: net.create,
    heartbeatMs: 5,
    silenceMs: 20,
  });

  // 一条"僵尸"连接：join 之后就再也不说话（不回 ping）—— 真实场景是对面手机被系统冻结、
  // 或者 WiFi 切 4G 之后半开，close 永远不来
  const zombiePeer = net.create('bc-zombie');
  await tick();
  await tick();
  const zombie = zombiePeer.connect(handle.hostId) as FakeConn;
  await tick();
  zombie.send({ t: 'join', seed: 21, side: 'blue' });
  await tick();
  await new Promise((resolve) => setTimeout(resolve, 70));

  // 真正的客人（有心跳）应该能接进同一个视角，而不是被"蓝方已经有人了"挡住
  const guest = await createPeerClient({
    hostId: handle.hostId,
    seed: 21,
    side: 'blue',
    createPeer: net.create,
    heartbeatMs: 5,
  });
  await tick();
  const msgs = collect(guest);
  await tick();
  expect(states(msgs).length, '重连的人应当拿到全量快照').toBeGreaterThan(0);
  expect(rejects(msgs), '死座位必须被回收，否则这里会是「蓝方已经有人了」').toHaveLength(0);

  guest.close();
  handle.destroy();
  host.close();
});

test('心跳：ping 由客人自动回 pong，且不会被当成业务消息拒掉', async () => {
  const peer = new ManualPeer('bc-me');
  const pending = manualClient(peer);
  peer.emit('open', peer.id);
  await tick();
  peer.conn.emit('open');
  const client = await pending;

  const msgs = collect(client);
  peer.conn.emit('data', { t: 'ping' });
  await tick();
  expect(peer.conn.sent.at(-1), '要回 pong').toEqual({ t: 'pong' });
  expect(rejects(msgs)).toHaveLength(0);

  client.close();
});

test('客人连上后掉线：走 onlost，不再甩一条「断开了」的 reject', async () => {
  const net = new FakeNetwork();
  const { handle, host } = await bootHost(22, net);

  let lost = 0;
  const guest = await createPeerClient({
    hostId: handle.hostId,
    seed: 22,
    side: 'blue',
    createPeer: net.create,
    onlost: () => {
      lost += 1;
    },
  });
  await tick();
  const msgs = collect(guest);
  await tick();

  handle.destroy();
  await tick();
  expect(lost).toBe(1);
  expect(rejects(msgs)).toHaveLength(0);

  guest.close();
  host.close();
});

test('旧连接晚到的 close/error 不能删掉新连接刚占上的视角', async () => {
  const net = new FakeNetwork();
  const transport = createLocalTransport(23);
  const host = transport.connect('red');
  const handle = await attachPeerHost(transport.authority, 23, 'red', { createPeer: net.create });

  const rawA = net.create('bc-a');
  await tick();
  await tick();
  const connA = rawA.connect(handle.hostId) as FakeConn;
  const hostSideA = connA.partner!;
  await tick();
  connA.send({ t: 'join', seed: 23, side: 'blue' });
  await tick();

  // 房主这一侧看到连接断了 → 释放蓝方
  hostSideA.emit('close');
  await tick();

  // 重连进来的第二个蓝方占上了座位
  const rawB = net.create('bc-b');
  await tick();
  await tick();
  const connB = rawB.connect(handle.hostId) as FakeConn;
  const gotB: ServerMsg[] = [];
  connB.on('data', (data) => gotB.push(data as ServerMsg));
  await tick();
  connB.send({ t: 'join', seed: 23, side: 'blue' });
  await tick();
  expect(states(gotB).length, '第二个蓝方应当接进来').toBeGreaterThan(0);

  // 旧连接的迟到事件（peerjs 会先 close 再 error）—— 不能把 B 的座位删掉
  hostSideA.emit('error');
  await tick();

  // 第三个蓝方应当仍然被拒：座位属于 B
  const rawC = net.create('bc-c');
  await tick();
  await tick();
  const connC = rawC.connect(handle.hostId) as FakeConn;
  const gotC: ServerMsg[] = [];
  connC.on('data', (data) => gotC.push(data as ServerMsg));
  await tick();
  connC.send({ t: 'join', seed: 23, side: 'blue' });
  await tick();
  expect(rejects(gotC).join()).toMatch(/蓝方已经有人了/);

  handle.destroy();
  host.close();
});
