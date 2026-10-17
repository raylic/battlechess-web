// 状态机：唯一能改状态的地方（纯函数：输入 state + action，输出新 state）
//
// action 的类型是 unknown —— 它来自 transport 边界（SharedWorker / 将来的 WebSocket），
// 属于**不可信输入**。所以这里显式校验形状，畸形输入一律返回 { rejected } 而不是抛异常。

import { createGrid } from './board';
import { BOARD_SIZE, PIECES_PER_SIDE, other } from './pieces';
import { judge, MIN_GIVEUP } from './judge';
import { legalActions, samePos } from './rules';
import type { ApplyResult, GameEvent, GameState, Piece, Pos, Side } from './types';

/** 保留多少步公开局面指纹。再往前的重复已经不重要，卡住长度免得状态无限长 */
export const HISTORY_CAP = 512;

/**
 * 公开局面指纹 —— 只由"双方都能看见的东西"决定：
 *   轮到谁 + 每格是空的(.)／未翻开(x)／翻开的红蓝几级(R0/B3…)
 * 故意**不含** noEat / step 这类计数器，所以"同一颗子走回去"在几步之后会撞上同一个指纹。
 * 不含任何暗子身份 → 放进投影不泄露隐藏信息。
 */
export function publicKey(state: GameState): string {
  let out = state.turn === 'red' ? 'r' : 'b';
  for (let row = 0; row < BOARD_SIZE; row++) {
    for (let col = 0; col < BOARD_SIZE; col++) {
      const p = state.grid[row]![col];
      if (!p) out += '.';
      else if (!p.revealed) out += 'x';
      else out += `${p.side === 'red' ? 'R' : 'B'}${p.level}`;
    }
  }
  return out;
}

function pushHistory(state: GameState): void {
  state.history.push(publicKey(state));
  if (state.history.length > HISTORY_CAP) state.history.shift();
}

export function createState(seed: number, opts: { firstTurn?: Side } = {}): GameState {
  const state: GameState = {
    seed,
    grid: createGrid(seed),
    turn: opts.firstTurn ?? 'red',
    step: 0,
    noEat: 0,
    counts: { red: PIECES_PER_SIDE, blue: PIECES_PER_SIDE },
    lastStep: null,
    winner: null,
    reason: null,
    history: [],
  };
  state.history.push(publicKey(state));
  return state;
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
    history: s.history.slice(),
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
  pushHistory(state);
  judge(state);
  if (state.winner) events.push({ kind: 'end', winner: state.winner, reason: state.reason! });
  return { state, events };
}

export function applyAction(state: GameState, action: unknown, trusted = false): ApplyResult {
  if (state.winner) return { rejected: '对局已经结束了' };
  if (!isRecord(action)) return { rejected: '非法操作' };

  // trusted = true 是**内部搜索**用的快路：调用方已保证这个动作合法，少算一遍 legalActions。
  // 外部边界（transport / 测试）绝不能传 true —— 那里的 action 是不可信输入。
  const acts = trusted ? null : legalActions(state);

  if (action.t === 'flip') {
    const at = toPos(action.at);
    if (!at || (acts !== null && !acts.flips.some((p) => samePos(p, at)))) {
      return { rejected: '这个位置翻不了' };
    }
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
    if (acts !== null && !acts.moves.some((m) => samePos(m.from, from) && samePos(m.to, to))) {
      return { rejected: '这步棋不合法' };
    }

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
