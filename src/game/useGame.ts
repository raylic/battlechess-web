// 订阅一个 client，把消息变成 view / toast。
// 注意：client.onmessage 是"单播"的（一个 client 只挂一个处理器），
// 所以这里在 effect 里挂上、卸载时摘掉；StrictMode 的二次挂载是幂等的。

import { useCallback, useLayoutEffect, useState } from 'react';

import type { Client } from '../transport/local';
import type { ClientMsg, ServerMsg, ViewState } from '../core/types';

export interface GameApi {
  view: ViewState | null;
  toast: string | null;
  send: (msg: ClientMsg) => void;
  dismissToast: () => void;
}

export function useGame(client: Client | null): GameApi {
  const [view, setView] = useState<ViewState | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  // 用 useLayoutEffect 而不是 useEffect：被动效应在 paint 之后的宏任务里才跑，
  // 而初始 state 是 setTimeout(0) 下发的 —— 两者都是宏任务，谁先谁后不保证，
  // 一旦错过第一条 state，棋盘就整块渲染不出来
  useLayoutEffect(() => {
    if (!client) {
      setView(null);
      setToast(null);
      return;
    }
    client.onmessage = (msg: ServerMsg) => {
      if (msg.t === 'state') setView(msg.state);
      else setToast(msg.reason);
    };
    return () => {
      client.onmessage = () => {};
    };
  }, [client]);

  const send = useCallback(
    (msg: ClientMsg) => {
      client?.send(msg);
    },
    [client],
  );

  const dismissToast = useCallback(() => setToast(null), []);

  return { view, toast, send, dismissToast };
}
