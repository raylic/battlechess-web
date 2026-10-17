// 神经网络驱动的 AI（"困难"档）。
//
// 结构：网络的策略头当先验 + 一次「网络价值头当叶子评估」的一层前瞻。
//
//   p = α · softmax( 叶子价值 / τ ) + (1 - α) · p网络
//
// 为什么叶子评估用网络价值头、而不是启发式物质分：价值头就是被训练来预测"这个局面
// 最后是赢是输"的，它比手写物质分更懂暗棋里的冒险与保守。而且这样做**很便宜**：
// 一层前瞻只需对每个候选着法各前向一次（默认宽度 10 → 10 次前向，约 30ms）。
//
// 一个关键性质（决定了它为什么这么便宜）：采样世界里"哪些格子翻开了"和真实视角完全一样
// （determinize 保留 revealed 标记），所以同一个着法之后，从对手视角编码出来的特征在
// 各个采样世界里是**同一份**（隐藏身份本来就不在特征里）。于是叶子评估不需要对 K 个世界
// 各算一遍 —— 一次就够，PIMC 的跨世界平均在这里退化成单次前向。
//
// 想要更多棋力可以再叠一层 PIMC（opts.worlds > 0），代价是要跑启发式搜索；
// 默认关掉，先用测出来的数据说话。

import { encode, maskedSoftmax, actionMask } from './features';
import { ACTION_COUNT, actionFromIndex } from './features';
import { other } from './pieces';
import { applyAction } from './reduce';
import { pimc } from './search';
import { determinize } from './search';
import type { TinyNet } from './nn';
import { viewFor } from './visibility';
import type { Action, ViewState } from './types';

export interface NetAiOptions {
  /** 一层前瞻里最多评估多少个候选着法（按网络先验挑） */
  rootWidth?: number;
  /** 叶子价值分布的软硬程度：越小越尖锐。价值头输出在 [-1,1]，所以这个尺度很小 */
  leafTemperature?: number;
  /** α：叶子价值（搜索）与网络先验的混合比例，0 = 纯先验 */
  alpha?: number;
  /** > 0 时额外叠一层 PIMC（启发式评估），作为第三个混合项 */
  worlds?: number;
  /** PIMC 那一项的混合权重 */
  searchWeight?: number;
  /** 覆盖 tmp 世界采样随机源（测试用） */
  rand?: () => number;
}

export const NET_DEFAULTS: Required<Omit<NetAiOptions, 'rand'>> = {
  rootWidth: 10,
  leafTemperature: 0.02,
  alpha: 0.5,
  worlds: 0,
  searchWeight: 0.5,
};

export interface NetDecision {
  /** 混合后的动作分布（长度 180，非法动作恒 0） */
  distribution: Float32Array;
  /** 网络对当前局面的价值估计（站在 view.you 视角） */
  value: number;
  chosen: number;
}

/**
 * 选出一步棋。`net` 为 null 时返回 null（调用方应回退到启发式 AI）。
 *
 * 只用 ViewState —— 和 core/ai.ts 是同一条信息边界。
 */
export function decideNet(
  view: ViewState,
  net: TinyNet,
  opts: NetAiOptions = {},
): NetDecision | null {
  const cfg = { ...NET_DEFAULTS, ...opts };
  if (view.over) return null;
  void other;

  const enc = encode(view);
  const mask = enc.mask;
  const { policy: logits, value } = net.forward(enc);

  const legal: number[] = [];
  for (let i = 0; i < ACTION_COUNT; i++) if (mask[i]) legal.push(i);
  if (!legal.length) return null;

  // 1) 网络先验
  const prior = maskedSoftmax(logits, mask, 1);

  // 2) 短名单：按先验取前 rootWidth 个
  const shortlist = legal
    .slice()
    .sort((x, y) => prior[y]! - prior[x]!)
    .slice(0, Math.max(1, Math.min(cfg.rootWidth, legal.length)));

  // 3) 一层前瞻：对每个候选算"走完之后对手怎么看这个局面"，取负就是我的价值
  const leafScores = new Float32Array(ACTION_COUNT).fill(-Infinity);
  const world = determinize(view, cfg.rand ?? Math.random);
  for (const i of shortlist) {
    const res = applyAction(world, actionFromIndex(i), true);
    if ('rejected' in res) continue;
    // 走完这步就分出结果的话，用真实结果，不要去过网络 ——
    // 终局的投影会把所有暗子翻开（viewFor 的 over 分支），那时"世界"是随便采的，
    // 拿它去问网络等于问一个随机棋盘。
    if (res.state.winner) {
      leafScores[i] = res.state.winner === 'draw' ? 0 : res.state.winner === view.you ? 1 : -1;
      continue;
    }
    const leafView = viewFor(res.state, other(view.you));
    const leaf = net.forward(encode(leafView));
    leafScores[i] = -leaf.value;
  }

  const leafMask = new Uint8Array(ACTION_COUNT);
  for (const i of shortlist) if (Number.isFinite(leafScores[i]!)) leafMask[i] = 1;
  const leafDist = maskedSoftmax(leafScores, leafMask, cfg.leafTemperature);

  // 4) 混合（权重先加起来再归一化，避免各项之和不为 1 时有人被偷偷放大）
  const dist = new Float32Array(ACTION_COUNT);
  let searchTerm: Float32Array | null = null;
  if (cfg.worlds > 0) {
    const res = pimc(view, { worlds: cfg.worlds }, cfg.rand ?? Math.random);
    searchTerm = res.policy;
  }

  const wPrior = 1 - cfg.alpha;
  const wLeaf = cfg.alpha;
  const wSearch = searchTerm ? cfg.searchWeight : 0;
  const total = wPrior + wLeaf + wSearch || 1;
  for (let i = 0; i < ACTION_COUNT; i++) {
    if (!mask[i]) continue;
    dist[i] =
      (wPrior * prior[i]! + wLeaf * leafDist[i]! + (searchTerm ? wSearch * searchTerm[i]! : 0)) / total;
  }

  let chosen = -1;
  for (const i of legal) if (chosen < 0 || dist[i]! > dist[chosen]!) chosen = i;
  return { distribution: dist, value, chosen };
}

/** 便捷：只要一个着法（可选温度采样，用于自对弈/评估） */
export function chooseActionNet(
  view: ViewState,
  net: TinyNet,
  opts: NetAiOptions = {},
  sampleTemperature = 0,
  rand: () => number = Math.random,
): Action | null {
  const decision = decideNet(view, net, opts);
  if (!decision || decision.chosen < 0) return null;
  if (sampleTemperature <= 0) return actionFromIndex(decision.chosen);
  const dist = maskedSoftmax(decision.distribution, actionMask(view), sampleTemperature);
  let r = rand();
  for (let i = 0; i < ACTION_COUNT; i++) {
    r -= dist[i]!;
    if (r <= 0 && dist[i]! > 0) return actionFromIndex(i);
  }
  return actionFromIndex(decision.chosen);
}
