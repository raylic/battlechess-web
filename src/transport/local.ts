// 单机传输：权威就跑在页面里（人机 / 热座模式）

import { Authority, type AuthorityOptions } from '../core/authority';
import type { ClientMsg, ServerMsg, Side } from '../core/types';

export interface Client {
  readonly side: Side | null;
  onmessage: (msg: ServerMsg) => void;
  send(msg: ClientMsg): void;
  close(): void;
}

export interface Transport {
  readonly kind: 'local' | 'worker';
  connect(side: Side | null): Client;
}

export interface LocalTransport extends Transport {
  kind: 'local';
  /** 完整真相只给测试/本地调试用；界面一律走 client.onmessage 的投影 */
  authority: Authority;
}

export function createLocalTransport(seed: number, opts: AuthorityOptions = {}): LocalTransport {
  const authority = new Authority(seed, opts);

  return {
    kind: 'local',
    authority,
    connect(side: Side | null): Client {
      // 初始快照是**同步**下发的（见 Authority.subscribe），而 useGame 要到 layout effect
      // 才挂 onmessage —— 中间这段必须缓冲，否则第一条 state（整块棋盘）直接丢掉。
      // 缓冲也顺带干掉了"进游戏先闪一下空背景"：赋值那一刻同步 flush，setState 在 paint 之前。
      let handler: ((msg: ServerMsg) => void) | null = null;
      const pending: ServerMsg[] = [];
      let closed = false;
      const emit = (msg: ServerMsg) => {
        if (closed) return;
        if (handler) handler(msg);
        else pending.push(msg);
      };

      const client: Client = {
        side,
        get onmessage() {
          return handler ?? (() => {});
        },
        set onmessage(fn: (msg: ServerMsg) => void) {
          handler = fn;
          for (const msg of pending.splice(0)) fn(msg);
        },
        send(msg) {
          const res = authority.dispatch(side, msg);
          if ('rejected' in res) emit({ t: 'reject', reason: res.rejected });
        },
        close() {
          closed = true;
          pending.length = 0; // 关掉之后别再补发缓冲里的旧快照
          off();
        },
      };
      const off = authority.subscribe(side, emit);
      return client;
    },
  };
}
