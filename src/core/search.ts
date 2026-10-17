// PIMC（Perfect Information Monte Carlo）—— 暗棋这类"信息不完美"棋的经典搜索。
//
// 为什么是它：本作是**双盲暗棋**，公开信息 = 已翻开的棋子 + 双方各等级剩余数量 +
// 格子占用情况。而棋子在开局是均匀洗牌的，所以"与当前情报一致的世界"就是
// 「把剩余棋子池均匀随机地铺到未翻开的格子上」—— 后验分布可以精确采样，
// 不需要任何近似。于是：
//
//   对 K 个采样世界各做一次**完全信息**的浅层搜索（negamax + alpha-beta），
//   把同一个动作在 K 个世界里的分数取平均 → 谁在"我这边的信息集"里平均最好。
//
// 这一步顺手把 PIMC 的经典病（策略融合 / 信息泄漏）抹平了：搜索在单个世界里
// "知道"每个暗子是谁，会故意去翻自己的国王；但那个动作在别的世界里可能是翻对方的
// 刺客，跨世界平均之后就退化成「翻这一格到底值不值」的期望值 —— 这正是我们想要的。
//
// 合法着法在世界之间是**不变**的（只取决于已翻开信息和占用情况，两者都是公开的）。
//
// 这个模块一物两用：
//   1. 当老师 —— 自对弈产训练数据（纯搜索，不依赖网络）；
//   2. 上线时当"困难"档 —— 直接在浏览器里搜（见 game/useAi.ts 的 ?ai=pimc）。
//
// 性能上的两个关键决定（都是量出来的，不是猜的）：
//   · 搜索内部用 searchCore 的 make/unmake + 零分配着法生成。原先把 reduce.applyAction
//     直接搬进搜索，每节点约 80 次分配、15 微秒 —— 换成 make/unmake 之后同一批节点快一个量级。
//   · 根节点上的翻棋按公开几何归类（见 flipClasses）。开局 36 个翻棋本来会吃掉 95% 的节点预算，
//     而归类后的几个代表在信息集意义上等价；省下的预算全给走子 —— 而"送死/看不到两步"
//     恰恰全发生在走子上。

import { BOARD_SIZE, LEVEL_VALUE, other } from './pieces';
import { MAX_NO_EAT } from './judge';
import { publicKey } from './reduce';
import { shuffle } from './rng';
import type { GameState, Level, Piece, Pos, Side, ViewState } from './types';
import {
  ACTION_COUNT,
  FLIP_ACTION_BASE,
  MOVE_ACTION_BASE,
  actionFromIndex,
  actionIndex,
  hiddenPool,
  maskedSoftmax,
} from './features';
import {
  DIRS_FLAT,
  canEatLevel,
  captureIndicesFast,
  cellOf,
  cloneStateFast,
  colOf,
  createUndo,
  judgeFast,
  legalIndicesFast,
  make,
  rowOf,
  unmake,
  type Undo,
} from './searchCore';

/** 必杀分：远大于任何物质差（满盘物质差最多 ±2420） */
export const MATE = 1_000_000;

export interface SearchOptions {
  /** 采样多少个一致世界（K）。越大越稳，代价线性增长 */
  worlds?: number;
  /**
   * 搜索深度上限（ply）。**0 = 自动**（推荐）：根据盘上还剩多少子自适应。
   *
   * 固定深度无法兼顾两头：开局分支大（36+），深 3 就贵得没法用；
   * 残局子少，深 3 还远远不够 —— 该算到的杀都算不到，于是满盘和棋。
   */
  depth?: number;
  /**
   * **每个（世界 × 根动作）子树**的节点上限。
   *
   * 这是整个搜索的耗时安全阀：总代价 ≤ worlds × 根动作数 × nodeBudget。
   * 每个根动作拿到的预算一样，所以"谁被截断"不会系统性地偏向某个动作。
   */
  nodeBudget?: number;
  /** 根节点最多考虑多少个动作（按静态评分粗筛，Infinity = 全部） */
  rootWidth?: number;
  /** 策略目标的温度；越大越平 */
  temperature?: number;
  /** 吃子延伸搜索（quiescence）：地平线上还有吃子时继续算，治"偶尔送死" */
  quiescence?: boolean;
  /**
   * 重复局面的扣分（治"来回走子"）。
   *
   * 做法：根节点上，如果某个动作会把盘面带回**最近 32 步里出现过的公开局面**，
   * 就从它的跨世界平均分里扣掉这么多。
   * 取值得比一个弓箭手(120)大、比一个将军(300)小：均势下它压得住“绕圈”，
   * 但绝不会为了"不重复"去白丢一个将军。
   */
  repeatPenalty?: number;
  /**
   * 认输阈值（见 shouldResign）：最好的动作也低于 -resignMargin 就认输。
   * 故意偏松 —— 拖着不认比早认一点更难受；但要"最好的动作"都低于阈值，
   * 免得把还能守和的局面认掉。
   */
  resignMargin?: number;
  /**
   * 两段式预算的第二段：第一段排名前面的前几个动作，用 deepenBudget 重算一遍。
   *
   * 为什么需要它（实测案例，seed 9000 第107步）：
   *   同一个局面，只看 1～3 层时"国王送死"都是最高分（它其实是个国王互换），
   *   要到**第 4 层**才看得出它亏 400 分；而每根动作 400 节点的预算只够走到 3 层。
   *   也就是说：预算不够时，有些错误在搜索视野内是**看不见**的。
   * 做法：先用小预算把所有动作排一遍，再把排名靠前的几个用大预算重算 ——
   * 把节点花在真正有可能赢的那几手上，而不是给每个动作平均分（平均分意味着谁都走不到底）。
   *
   * deepenWidth = 0 关闭第二段（回到旧行为）。
   */
  deepenWidth?: number;
  deepenBudget?: number;
  /**
   * 吃子延伸（quiescence）用**独立预算**：默认 false = 它的节点也记在主预算里。
   *
   * 假设（v2 实验）：一手深的反驳（"我吃一个子，然后被你吃"）是在吃子延伸里被算掉的，
   * 而吃子延伸会把主预算吃光 —— 于是主搜索只走到 1~2 层，名义深度 5 层形同虚设；
   * 分开之后主搜索能真的走到名义深度。
   *
   * **实测没有收益，所以默认关闭**（同种子 60 局自对弈，两侧只差这个开关）：
   *   v1 胜14 负12 和34（得分率 51.7%） vs v2 48.3%
   * 而且 v2 的节点更多（主 400 + 吃子延伸 400），更慢。结论：正常对局里"预算被吃子延伸抢走"
   * 不是主导因素。留这个开关是为了以后再用 arena 的 --a-opt/--b-opt 试别的口径。
   *
   * 注意这类 A/B 的局限：两个水平相同的引擎互殴会大量和棋/认输
   * （上面 60 局里 34 局 30 步判和、26 局认输、**0 局吃光**），所以它是弱仪器 ——
   * 要看真差距，拿一个共同参照物（比如贪心）分别打，或者把局数拉到几百局。
   */
  splitQuiescenceBudget?: boolean;
  /** 见 EvalFlags.hiddenThreat：暗子被攻击也算威胁 */
  hiddenThreat?: boolean;
  /** 见 EvalFlags.kingFullPrice：挂着的国王按全价 1000 算 */
  kingFullPrice?: boolean;
  /** 见 EvalFlags.ownThreatFull：我方挂子按全价（悲观），敌方仍打半价 */
  ownThreatFull?: boolean;
  /** 深度上限提高几层（见 boostedDepth；默认 0） */
  depthBoost?: number;
  /**
   * 安全闸（默认 0 = 关）：**不许把子走到"下一手会被已翻开的敌子白吃"的格子**，
   * 除非分数比最好的安全着法高出这么多。
   *
   * 起因：16 盘人类对局里有 9 次它主动把子走到"只剩被吃"的地方（8 次下一手真被吃），
   * 而每次都有 10 几个不糟的选择。实测那 9 手里多数在 1~2 层是明确坏棋（排 13~19/20），
   * 是 3 层的"补偿幻觉" + 6 个世界的采样噪声把它推上去的。
   *
   * 所以这条规则**不参与评分**，只做"否决"：它用纯公开信息算（零采样噪声），
   * 只在"有安全着法、且分数差得不多"的时候拦下 —— 真正的弃子（明显更优）会被保留。
   * 典型值 150：约等于一个骑士的分，比"随机波动"大、比"真弃子的收益"小。
   */
  safetyGate?: number;
  /** 独立吃子延伸的预算（splitQuiescenceBudget 打开时生效，默认 = nodeBudget） */
  quiescenceBudget?: number;
  /**
   * 根节点上，把翻棋按"公开可见的邻接几何"归成几类，每类只搜一个代表。
   *
   * 双盲之下，两个都还没翻开的格子"是谁"的概率分布是一样的（见 features.hiddenPool），
   * 所以翻 A 格与翻 B 格的差别**只来自几何**：旁边有没有敌方明子、有没有我已翻开的子、
   * 是不是边角格。开局 36 个翻棋会把节点预算全部吃掉（实测占 95% 时间），归类后只剩几个
   * 代表，省下的预算全给走子。
   *
   * 归类只看公开信息，所以 K 个世界里是同一份归类；同一类的格子共享分数，
   * 策略目标自然在该类里均分 —— 不会因为"没搜"就把某些格子当成坏棋。
   */
  flipClasses?: boolean;
}

export const DEFAULT_SEARCH: Required<SearchOptions> = {
  worlds: 8,
  depth: 0,
  nodeBudget: 400,
  rootWidth: Number.POSITIVE_INFINITY,
  temperature: 120,
  quiescence: true,
  flipClasses: true,
  repeatPenalty: 150,
  resignMargin: 1400,
  deepenWidth: 5,
  deepenBudget: 2400,
  splitQuiescenceBudget: false,
  quiescenceBudget: 0,
  hiddenThreat: false,
  kingFullPrice: false,
  ownThreatFull: false,
  depthBoost: 0,
  safetyGate: 0,
};

/**
 * 残局加深：盘上子越少，搜索越深。
 * 这个游戏"吃子"只能吃相邻格，所以杀棋总是短距离的 —— 子少时加深就能真的算清楚。
 */
export function autoDepth(alivePieces: number): number {
  if (alivePieces <= 6) return 8;
  if (alivePieces <= 10) return 6;
  if (alivePieces <= 16) return 5;
  if (alivePieces <= 24) return 4;
  return 3;
}

/**
 * 深度上限的额外层数（depthBoost，默认 0 = 历史行为）。
 *
 * 起因是一批实测：把"走完被白吃"的 12 个真实坏棋拿去用显式深度重搜，
 * 4/6 层时它们是"最好的手"，到 8 层就掉到第 4~8 名（还有个直接掉到认输级）。
 * 也就是说**这批错误是深度不够**，不是评估写错 —— 而旧配置里 `deepenBudget`
 * 加大也没用，因为深度被 autoDepth 卡死了：预算再多也只是把同样的浅层算得更细。
 *
 * 所以正确的杠杆是**同时**抬深度上限和深化预算（deepenBudget），
 * 两者缺一不可：只抬预算 = 白烧时间，只抬上限 = 搜不到那么深。
 */
export function boostedDepth(alivePieces: number, boost: number): number {
  return autoDepth(alivePieces) + Math.max(0, boost);
}

export type Random = () => number;

/**
 * 采样一个"与 view 一致"的完全信息世界。
 *
 * 一致性 = 已翻开的格子（身份/位置/朝向）完全一致 + 空格一致 + 占用情况一致 +
 *          未翻开格子上分配到的棋子，其双方各等级数量与公开的剩余池完全一致。
 * 后验是均匀的（洗牌是均匀的），所以直接均匀随机分配即可 —— 这里不做任何加权。
 */
export function determinize(view: ViewState, rand: Random = Math.random): GameState {
  const grid: (Piece | null)[][] = [];
  const hidden: { at: Pos; id: string }[] = [];

  for (let row = 0; row < 6; row++) grid.push(new Array<Piece | null>(6).fill(null));
  for (const cell of view.cells) {
    const [row, col] = cell.at;
    if (!cell.id) continue; // 空格
    if (cell.revealed && cell.side && cell.level !== null) {
      grid[row]![col] = { id: cell.id, side: cell.side, level: cell.level, revealed: true, dire: cell.dire };
      continue;
    }
    hidden.push({ at: [row, col], id: cell.id });
  }

  const pool = hiddenPool(view);
  const deck: { side: Side; level: Level }[] = [];
  for (const side of ['red', 'blue'] as const) {
    for (let level = 0; level < pool[side].length; level++) {
      for (let i = 0; i < pool[side][level]!; i++) deck.push({ side, level: level as Level });
    }
  }
  if (deck.length !== hidden.length) {
    throw new Error(`determinize：剩余池 ${deck.length} 个 vs 暗格 ${hidden.length} 个，情报不自洽`);
  }

  const mixed = shuffle(deck, rand);
  hidden.forEach((slot, i) => {
    const p = mixed[i]!;
    // 暗子的 id 沿用 view 里的 id：id 是给前端做动画 key 的，不携带身份信息
    grid[slot.at[0]]![slot.at[1]] = { id: slot.id, side: p.side, level: p.level, revealed: false, dire: 0 };
  });

  return {
    seed: view.step,
    grid,
    turn: view.turn,
    step: view.step,
    noEat: view.noEat,
    counts: { ...view.counts },
    lastStep: view.lastStep ? ([...view.lastStep] as Pos) : null,
    winner: view.winner,
    reason: view.reason,
    // 历史是公开知识，K 个世界共用同一份；只在根节点拿它做循环判定，不参与评估
    history: view.recent.slice(),
  };
}

/** 暗子在完全信息世界里按折扣计价：能打出去的明子才值全价 */
const HIDDEN_DISCOUNT = 0.55;
/**
 * 被相邻明子盯上的折扣（两边同价）。
 *
 * 试过把它改成"不对称"：能吃的敌子记全价、我被盯的子记半价。它确实能让
 * "吃一个子然后被吃"这类叶子如实计价（实测 seed 1884006669 第35步：真实净亏 100，
 * 0.5 口径只算出 −22，于是白送被当成平手），**但棋力掉得更多**：
 * 敌子记全价之后"现在就吃"和"以后吃"等价（吃下去 = 物质，不吃 = 威胁），它就不再急着吃子，
 * 同种子 12 局从 12胜0负0和 掉到 8胜1负3和（只记最贵挂子则是 9胜0负3和）。
 * 所以维持对称的 0.5：宁可在必败局面里偶尔掉子，也别把赢棋走成和棋。
 */
const HANGING_WEIGHT = 0.5;

/** (row,col) 上的子是否被 by 方的相邻明子吃得到 */
function isAttacked(state: GameState, row: number, col: number, level: Level, by: Side): boolean {
  for (let d = 0; d < 4; d++) {
    const r = row + DIRS_FLAT[d * 2]!;
    const c = col + DIRS_FLAT[d * 2 + 1]!;
    if (r < 0 || c < 0 || r > 5 || c > 5) continue;
    const q = state.grid[r]![c];
    if (q && q.revealed && q.side === by && canEatLevel(q.level, level)) return true;
  }
  return false;
}

/**
 * 静态评估（从 side 视角，越大越好）。
 *
 * 只读 state，不做任何搜索。三项：
 *   物质：明子全价 + 暗子打折 —— "打折"正是"翻牌有收益"的来源
 *   威胁：已翻开且被相邻敌子吃得到的子，按其价值打半价扣分/加分（见 HANGING_WEIGHT）
 *   机动：双方可走步数之差（很轻，只用来打破僵局）
 *
 * 最后整体乘一个"和棋倒计时"收缩系数：越接近 30 步无吃子，优势越被向 0（=和棋）拉。
 * 这一条同时管住两种消极：领先时不能躺平（优势会被和棋吃掉），落后时乐得拖延。
 * 而均势局面下它不动手 —— 均势本来就是一盘和棋，没必要为了"好看"去送子。
 *
 * 注：这里曾经有过一个"追击敌人"项，写错了：它算的是"双方明子的最近距离"，
 * 而那个距离对两边是同一个数，相减恒为 0。留着只会自己骗自己，所以删了 ——
 * 追击该不该做，交给搜索去权衡（残局加深之后它自己就能算出来）。
 *
 * 这个函数在搜索的**每个叶子**上都会被调用，所以刻意不用 movesFrom()（它每次分配数组）。
 */
/**
 * "安全闸"用的公开盘面：只有已翻开的子知道身份，暗子记为 unknown。
 *
 * 为什么只用公开信息：这条规则要回答的是"**我看得见的白吃**" —— 你我都看得见那颗子
 * 下一手会被吃，它却偏要走过去。用公开信息算，好处是**零跨世界噪声**（不依赖采样），
 * 而且不会因为某个世界里"那颗暗子其实是国王"而变卦。
 */
interface GateCell {
  side: Side | 'unknown';
  level: number;
  revealed: boolean;
}

function gateBoard(view: ViewState): (GateCell | null)[] {
  const board: (GateCell | null)[] = new Array(BOARD_SIZE * BOARD_SIZE).fill(null);
  for (const cell of view.cells) {
    if (!cell.id) continue;
    board[cell.at[0] * BOARD_SIZE + cell.at[1]] =
      cell.revealed && cell.side && cell.level !== null
        ? { side: cell.side, level: cell.level, revealed: true }
        : { side: 'unknown', level: -1, revealed: false };
  }
  return board;
}

/**
 * 公开信息下"我方白送"的最大净亏：已翻开的我方子被已翻开的敌子吃得到、
 * 且我方吃它不回来（暗子不能吃子，所以双方都必须是已翻开的）。
 * 返回 0 = 没有看得见的白送。
 */
function publicExposure(board: (GateCell | null)[], side: Side): number {
  let worst = 0;
  for (let row = 0; row < BOARD_SIZE; row++) {
    for (let col = 0; col < BOARD_SIZE; col++) {
      const p = board[row * BOARD_SIZE + col];
      if (!p || !p.revealed || p.side !== side) continue;
      for (let d = 0; d < 4; d++) {
        const r = row + DIRS_FLAT[d * 2]!;
        const c = col + DIRS_FLAT[d * 2 + 1]!;
        if (r < 0 || c < 0 || r >= BOARD_SIZE || c >= BOARD_SIZE) continue;
        const q = board[r * BOARD_SIZE + c];
        if (!q || !q.revealed || q.side === side) continue;
        if (!canEatLevel(q.level, p.level)) continue;
        // 能不能用另一颗已翻开的子吃回这个攻击者
        let recap = 0;
        for (let e = 0; e < 4; e++) {
          const r2 = row + DIRS_FLAT[e * 2]!;
          const c2 = col + DIRS_FLAT[e * 2 + 1]!;
          if (r2 < 0 || c2 < 0 || r2 >= BOARD_SIZE || c2 >= BOARD_SIZE) continue;
          const d2 = board[r2 * BOARD_SIZE + c2];
          if (d2 && d2.revealed && d2.side === side && canEatLevel(d2.level, q.level)) recap = 1;
        }
        const loss = recap ? Math.max(0, LEVEL_VALUE[p.level]! - LEVEL_VALUE[q.level]!) : LEVEL_VALUE[p.level]!;
        if (loss > worst) worst = loss;
      }
    }
  }
  return worst;
}

/**
 * 走完这一步之后的**净**代价 = 我方白吃暴露 − 这手吃到的子。
 *
 * 为什么要减：这条规则的目标是"白送"，不是"吃子"。走到一个会被吃的地方、
 * 但那一步同时吃掉更贵的子（吃 300 的将军、挂 120 的弓箭手），那是划算的交换，
 * 不该被拦 —— 一开始只比"暴露"不比"收益"，就误伤过一盘赢棋（16 局对局里一盘赢变和）。
 */
function netAfter(board: (GateCell | null)[], side: Side, from: Pos, to: Pos): number {
  const target = board[to[0] * BOARD_SIZE + to[1]];
  // 只有"已翻开的敌子"才算确定的收益；吃暗子是赌（公开信息里不知道值多少），按 0 算
  const gain = target && target.revealed && target.side !== side ? LEVEL_VALUE[target.level]! : 0;
  const next = board.slice();
  const moved = next[from[0] * BOARD_SIZE + from[1]];
  if (!moved) return publicExposure(board, side) - gain;
  next[from[0] * BOARD_SIZE + from[1]] = null;
  // 目标格上的子一定被吃掉（公开规则：走到敌子格就是吃，吃不动的话这一步本来就非法）
  next[to[0] * BOARD_SIZE + to[1]] = moved;
  return publicExposure(next, side) - gain;
}

/** 评估函数的开关。默认全 false = 历史行为，改一条量一条，不要一次动两处 */
export interface EvalFlags {
  /**
   * 暗子被攻击也算威胁（默认 false = 只看已翻开的子）。
   *
   * 双盲规则下"我看不见它在被吃"不等于它没在被吃。每个采样世界都是完全信息，
   * 所以这里按**世界的真值**算，跨世界平均出来正好是概率期望 ——
   * 也就是说这个开关让 PIMC 的概率计算真正生效，而不是被 if (!p.revealed) 挡住。
   */
  hiddenThreat?: boolean;
  /**
   * 挂着的国王按全价（默认 false = 和别的子一样打 HANGING_WEIGHT 折）。
   *
   * 国王被吃基本等于输掉这盘（1000 分，且实际游戏里 10/11 盘以认输结束，
   * 丢国王就认输），而它**吃不回来**：能杀国王的只有国王和刺客 ——
   * 你吃掉那个刺客只值 40。所以国王挂着不该按半价 500 算，就是 1000。
   * 数据：11 盘人类对局里国王死了 14 次（AI 丢 9 次），刺客是主凶。
   */
  kingFullPrice?: boolean;
  /**
   * **我方**挂着的子按全价算（敌方仍按 HANGING_WEIGHT 折价）—— 悲观评估。
   *
   * 这是"自投罗网"的直接对症：16 盘人类对局里有 9 次它主动把子走到"只剩被吃"的格子，
   * 而且每次都还有十几个不糟的选择。原因就是威胁项对自己人也打半价 ——
   * "吃一个 60 分的禁卫军、白送一个 160 分的骑士"在它眼里只有 -20（真值 -100）。
   *
   * 为什么不能整体提高 HANGING_WEIGHT：那样**敌方**挂子也变成满价，它就觉得
   * "这子迟早是我的"，反而不急着吃、把赢棋走成和棋（实测 12胜0负0和 → 8胜1负3和）。
   * 只罚自己、不奖励自己，才是安全的做法。
   */
  ownThreatFull?: boolean;
}

export function evaluate(state: GameState, side: Side, flags: EvalFlags = {}): number {
  const enemy = other(side);
  let material = 0;
  let threat = 0;
  let mobility = 0;
  let enemyMobility = 0;

  for (let row = 0; row < 6; row++) {
    for (let col = 0; col < 6; col++) {
      const p = state.grid[row]![col];
      if (!p) continue;
      const value = LEVEL_VALUE[p.level]!;
      const mine = p.side === side;
      material += (mine ? value : -value) * (p.revealed ? 1 : HIDDEN_DISCOUNT);

      // 机动性只对已翻开的子算：暗子既不能走也不能吃子
      if (p.revealed) {
        let moves = 0;
        for (let d = 0; d < 4; d++) {
          const r = row + DIRS_FLAT[d * 2]!;
          const c = col + DIRS_FLAT[d * 2 + 1]!;
          if (r < 0 || c < 0 || r > 5 || c > 5) continue;
          const q = state.grid[r]![c];
          if (!q) moves += 1;
          else if (q.revealed && q.side !== p.side && canEatLevel(p.level, q.level)) moves += 1;
        }
        if (mine) mobility += moves;
        else enemyMobility += moves;
      }

      // 威胁：能吃的只有已翻开的子（暗子不能吃子），所以攻击者必须是 revealed；
      // 但**被攻击的子**可以是暗的 —— 这一点由 flags.hiddenThreat 控制。
      if (p.revealed || flags.hiddenThreat) {
        const attacked = isAttacked(state, row, col, p.level, mine ? enemy : side);
        if (attacked) {
          const full = (flags.kingFullPrice && p.level === 0) || (flags.ownThreatFull && mine);
          threat += (mine ? -value : value) * (full ? 1 : HANGING_WEIGHT);
        }
      }
    }
  }

  const live = Math.min(state.noEat, MAX_NO_EAT) / MAX_NO_EAT;
  const shrink = 1 - 0.6 * live;

  return (material + threat + (mobility - enemyMobility) * 2) * shrink;
}

function terminalValue(state: GameState, ply: number): number {
  // 站在 state.turn 的视角：winner 已是最终结果
  if (state.winner === 'draw') return 0;
  if (state.winner === state.turn) return MATE - ply;
  return -(MATE - ply);
}

/**
 * 静态动作排序：吃子 > 走子 > 翻棋。
 * alpha-beta 能剪掉多少，全看第一个动作是不是好动作 —— 移动排序是这个搜索里最便宜的加速器。
 */
function orderActions(state: GameState, indices: number[], killers?: Int32Array): void {
  const score = (i: number): number => {
    // 杀手着法（在兄弟节点造成过剪枝的着法）—— 排序里最便宜的一档收益
    const killer = killers && (killers[0] === i || killers[1] === i) ? 5_000 : 0;
    if (i < MOVE_ACTION_BASE) return -10 + killer; // 翻棋：排最后（它不会直接吃子）
    const rest = i - MOVE_ACTION_BASE;
    const cell = (rest / 4) | 0;
    const d0 = rest % 4;
    const row = rowOf(cell) + DIRS_FLAT[d0 * 2]!;
    const col = colOf(cell) + DIRS_FLAT[d0 * 2 + 1]!;
    const target = state.grid[row]?.[col];
    if (target && target.revealed) {
      // MVV-LVA：优先"最贵的受害者 + 最便宜的进攻者"（用便宜子吃贵子，先试这种最可能剪枝）
      const attacker = state.grid[rowOf(cell)]![colOf(cell)]!;
      return 10_000 + LEVEL_VALUE[target.level]! * 4 - LEVEL_VALUE[attacker.level]!;
    }
    if (killer) return killer; // 杀手是空位/普通走子时也要靠前
    // 空位：预估"走到这里之后能不能吃到邻子"
    const me = state.grid[rowOf(cell)]![colOf(cell)]!;
    let best = 0;
    for (let d = 0; d < 4; d++) {
      const q = state.grid[row + DIRS_FLAT[d * 2]!]?.[col + DIRS_FLAT[d * 2 + 1]!];
      if (q && q.revealed && q.side !== me.side && canEatLevel(me.level, q.level)) {
        best = Math.max(best, LEVEL_VALUE[q.level]!);
      }
    }
    return best;
  };
  indices.sort((x, y) => score(y) - score(x));
}

interface Ctx {
  nodes: number;
  budget: number;
  quiescence: boolean;
  /** 评估开关（原样透传给 evaluate） */
  flags: EvalFlags;
  /** 每层两个杀手着法：在兄弟节点上造成过剪枝的着法，优先重试（纯提速，不改结果） */
  killers: Int32Array;
  /** 吃子延伸自己的节点数与预算（splitQuiescenceBudget 打开时才用） */
  qNodes: number;
  qBudget: number;
  split: boolean;
  /** 每个 ply 一份撤销记录 / 着法缓冲，预分配复用 → 整棵搜索零分配 */
  undos: Undo[];
  moves: number[][];
}

function createCtx(budget: number, quiescence: boolean, split: boolean, qBudget: number, flags: EvalFlags): Ctx {
  return {
    nodes: 0,
    budget,
    quiescence,
    flags,
    killers: new Int32Array(48 * 2).fill(-1),
    qNodes: 0,
    qBudget: qBudget > 0 ? qBudget : budget,
    split,
    undos: Array.from({ length: 48 }, createUndo),
    moves: Array.from({ length: 48 }, () => [] as number[]),
  };
}

/**
 * 吃子延伸（quiescence）：地平线上还有吃子就继续往下算，直到局面"安静"为止。
 *
 * 没有它的时候，"我走了一步、对手下一步能吃我"这种送死会被深度截断掉 ——
 * 这正是实际对局里那种"偶尔莫名其妙送一个子"的来源。
 * 只在**吃子**上延伸，代价很小（吃子着法通常只有几个），再加一条 delta 剪枝：
 * 就算把对方这个子吃下来也不够好，就直接不看了。
 */
function quiescence(state: GameState, ply: number, alpha: number, beta: number, ctx: Ctx, limit: number): number {
  const stand = evaluate(state, state.turn, ctx.flags);
  if (stand >= beta) return stand;
  // 预算口径：默认和主搜索共用一份；split 打开时用自己那份（见 splitQuiescenceBudget）
  const outOfBudget = ctx.split ? ctx.qNodes >= ctx.qBudget : ctx.nodes >= ctx.budget;
  if (limit <= 0 || outOfBudget) return stand;

  const captures = ctx.moves[ply % 48]!;
  captureIndicesFast(state, captures);
  if (!captures.length) return stand;

  orderActions(state, captures);
  let best = stand;
  let a = Math.max(alpha, stand);
  for (const i of captures) {
    const rest = i - MOVE_ACTION_BASE;
    const cell = (rest / 4) | 0;
    const d0 = rest % 4;
    const target = state.grid[rowOf(cell) + DIRS_FLAT[d0 * 2]!]?.[colOf(cell) + DIRS_FLAT[d0 * 2 + 1]!];
    // delta 剪枝：吃掉它也只够这个数，不可能好过已有的 best
    if (target && stand + LEVEL_VALUE[target.level]! + 200 <= a) continue;

    const undo = ctx.undos[ply % 48]!;
    make(state, i, undo, false);
    if (ctx.split) ctx.qNodes += 1;
    else ctx.nodes += 1;
    const value = -quiescence(state, ply + 1, -beta, -a, ctx, limit - 1);
    unmake(state, undo);
    if (value > best) best = value;
    if (best > a) a = best;
    if (a >= beta) break;
  }
  return best;
}

/** negamax + alpha-beta，返回值站在 state.turn 视角。会**原地改** state，但退出时恢复 */
function negamax(state: GameState, depth: number, ply: number, alpha: number, beta: number, ctx: Ctx): number {
  if (state.winner) return terminalValue(state, ply);
  if (depth <= 0) {
    if (ctx.quiescence) return quiescence(state, ply, alpha, beta, ctx, 4);
    return evaluate(state, state.turn, ctx.flags);
  }
  if (ctx.nodes >= ctx.budget) return evaluate(state, state.turn, ctx.flags);
  ctx.nodes += 1;

  const indices = ctx.moves[ply % 48]!;
  legalIndicesFast(state, indices);
  if (!indices.length) return 0;

  orderActions(state, indices, ctx.killers.subarray(ply % 48 * 2, (ply % 48) * 2 + 2));

  let best = -Infinity;
  let a = alpha;
  let first = true;
  for (const i of indices) {
    const undo = ctx.undos[ply % 48]!;
    make(state, i, undo, false);
    // PVS：第一个着法用全窗口，其余先用空窗探一下（大概率不如 best），
    // 只有真的超出 alpha 才用全窗重搜 —— 省下的是每个节点的整棵子树宽度
    let value = -negamax(state, depth - 1, ply + 1, first ? -beta : -a - 1, -a, ctx);
    if (!first && value > a && value < beta) {
      value = -negamax(state, depth - 1, ply + 1, -beta, -a, ctx);
    }
    unmake(state, undo);
    first = false;
    if (value > best) best = value;
    if (best > a) a = best;
    if (a >= beta) {
      // 记下这个杀手着法（只记走子/吃子，翻棋不记）
      const slot = (ply % 48) * 2;
      if (ctx.killers[slot] !== i) {
        ctx.killers[slot + 1] = ctx.killers[slot]!;
        ctx.killers[slot] = i;
      }
      break; // 剪枝
    }
  }
  return best === -Infinity ? evaluate(state, state.turn, ctx.flags) : best;
}

export interface PimcResult {
  /** 每个动作的跨世界平均分（未考虑网络；长度 180） */
  scores: Float32Array;
  /** 归一化策略目标（softmax(scores / temperature)，非法动作恒 0） */
  policy: Float32Array;
  /** 平均分最高的动作下标；无合法着法时为 -1 */
  best: number;
  /** 实际参与统计的世界数 */
  worlds: number;
  /** 实际搜索的节点数（跨所有世界累计）—— 用来核对"节点预算是否真的在兜住耗时" */
  nodes: number;
  /** 最好的动作也明显是输 → 建议认输（由 pimcAction 翻成 {t:'resign'}） */
  resign: boolean;
}

interface RootPlan {
  /** 真正要去搜的动作下标 */
  reps: number[];
  /** 代表动作 → 它代表的全部动作（含自己）；不在这里的就是自己搜自己 */
  cover: Map<number, number[]>;
}

/**
 * 翻棋归类用的类别键：只看"公开可见的邻接关系"。
 *   贴没贴着敌方明子 / 贴没贴着我方明子 / 是不是边角格
 */
export function flipClassKey(view: ViewState, cell: number): string {
  const row = rowOf(cell);
  const col = colOf(cell);
  let enemy = 0;
  let mine = 0;
  for (let d = 0; d < 4; d++) {
    const r = row + DIRS_FLAT[d * 2]!;
    const c = col + DIRS_FLAT[d * 2 + 1]!;
    if (r < 0 || c < 0 || r > 5 || c > 5) continue;
    const q = view.cells[r * 6 + c]!;
    if (!q.id || !q.revealed) continue;
    if (q.side === view.you) mine = 1;
    else enemy = 1;
  }
  const edge = row === 0 || row === 5 || col === 0 || col === 5 ? 1 : 0;
  const corner = (row === 0 || row === 5) && (col === 0 || col === 5) ? 1 : 0;
  return `${enemy}${mine}${edge}${corner}`;
}

/** 定下"根节点要搜哪些动作"：走子一个一个搜，翻棋按几何归类取代表 */
function planRoots(view: ViewState, legal: number[], collapseFlips: boolean): RootPlan {
  if (!collapseFlips) return { reps: legal, cover: new Map() };

  const groups = new Map<string, number[]>();
  const reps: number[] = [];
  const cover = new Map<number, number[]>();

  for (const i of legal) {
    if (i >= MOVE_ACTION_BASE) {
      reps.push(i);
      continue;
    }
    const key = flipClassKey(view, i - FLIP_ACTION_BASE);
    const list = groups.get(key);
    if (list) list.push(i);
    else groups.set(key, [i]);
  }
  for (const list of groups.values()) {
    const rep = list[0]!;
    reps.push(rep);
    if (list.length > 1) cover.set(rep, list);
  }
  reps.sort((a, b) => a - b);
  return { reps, cover };
}

/** 根动作的静态粗筛评分（用于 rootWidth 剪枝，也用于给浅搜索定序） */
function rootRank(state: GameState, index: number, side: Side): number {
  if (index < MOVE_ACTION_BASE) {
    const cell = index - FLIP_ACTION_BASE;
    const target = state.grid[rowOf(cell)]![colOf(cell)];
    if (!target) return -1e9;
    const value = LEVEL_VALUE[target.level]! * HIDDEN_DISCOUNT;
    return (target.side === side ? 1 : -1) * value;
  }
  const rest = index - MOVE_ACTION_BASE;
  const cell = (rest / 4) | 0;
  const d0 = rest % 4;
  const target = state.grid[rowOf(cell) + DIRS_FLAT[d0 * 2]!]?.[colOf(cell) + DIRS_FLAT[d0 * 2 + 1]!] ?? null;
  if (target && target.revealed) return 1000 + LEVEL_VALUE[target.level]!;
  return 0;
}

/** 合法动作下标（只读 view.legal，不重算规则） */
export function legalActionIndices(view: ViewState): number[] {
  const out: number[] = [];
  for (const at of view.legal.flips) out.push(actionIndex({ t: 'flip', at })!);
  for (const m of view.legal.moves) out.push(actionIndex({ t: 'move', from: m.from, to: m.to })!);
  return out;
}

function maskOf(view: ViewState): Uint8Array {
  const mask = new Uint8Array(ACTION_COUNT);
  for (const i of legalActionIndices(view)) mask[i] = 1;
  return mask;
}

/**
 * PIMC 主入口：给定视角，返回每个合法动作的跨世界平均分。
 * `rand` 必须是可复现的随机源（同一 seed 同一盘棋走出同样的棋）。
 */
/**
 * 认输判定。三条同时成立才认：
 *   1. 规则允许（view.canResign = 已经走过 MIN_GIVEUP 步）
 *   2. 有合法着法
 *   3. **最好的动作**的跨世界平均分都低于 -margin
 *
 * 第 3 条特意看"最好的动作"而不是平均：只要能找到一手还能拖的棋（比如守和），
 * 就不会认输。分数里已经含有"和棋倒计时收缩"，所以接近 30 步无吃子的局面分数会被
 * 拉向 0，自然难过阈值 —— 能守和就不认。
 *
 * margin 传非有限值（Infinity/NaN）即彻底关闭认输。
 * 实测标定（见 README）：margin=600 太松 —— 它只落后一个小级别的子力就认了，
 * 所以在第 20 步就认输是常态；默认值调到"落后约一个国王"才认。
 */
export function shouldResign(view: ViewState, bestValue: number, margin: number): boolean {
  if (!view.canResign) return false;
  if (!Number.isFinite(margin)) return false;
  if (!Number.isFinite(bestValue)) return false;
  return bestValue < -margin;
}

export function pimc(view: ViewState, opts: SearchOptions = {}, rand: Random = Math.random): PimcResult {
  const cfg = { ...DEFAULT_SEARCH, ...opts };
  const scores = new Float32Array(ACTION_COUNT);
  const emptyPolicy = new Float32Array(ACTION_COUNT);
  if (view.over) return { scores, policy: emptyPolicy, best: -1, worlds: 0, nodes: 0, resign: false };

  const legal = legalActionIndices(view);
  if (!legal.length) return { scores, policy: emptyPolicy, best: -1, worlds: 0, nodes: 0, resign: false };

  const plan = planRoots(view, legal, cfg.flipClasses);
  const counts = new Float32Array(ACTION_COUNT);
  // 第一段：每个动作的分数（第二段会覆写前几名的）
  const pass1 = new Float32Array(ACTION_COUNT);
  let worlds = 0;
  let totalNodes = 0;

  const alive = view.counts.red + view.counts.blue;
  const depth = cfg.depth > 0 ? cfg.depth : boostedDepth(alive, cfg.depthBoost ?? 0);
  // 一份 ctx 复用整次决策：每个根动作只把 nodes 归零。
  // （曾经把 createCtx 放在根动作循环里 —— 那是 160 × 96 次分配，白白吃掉一半时间）
  const ctx = createCtx(cfg.nodeBudget, cfg.quiescence, cfg.splitQuiescenceBudget, cfg.quiescenceBudget, {
    hiddenThreat: cfg.hiddenThreat,
    kingFullPrice: cfg.kingFullPrice,
    ownThreatFull: cfg.ownThreatFull,
  });
  // 最近的公开局面。同一个动作在 K 个世界里的"公开结果"是一样的（暗子身份不进指纹），
  // 所以第一个世界算一次就够，后 R 个世界直接扣同一份。
  const recent = new Set(view.recent);
  const repeat = new Uint8Array(ACTION_COUNT);

  /**
   * 搜一个根动作（用给定预算），返回它在该世界里对**我方**的分数。
   * 会原地 make/unmake，退出时局面恢复。
   */
  const searchRoot = (world: GameState, i: number, budget: number, firstWorld: boolean): number => {
    ctx.nodes = 0;
    ctx.qNodes = 0;
    ctx.budget = budget;
    const undo = createUndo();
    make(world, i, undo, false);
    const raw =
      depth <= 1
        ? -quiescence(world, 1, -Infinity, Infinity, ctx, 4)
        : -negamax(world, depth - 1, 1, -Infinity, Infinity, ctx);
    // 重复局面的判定只看公开信息，所以 K 个世界里答案一样 —— 只算第一个世界
    if (firstWorld && cfg.repeatPenalty > 0 && recent.has(publicKey(world))) repeat[i] = 1;
    unmake(world, undo);
    totalNodes += ctx.nodes;
    return raw - (repeat[i] ? cfg.repeatPenalty : 0);
  };

  for (let w = 0; w < cfg.worlds; w++) {
    const world = determinize(view, rand);
    const me = world.turn;

    let roots = plan.reps;
    if (Number.isFinite(cfg.rootWidth) && plan.reps.length > cfg.rootWidth) {
      roots = plan.reps
        .slice()
        .sort((x, y) => rootRank(world, y, me) - rootRank(world, x, me))
        .slice(0, cfg.rootWidth);
    }

    for (const i of roots) pass1[i] = searchRoot(world, i, cfg.nodeBudget, w === 0);

    // 第二段：把排名靠前的几个动作用大预算重算（见 deepenWidth 的注释）
    if (cfg.deepenWidth > 0 && cfg.deepenBudget > cfg.nodeBudget && roots.length > 1) {
      const top = roots
        .slice()
        .sort((x, y) => pass1[y]! - pass1[x]!)
        .slice(0, Math.min(cfg.deepenWidth, roots.length));
      for (const i of top) pass1[i] = searchRoot(world, i, cfg.deepenBudget, false);
    }

    for (const i of roots) {
      const members = plan.cover.get(i) ?? [i];
      for (const m of members) {
        scores[m]! += pass1[i]!;
        counts[m]! += 1;
      }
    }
    worlds += 1;
  }

  const usable = new Float32Array(ACTION_COUNT);
  for (let i = 0; i < ACTION_COUNT; i++) {
    if (counts[i]! > 0) {
      scores[i] = scores[i]! / counts[i]!;
      usable[i] = scores[i]!;
    } else {
      scores[i] = -Infinity;
      usable[i] = -Infinity;
    }
  }
  // 安全闸：把"看得见的白送"从候选里摘掉（见 safetyGate 注释）
  if (cfg.safetyGate && cfg.safetyGate > 0) {
    const board = gateBoard(view);
    const base = publicExposure(board, view.you);
    const ok = new Set<number>();
    for (const i of legal) {
      const a = actionFromIndex(i);
      if (!a) continue;
      // 翻棋不移动子（只是揭示），不在"走上前被吃"这一类的范围里
      if (a.t !== 'move') {
        ok.add(i);
        continue;
      }
      if (netAfter(board, view.you, a.from, a.to) <= base) ok.add(i);
    }
    if (ok.size > 0) {
      let bestSafe = -Infinity;
      for (const i of ok) bestSafe = Math.max(bestSafe, scores[i]!);
      for (const i of legal) {
        if (ok.has(i)) continue;
        if (scores[i]! < bestSafe + cfg.safetyGate) {
          scores[i] = -Infinity;
          usable[i] = -Infinity;
        }
      }
    }
  }

  const policy = maskedSoftmax(usable, maskOf(view), cfg.temperature);

  let best = -1;
  for (const i of legal) {
    if (best < 0 || scores[i]! > scores[best]!) best = i;
  }

  const resign = best >= 0 && shouldResign(view, scores[best]!, cfg.resignMargin);

  return { scores, policy, best, worlds, nodes: totalNodes, resign };
}

/** 便捷：直接要一个动作（自对弈/老师用），温度 > 0 时按策略采样 */
export function pimcAction(
  view: ViewState,
  opts: SearchOptions = {},
  rand: Random = Math.random,
  temperature = 0,
): import('./types').Action | null {
  const res = pimc(view, opts, rand);
  if (res.resign) return { t: 'resign' };
  if (res.best < 0) return null;
  if (temperature <= 0) return actionFromIndex(res.best);
  const policy = maskedSoftmax(res.scores, maskOf(view), temperature);
  let r = rand();
  for (let i = 0; i < ACTION_COUNT; i++) {
    r -= policy[i]!;
    if (r <= 0 && policy[i]! > 0) return actionFromIndex(i);
  }
  return actionFromIndex(res.best);
}

/** 随机走子（基准对手用） */
export function randomAction(view: ViewState, rand: Random = Math.random): import('./types').Action | null {
  const legal = legalActionIndices(view);
  if (!legal.length) return null;
  return actionFromIndex(legal[Math.floor(rand() * legal.length)]!);
}

export { cellOf, cloneStateFast, judgeFast, legalIndicesFast, make, unmake };
