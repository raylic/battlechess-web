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
  lastStep: Pos | null;
  winner: Side | 'draw' | null;
  reason: Reason | null;
  over: boolean;
  policy: Policy;
  canResign: boolean;
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
