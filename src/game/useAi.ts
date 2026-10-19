import { useEffect, useLayoutEffect, useState } from 'react';

import { chooseAction } from '../core/ai';
import { chooseActionNet } from '../core/aiNet';
import { pimcAction } from '../core/search';
import type { TinyNet } from '../core/nn';
import { mulberry32 } from '../core/rng';
import type { Client } from '../transport/local';
import type { Action, ServerMsg, Side, ViewState } from '../core/types';
import { currentNet, loadNet } from './netLoader';

export const AI_THINK_MS = 420;

/**
 * AI 档位（URL 参数 ?ai=）：
 *   search —— **默认**：PIMC 搜索（老师）。K 个采样世界 × 自适应深度 + 吃子延伸。
 *             耗时跟局面有关：开局约 0.3～0.5s，中后盘 1～1.3s（15 盘真实对局抽样量的）。
 *             对旧贪心的得分率 89.2%（60 局，红蓝各半）。
 *   greedy —— 原版一步贪心，最快也最弱。想回到"以前那个电脑"就用它。
 *   net    —— 神经网络（策略先验 + 一层前瞻），毫秒级。**目前还没有能打的权重**：
 *             训练管线通了、前向与 PyTorch 逐元素一致，但蒸馏出来的棋力还远不如老师，
 *             所以只作为可选项留着（权重加载失败也会自动退回 search）。
 */
export type AiKind = 'greedy' | 'search' | 'net';

export function readAiKind(search: string): AiKind {
  const v = new URLSearchParams(search).get('ai');
  if (v === 'greedy') return 'greedy';
  if (v === 'net') return 'net';
  // 'pimc' 是早期用的名字，留作别名，免得旧书签突然变成"最弱档"
  if (v === 'search' || v === 'pimc') return 'search';
  return 'search';
}

export function think(
  kind: AiKind,
  view: ViewState,
  rand: () => number,
  net: TinyNet | null,
): Action | null {
  if (kind === 'net' && net) return chooseActionNet(view, net, { rand }, 0, rand);
  // 浏览器里跟人下用的参数：比 DEFAULT_SEARCH（训练/验收用的最强调参）轻一档，
  // 约 290ms/手 vs 500ms/手。两段式预算（deepenWidth/deepenBudget）仍用默认值。
  if (kind === 'net' || kind === 'search') {
    // safetyGate：不许把子走到"下一手会被已翻开的敌子白吃"的格子（见 README「安全闸」）。
    // 250 是实测调出来的：150 时有一盘它在 +1420 的必胜局面里，靠"比安全着法高 171 分"
    // （净多 21 分、而 6 世界平均的噪声就有 ±208）把将军送到对方将军嘴边。250 拦住了它，
    // 而 9 个"自投罗网"仍拦 7 个、普通决策点仍只动 1%。
    // 它只用公开信息判定、不改评分，只在"有安全着法且分数差得不多"时否决 → 普通局面只动 1%。
    return pimcAction(
      view,
      { worlds: 6, nodeBudget: 400, deepenWidth: 5, deepenBudget: 2400, safetyGate: 250 },
      rand,
    );
  }
  return chooseAction(view, rand);
}

/**
 * 需要网络时把它拉起来。没加载好之前 `think` 会自动退回搜索（见上），
 * 所以这里不需要阻塞界面。
 */
export function useNet(enabled: boolean): TinyNet | null {
  const [net, setNet] = useState<TinyNet | null>(() => currentNet());
  useEffect(() => {
    if (!enabled || net) return;
    let alive = true;
    void loadNet().then((loaded) => {
      if (alive && loaded) setNet(loaded);
    });
    return () => {
      alive = false;
    };
  }, [enabled, net]);
  return net;
}

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
export function useAiMove(
  client: Client | null,
  view: ViewState | null,
  seed: number,
  /** AI 执哪一方：人机模式下是"我方颜色的反面"（颜色本身由种子派生） */
  aiSide: Side,
  kind: AiKind = 'greedy',
  net: TinyNet | null = null,
): void {
  useEffect(() => {
    if (!client || !view || view.over || view.turn !== aiSide) return;
    const step = view.step;
    const timer = setTimeout(() => {
      const rand = mulberry32((seed ^ Math.imul(step + 1, 2654435761)) >>> 0);
      const action = think(kind, view, rand, net);
      if (action) {
        client.send(action);
      }
    }, AI_THINK_MS);
    return () => clearTimeout(timer);
  }, [client, view, seed, aiSide, kind, net]);
}
