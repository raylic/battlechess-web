// 权威：唯一持有真相、唯一能改状态的地方。
// 单机模式跑在页面里，双窗口模式跑在 SharedWorker 里 —— 同一个类，两种宿主。

import { applyAction, createState, isRecord } from './reduce';
import { DEFAULT_POLICY, viewFor } from './visibility';
import type { ClientMsg, DispatchResult, GameState, Policy, ServerMsg, Side, ViewState } from './types';

export interface AuthorityOptions {
  policy?: Policy;
  firstTurn?: Side;
}

export interface Subscriber {
  side: Side | null;
  onmessage: (msg: ServerMsg) => void;
}

export class Authority {
  readonly policy: Policy;

  private state: GameState;
  private readonly opts: AuthorityOptions;
  private readonly subs = new Set<Subscriber>();

  constructor(seed: number, opts: AuthorityOptions = {}) {
    this.opts = opts;
    this.policy = opts.policy ?? DEFAULT_POLICY;
    this.state = createState(seed, opts);
  }

  /**
   * 订阅某个视角。
   *
   * 初始状态必须**异步且晚于微任务**下发：调用方（React 的 effect / 原生版的 connect 之后那行）
   * 才来得及挂上 onmessage。用 queueMicrotask 是不够安全的 —— React 的effect 提交时机
   * 也在微任务队列里，谁先谁后不保证；一旦 emit 先跑，第一条 state 就被丢掉，
   * 结果是整个棋盘渲染不出来（原生版用同步 emit 就踩过这个坑）。
   * setTimeout 0 是宏任务，永远晚于当前任务的微任务。
   *
   * @returns 取消订阅
   */
  subscribe(side: Side | null, onmessage: (msg: ServerMsg) => void): () => void {
    const sub: Subscriber = { side, onmessage };
    this.subs.add(sub);
    setTimeout(() => {
      if (this.subs.has(sub)) this.emit(sub);
    }, 0);
    return () => {
      this.subs.delete(sub);
    };
  }

  /** side = null 表示"单机热座"：总是拿到当前回合方的视角 */
  view(side: Side | null): ViewState {
    return viewFor(this.state, side ?? this.state.turn, this.policy);
  }

  private emit(sub: Subscriber): void {
    sub.onmessage({ t: 'state', state: this.view(sub.side) });
  }

  private publish(): void {
    for (const sub of this.subs) this.emit(sub);
  }

  /**
   * 唯一的入口。side 必须等于当前回合方（null 例外，单机模式）。
   * msg 是**不可信输入**（来自 transport 边界），形状不对就拒，不抛异常。
   */
  dispatch(side: Side | null, msg: unknown): DispatchResult {
    if (!isRecord(msg)) return { rejected: '非法消息' };

    if (msg.t === 'restart') {
      const seed = typeof msg.seed === 'number' ? msg.seed : this.state.seed;
      this.state = createState(seed, this.opts);
      this.publish();
      return { ok: true };
    }

    if (side && side !== this.state.turn) return { rejected: '还没轮到你' };

    const res = applyAction(this.state, msg);
    if ('rejected' in res) return res;

    this.state = res.state;
    this.publish();
    return { ok: true, events: res.events };
  }

  /** 调试用：完整真相（只有单机模式拿得到） */
  truth(): GameState {
    return this.state;
  }
}

export type { ClientMsg };
