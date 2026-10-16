// 状态机：唯一能改状态的地方（纯函数：输入 state + action，输出新 state）
//
// action 的类型是 unknown —— 它来自 transport 边界（SharedWorker / 将来的 WebSocket），
// 属于**不可信输入**。所以这里显式校验形状，畸形输入一律返回 { rejected } 而不是抛异常。

import { createGrid } from './board';
import { BOARD_SIZE, PIECES_PER_SIDE, other } from './pieces';
import { judge, MIN_GIVEUP } from './judge';
import { legalActions, samePos } from './rules';
import type { ApplyResult, GameEvent, GameState, Piece, Pos, Side } from './types';

export function createState(seed: number, opts: { firstTurn?: Side } = {}): GameState {
  return {
    seed,
    grid: createGrid(seed),
    turn: opts.firstTurn ?? 'red',
    step: 0,
    noEat: 0,
    counts: { red: PIECES_PER_SIDE, blue: PIECES_PER_SIDE },
    lastStep: null,
    winner: null,
    reason: null,
  };
}

/** 深拷贝一份状态（36 个格子，成本可以忽略） */
export function cloneState(s: GameState): GameState {
  return {
    seed: s.seed,
    grid: s.grid.map((col) => col.map((p) => (p ? { ...p } : null))),
    turn: s.turn,
    step: s.step,
    noEat: s.noEat,
    counts: { ...s.counts },
    lastStep: s.lastStep ? ([...s.lastStep] as Pos) : null,
    winner: s.winner,
    reason: s.reason,
  };
}

export const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null;

/** 把不可信输入转成 Pos；形状不对就返回 null（不抛异常） */
export function toPos(v: unknown): Pos | null {
  if (!Array.isArray(v) || v.length !== 2) return null;
  const [a, b] = v;
  if (typeof a !== 'number' || typeof b !== 'number') return null;
  if (!Number.isInteger(a) || !Number.isInteger(b)) return null;
  return [a, b];
}

function finish(state: GameState, events: GameEvent[]): ApplyResult {
  judge(state);
  if (state.winner) events.push({ kind: 'end', winner: state.winner, reason: state.reason! });
  return { state, events };
}

export function applyAction(state: GameState, action: unknown): ApplyResult {
  if (state.winner) return { rejected: '对局已经结束了' };
  if (!isRecord(action)) return { rejected: '非法操作' };

  const acts = legalActions(state);

  if (action.t === 'flip') {
    const at = toPos(action.at);
    if (!at || !acts.flips.some((p) => samePos(p, at))) return { rejected: '这个位置翻不了' };
    const next = cloneState(state);
    const piece = next.grid[at[0]]![at[1]]!;
    piece.revealed = true;
    next.noEat = 0; // 翻棋也算"有进展"，重置和棋计数
    next.step += 1;
    next.lastStep = at;
    next.turn = other(next.turn);
    return finish(next, [{ kind: 'flip', at, id: piece.id, side: piece.side, level: piece.level }]);
  }

  if (action.t === 'move') {
    const from = toPos(action.from);
    const to = toPos(action.to);
    if (!from || !to) return { rejected: '非法操作' };
    const ok = acts.moves.some((m) => samePos(m.from, from) && samePos(m.to, to));
    if (!ok) return { rejected: '这步棋不合法' };

    const next = cloneState(state);
    const piece = next.grid[from[0]]![from[1]] as Piece;
    const target = next.grid[to[0]]![to[1]];
    const events: GameEvent[] = [{ kind: 'move', from, to, id: piece.id }];

    if (target) {
      next.counts[target.side] -= 1;
      next.noEat = 0;
      events.push({ kind: 'eat', at: to, id: target.id, side: target.side, level: target.level });
    } else {
      next.noEat += 1;
    }

    // 朝向：原版 Chess.move() 里按水平位移决定（d = col 差）
    const dc = to[1] - from[1];
    if (dc !== 0) piece.dire = dc < 0 ? 0 : 1;

    next.grid[from[0]]![from[1]] = null;
    next.grid[to[0]]![to[1]] = piece;
    next.step += 1;
    next.lastStep = to;
    next.turn = other(next.turn);
    return finish(next, events);
  }

  if (action.t === 'resign') {
    if (state.step < MIN_GIVEUP) return { rejected: `走过 ${MIN_GIVEUP} 步后才能认输` };
    const next = cloneState(state);
    next.winner = other(next.turn);
    next.reason = 'resign';
    return { state: next, events: [{ kind: 'end', winner: next.winner, reason: 'resign' }] };
  }

  return { rejected: '未知操作' };
}

export { BOARD_SIZE };
