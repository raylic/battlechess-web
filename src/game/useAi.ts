// AI 侧：AI 也走自己的 client（side = blue），只看得到蓝方视角的投影，
// 和人类受同样的信息限制 —— 顺带把"两个视角"这条链路完整跑通。

import { useEffect, useLayoutEffect, useState } from 'react';

import { chooseAction } from '../core/ai';
import { mulberry32 } from '../core/rng';
import type { Client } from '../transport/local';
import type { ServerMsg, Side, ViewState } from '../core/types';

export const AI_SIDE: Side = 'blue';
export const AI_THINK_MS = 420;

export function useAiView(client: Client | null): ViewState | null {
  const [view, setView] = useState<ViewState | null>(null);

  // 同 useGame：必须在提交阶段就挂上 onmessage，否则会错过 setTimeout(0) 下发的初始 state
  useLayoutEffect(() => {
    if (!client) {
      setView(null);
      return;
    }
    client.onmessage = (msg: ServerMsg) => {
      if (msg.t === 'state') setView(msg.state);
    };
    return () => {
      client.onmessage = () => {};
    };
  }, [client]);

  return view;
}

/**
 * 轮到自己就思考一会儿再落子。
 * 用 seed + step 派生随机数 → 同一盘棋的 AI 走法可复现。
 */
export function useAiMove(client: Client | null, view: ViewState | null, seed: number): void {
  useEffect(() => {
    if (!client || !view || view.over || view.turn !== AI_SIDE) return;
    const step = view.step;
    const timer = setTimeout(() => {
      const rand = mulberry32((seed ^ Math.imul(step + 1, 2654435761)) >>> 0);
      const action = chooseAction(view, rand);
      if (action) client.send(action);
    }, AI_THINK_MS);
    return () => clearTimeout(timer);
  }, [client, view, seed]);
}
