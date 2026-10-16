// 传输层契约测试。
// 这一层最容易被两个细节坑到：
//   1) 初始状态必须"异步"下发（原生版曾经同步 emit，结果第一条 state 在调用方挂
//      onmessage 之前就发完了，棋盘整块渲染不出来）
//   2) restart 要真的换种子 / close 要真的退订（原生版审计里这两条变异都存活）

import { expect, test } from 'vitest';

import { chooseAction } from '../core/ai';
import { mulberry32 } from '../core/rng';
import type { ClientMsg, ServerMsg, ViewState } from '../core/types';
import { createLocalTransport, type Client } from './local';

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

function collect(client: Client) {
  const msgs: ServerMsg[] = [];
  client.onmessage = (msg) => msgs.push(msg);
  return msgs;
}

const states = (msgs: ServerMsg[]): ViewState[] =>
  msgs.filter((m): m is { t: 'state'; state: ViewState } => m.t === 'state').map((m) => m.state);

test('connect() 之后必须"异步"收到初始状态，不能同步回调', async () => {
  const transport = createLocalTransport(4242);
  const client = transport.connect('red');
  const msgs = collect(client);

  expect(msgs.length, 'connect 期间不该同步回调（那时 onmessage 还没挂上）').toBe(0);

  await tick();
  expect(msgs.length).toBe(1);
  expect(msgs[0]!.t).toBe('state');
  const view = states(msgs)[0]!;
  expect(view.cells.length).toBe(36);
  expect(view.you).toBe('red');
  expect(view.cells.every((c) => !c.revealed && c.side === null)).toBe(true);
});

test('不是自己的回合时操作会被拒（两个视角的隔离）', async () => {
  const transport = createLocalTransport(99);
  const red = transport.connect('red');
  const blue = transport.connect('blue');
  const redMsgs = collect(red);
  const blueMsgs = collect(blue);
  await tick();

  expect(states(redMsgs)[0]!.legal.flips.length).toBe(36);
  expect(states(blueMsgs)[0]!.legal.flips.length).toBe(0);

  blue.send({ t: 'flip', at: [0, 0] });
  await tick();
  expect(blueMsgs.at(-1)).toEqual({ t: 'reject', reason: '还没轮到你' });

  red.send({ t: 'flip', at: [0, 0] });
  await tick();
  expect(states(redMsgs).at(-1)!.turn).toBe('blue');
  expect(states(blueMsgs).at(-1)!.legal.flips.length).toBe(35);
  expect(states(redMsgs).at(-1)!.legal.flips.length).toBe(0);
});

test('热座（side = null）可以替任意一方操作，收到的是当前回合方的视角', async () => {
  const transport = createLocalTransport(7);
  const client = transport.connect(null);
  const msgs = collect(client);
  await tick();

  expect(states(msgs)[0]!.you).toBe('red');
  client.send({ t: 'flip', at: [1, 1] });
  await tick();
  expect(states(msgs).at(-1)!.you).toBe('blue');
  expect(states(msgs).at(-1)!.legal.flips.length).toBeGreaterThan(0);

  client.send({ t: 'flip', at: [2, 2] });
  await tick();
  expect(states(msgs).at(-1)!.turn).toBe('red');
});

test('非法操作被拒，且状态不变', async () => {
  const transport = createLocalTransport(31);
  const client = transport.connect('red');
  const msgs = collect(client);
  await tick();
  const before = JSON.stringify(states(msgs).at(-1));

  const bads: unknown[] = [
    { t: 'move', from: [0, 0], to: [0, 1] }, // 还没翻开，走不了
    { t: 'flip', at: [9, 9] }, // 越界
    { t: 'resign' }, // 步数不够
    { t: 'nonsense' },
  ];
  for (const bad of bads) {
    client.send(bad as ClientMsg);
    await tick();
    expect(msgs.at(-1)!.t, JSON.stringify(bad)).toBe('reject');
  }
  expect(JSON.stringify(states(msgs).at(-1))).toBe(before);
});

test('中途认输：20 步之后才能认', async () => {
  const transport = createLocalTransport(8);
  const client = transport.connect(null);
  const msgs = collect(client);
  await tick();

  for (let i = 0; i < 20; i++) {
    const view = states(msgs).at(-1)!;
    expect(view.legal.flips[0], `第 ${i} 步应当还能翻棋`).toBeDefined();
    client.send({ t: 'flip', at: view.legal.flips[0]! });
    await tick();
  }

  const view = states(msgs).at(-1)!;
  expect(view.step).toBe(20);
  expect(view.canResign).toBe(true);
  expect(view.turn).toBe('red');

  client.send({ t: 'resign' });
  await tick();
  const last = states(msgs).at(-1)!;
  expect(last.over).toBe(true);
  expect(last.winner).toBe('blue');
  expect(last.reason).toBe('resign');
  expect(last.cells.filter((c) => c.id).every((c) => c.revealed && c.side)).toBe(true);
});

test('restart：真的换了另一盘（新 seed 生效；不带 seed 时沿用旧 seed）', async () => {
  const transport = createLocalTransport(100);
  const client = transport.connect('red');
  const msgs = collect(client);
  await tick();
  client.send({ t: 'flip', at: [0, 0] });
  await tick();

  const boardOf = () => JSON.stringify(transport.authority.truth().grid);
  const before = boardOf();

  client.send({ t: 'restart', seed: 555 });
  await tick();
  const fresh = states(msgs).at(-1)!;
  expect(fresh.step).toBe(0);
  expect(fresh.turn).toBe('red');
  expect(fresh.cells.every((c) => !c.revealed), '新局应当全部重新扣上').toBe(true);

  // 关键：不只是"重置了"，而是"换成了另一个种子对应的棋盘"
  expect(transport.authority.truth().seed).toBe(555);
  expect(boardOf()).not.toBe(before);

  // 不带 seed：沿用当前的，棋盘还是 555 那一盘
  const seed555 = boardOf();
  client.send({ t: 'restart' });
  await tick();
  expect(transport.authority.truth().seed).toBe(555);
  expect(boardOf()).toBe(seed555);
});

test('client.close() 之后不再收到任何广播（退订真的生效）', async () => {
  const transport = createLocalTransport(7);
  const a = transport.connect('red');
  const b = transport.connect('blue');
  const aMsgs = collect(a);
  const bMsgs = collect(b);
  await tick();
  expect(aMsgs.length).toBe(1);

  a.close();
  b.send({ t: 'restart', seed: 42 });
  await tick();

  expect(aMsgs.length, '退订之后不该再收到 state').toBe(1);
  expect(bMsgs.length).toBeGreaterThan(1);
});

test('Authority.truth()：只有单机模式拿得到完整真相，且和投影确实不同', () => {
  const transport = createLocalTransport(9);
  const truth = transport.authority.truth();
  expect(truth.grid.flat().filter((p) => p)).toHaveLength(36);
  expect(truth.grid[0]![0]!.side === 'red' || truth.grid[0]![0]!.side === 'blue').toBe(true);

  const view = transport.authority.view('red');
  expect(view.cells.filter((c) => !c.revealed)).toHaveLength(36);
  expect(view.cells.every((c) => c.side === null && c.level === null)).toBe(true);
});

test('端到端：两个 client 各用 AI 走完整局，回合隔离与胜负判定都对得上', async () => {
  const transport = createLocalTransport(2024);
  const red = transport.connect('red');
  const blue = transport.connect('blue');
  const redMsgs = collect(red);
  const blueMsgs = collect(blue);
  await tick();

  const rejects = () => [...redMsgs, ...blueMsgs].filter((m) => m.t === 'reject');
  let guard = 0;

  while (!states(redMsgs).at(-1)!.over && guard++ < 3000) {
    const viewRed = states(redMsgs).at(-1)!;
    const isRedTurn = viewRed.turn === 'red';
    const actor = isRedTurn ? red : blue;
    const view = isRedTurn ? viewRed : states(blueMsgs).at(-1)!;

    expect(view.you, '当前该谁走，收到的就应该是谁的视角').toBe(view.turn);
    expect(view.legal.moves.length + view.legal.flips.length).toBeGreaterThan(0);

    const rand = mulberry32((2024 ^ Math.imul(viewRed.step + 1, 2654435761)) >>> 0);
    const action = chooseAction(view, rand);
    expect(action).not.toBeNull();
    actor.send(action!);
    await tick();
  }

  expect(rejects()).toEqual([]);
  const finalRed = states(redMsgs).at(-1)!;
  const finalBlue = states(blueMsgs).at(-1)!;
  expect(finalRed.over).toBe(true);
  expect(finalRed.winner).toBe(finalBlue.winner);
  expect(finalRed.reason).toBe(finalBlue.reason);
  expect(guard).toBeLessThan(3000);
});
