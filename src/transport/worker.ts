// 双窗口传输：权威跑在 SharedWorker 里，两个标签页各自只拿到自己视角的投影。
// 这是"两个视角"的落地方式 —— 将来把 SharedWorker 换成 WebSocket 服务端，
// 消息协议不用改，视图层也不用改。

import type { Client } from './local';
import type { ClientMsg, ServerMsg, Side } from '../core/types';

export function workerSupported(): boolean {
  return typeof SharedWorker !== 'undefined';
}

export function createWorkerClient(seed: number, side: Side): Client {
  // 用 seed 当 worker 名：同一局的窗口共享同一个权威，换一局就是新权威
  const worker = new SharedWorker(new URL('../worker/authority.worker.ts', import.meta.url), {
    type: 'module',
    name: `battlechess-${seed}`,
  });
  const port = worker.port;

  const client: Client = {
    side,
    onmessage: () => {},
    send(msg: ClientMsg) {
      port.postMessage({ ...msg, side });
    },
    close() {
      port.close();
    },
  };

  port.onmessage = (ev: MessageEvent<ServerMsg>) => client.onmessage(ev.data);
  port.start();
  client.send({ t: 'join', seed, side });
  return client;
}
