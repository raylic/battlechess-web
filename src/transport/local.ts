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
  /** 只有 ?debug=1 的真面目面板会用它；正常渲染一律走 client.onmessage 的投影 */
  authority: Authority;
}

export function createLocalTransport(seed: number, opts: AuthorityOptions = {}): LocalTransport {
  const authority = new Authority(seed, opts);

  return {
    kind: 'local',
    authority,
    connect(side: Side | null): Client {
      const client: Client = {
        side,
        onmessage: () => {},
        send(msg) {
          const res = authority.dispatch(side, msg);
          if ('rejected' in res) client.onmessage({ t: 'reject', reason: res.rejected });
        },
        close() {
          off();
        },
      };
      const off = authority.subscribe(side, (msg) => client.onmessage(msg));
      return client;
    },
  };
}
