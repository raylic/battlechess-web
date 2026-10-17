// 会话生命周期：建会话 / 回开始界面 / 再来一局。
// 从 App 里抽出来是为了能单测"拆卸"这条路 —— 原生版审计里
// "close() 退订""board.clear() 残留"这两条变异都存活，正是因为没人测过切换模式。

import { useLayoutEffect, useRef, useState } from 'react';

import type { Authority } from '../core/authority';
import type { Side } from '../core/types';
import type { Client } from '../transport/local';
import { createLocalTransport } from '../transport/local';
import { createWorkerClient, workerSupported } from '../transport/worker';
import { AI_SIDE } from './useAi';
import type { Mode } from './hudText';

export interface Session {
  mode: Mode;
  side: Side | null;
  seed: number;
  client: Client;
  /** 只有人机模式有 */
  aiClient: Client | null;
  /** 只有单机模式拿得到真相（双窗口模式的真相在 SharedWorker 里） */
  authority: Authority | null;
}

export interface SessionOptions {
  /** 双窗口模式要用的第二个窗口 URL（便于测试时注入） */
  openWindow?: (url: string, name: string, features: string) => void;
  /** 双窗口的 client 工厂（jsdom 里没有 SharedWorker，测试可注入假的） */
  createWorker?: (seed: number, side: Side) => Client;
  debug?: boolean;
}

export function createSession(
  mode: Mode,
  side: Side | null,
  seed: number,
  opts: SessionOptions = {},
): Session {
  if (mode === 'dual') {
    // 不支持 SharedWorker 的浏览器：退回单机热座，不要让整页挂掉
    if (!opts.createWorker && !workerSupported()) {
      return createSession('hotseat', null, seed, opts);
    }
    const mySide: Side = side ?? 'red';
    if (!side) {
      // 从开始界面进入：本窗口当红方视角，再开一个窗口当蓝方视角
      const url = `${window.location.pathname}?mode=dual&side=blue&seed=${seed}${opts.debug ? '&debug=1' : ''}`;
      (opts.openWindow ?? window.open)(url, 'battlechess-blue', 'width=1030,height=690');
    }
    const makeWorker = opts.createWorker ?? createWorkerClient;
    return { mode, side: mySide, seed, client: makeWorker(seed, mySide), aiClient: null, authority: null };
  }

  const transport = createLocalTransport(seed);
  const mySide: Side | null = mode === 'ai' ? 'red' : null; // 热座用 null：可以替任意一方操作
  return {
    mode,
    side: mySide,
    seed,
    client: transport.connect(mySide),
    aiClient: mode === 'ai' ? transport.connect(AI_SIDE) : null,
    authority: transport.authority,
  };
}

export interface SessionApi {
  session: Session | null;
  seed: number;
  start: (mode: Mode, side?: Side | null) => Session;
  back: () => void;
  restart: () => void;
}

/**
 * 把当前种子写回地址栏。
 *
 * `?seed=` 本来就是"这一盘的编号"，写回去之后：刷新得到同一盘、分享给别人也是同一盘、
 * 复盘时也不用再问"你这盘种子多少"。用 replaceState 而不是 push —— 换一局不该往历史里
 * 塞一条记录，否则返回键会陷入一连串棋局。
 */
function syncSeedInUrl(seed: number): void {
  try {
    const url = new URL(window.location.href);
    if (url.searchParams.get('seed') === String(seed)) return;
    url.searchParams.set('seed', String(seed));
    window.history.replaceState(null, '', url.toString());
  } catch {
    // 拿不到 history（测试环境、隐私模式）就当没这回事，不能因此挂掉
  }
}

export function useSession(initialSeed: number, opts: SessionOptions = {}): SessionApi {
  const [seed, setSeed] = useState(initialSeed);
  const [session, setSession] = useState<Session | null>(null);
  const current = useRef<Session | null>(null);
  /**
   * **当前**棋局的种子。
   *
   * 不能读 `session.seed` —— 那是建会话时的快照，而"再来一局"是往同一个会话里发 restart，
   * 会话对象不重建。读它就永远得到同一个值：第二次点"再来一局"发的还是同一个种子，
   * 棋盘跟当前这盘一模一样（看起来就是"种子不刷新了"）。
   */
  const seedRef = useRef(initialSeed);

  // 用 ref 镜像一份，回调里读到的才是最新的；不在卸载时清理
  // （StrictMode 的模拟卸载会把会话关掉，而真实关页面本来就会销毁 worker/端口）
  useLayoutEffect(() => {
    current.current = session;
  }, [session]);

  function close(s: Session | null): void {
    s?.client.close();
    s?.aiClient?.close();
  }

  function start(mode: Mode, side: Side | null = null): Session {
    close(current.current);
    const next = createSession(mode, side, seedRef.current, opts);
    setSession(next);
    return next;
  }

  function back(): void {
    close(current.current);
    setSession(null);
  }

  function restart(): void {
    const s = current.current;
    if (!s) return;
    // 用 seedRef 递增（不能用 s.seed，见 seedRef 的注释）
    const nextSeed = seedRef.current + 1;
    seedRef.current = nextSeed;
    setSeed(nextSeed);
    syncSeedInUrl(nextSeed);
    s.client.send({ t: 'restart', seed: nextSeed });
  }

  return { session, seed, start, back, restart };
}
