/**
 * 公共类型。
 * 坐标约定：Pos = [row, col]，row 0 = 棋盘最远端（画面上方），col 0 = 最左列。
 */

export type Side = 'red' | 'blue';
export type Level = 0 | 1 | 2 | 3 | 4 | 5;
export type Pos = [number, number];
/** 朝向：0 = 原图，1 = 水平镜像（原版 Chess.dire，按最后一步的水平方向决定） */
export type Dire = 0 | 1;

export type Reason = 'wipe' | 'lastStand' | 'noEat' | 'resign' | 'stalemate';

/** 一个棋子。位置不保存在棋子里 —— 位置 = 它在 grid 中的下标（单一事实来源） */
export interface Piece {
  /** 稳定 id：跨视角一致，前端拿它做 key，位移/翻面动画才有的放矢。洗牌产生，不携带身份信息 */
  id: string;
  side: Side;
  level: Level;
  revealed: boolean;
  dire: Dire;
}

/** 对局真相。只有 Authority 持有，任何视角都拿不到 */
export interface GameState {
  seed: number;
  grid: (Piece | null)[][];
  turn: Side;
  step: number;
  noEat: number;
  counts: Record<Side, number>;
  lastStep: Pos | null;
  winner: Side | 'draw' | null;
  reason: Reason | null;
  /**
   * 每一步之后的**公开局面指纹**（含初始局面），见 reduce.publicKey。
   * 双盲之下这是双方共享的公开知识，AI 用它认出"我是不是在来回走"。
   */
  history: string[];
}

export type Action =
  | { t: 'flip'; at: Pos }
  | { t: 'move'; from: Pos; to: Pos }
  | { t: 'resign' };

export type GameEvent =
  | { kind: 'flip'; at: Pos; id: string; side: Side; level: Level }
  | { kind: 'move'; from: Pos; to: Pos; id: string }
  | { kind: 'eat'; at: Pos; id: string; side: Side; level: Level }
  | { kind: 'end'; winner: Side | 'draw'; reason: Reason };

export interface LegalMoves {
  flips: Pos[];
  moves: { from: Pos; to: Pos }[];
}

/** 一个格子在下发给某视角时的样子。未翻开的棋子身份为 null（双盲口径） */
export interface ViewCell {
  id: string | null;
  at: Pos;
  revealed: boolean;
  side: Side | null;
  level: Level | null;
  dire: Dire;
}

export interface ViewState {
  you: Side;
  turn: Side;
  step: number;
  noEat: number;
  counts: Record<Side, number>;
  /**
   * 各方各等级**已经被吃掉**的棋子数（公开知识：每个被吃的子在被吃之前都是翻开的，
   * 双方都看见了；这里只是把它显式化，免得投影层之外的代码又要自己重算一遍）。
   * 有了它，"还没翻开的棋子各等级还剩几个"就是精确值，而不是估算。
   */
  fallen: Record<Side, number[]>;
  lastStep: Pos | null;
  winner: Side | 'draw' | null;
  reason: Reason | null;
  over: boolean;
  policy: Policy;
  canResign: boolean;
  /** 最近若干步的公开局面指纹（最后一个是当前局面）。AI 的"避免循环"就靠它 */
  recent: string[];
  cells: ViewCell[];
  /** 合法着法由权威算好下发，前端不重复实现规则 */
  legal: LegalMoves;
}

export type Policy = 'double-blind' | 'own-known';

export type ClientMsg =
  | Action
  | { t: 'restart'; seed?: number }
  | { t: 'join'; seed: number; side: Side | null };

export type ServerMsg = { t: 'state'; state: ViewState } | { t: 'reject'; reason: string };

export type ApplyResult = { state: GameState; events: GameEvent[] } | { rejected: string };
export type DispatchResult = { ok: true; events?: GameEvent[] } | { rejected: string };
