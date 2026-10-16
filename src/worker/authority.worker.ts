// SharedWorker：双窗口模式下的权威宿主。

import { Authority } from '../core/authority';
import { isRecord } from '../core/reduce';
import type { ServerMsg, Side } from '../core/types';

let authority: Authority | null = null;

// SharedWorker 里 self 的类型在 lib.webworker 里，我们用的是 DOM lib，所以自己声明用到的部分
interface SharedWorkerGlobalScopeLike {
  onconnect: ((event: MessageEvent) => void) | null;
}

const ctx = self as unknown as SharedWorkerGlobalScopeLike;

ctx.onconnect = (event: MessageEvent) => {
  const port = event.ports[0];
  if (!port) return;
  port.start();

  port.onmessage = (ev: MessageEvent<unknown>) => {
    const msg = ev.data;
    if (!isRecord(msg)) {
      port.postMessage({ t: 'reject', reason: '非法消息' } satisfies ServerMsg);
      return;
    }

    if (msg.t === 'join') {
      if (!authority) authority = new Authority(typeof msg.seed === 'number' ? msg.seed : 1);
      const side = (msg.side === 'red' || msg.side === 'blue' ? msg.side : null) as Side | null;
      authority.subscribe(side, (m) => port.postMessage(m));
      return;
    }

    const res = authority
      ? authority.dispatch((msg.side ?? null) as Side | null, msg)
      : ({ rejected: '权威尚未就绪' } as const);
    if ('rejected' in res) port.postMessage({ t: 'reject', reason: res.rejected } satisfies ServerMsg);
  };
};
