// 被吃掉的棋子先淡出再消失。
// 原生版用 boardView 内部一个 Map + setTimeout 做的；React 里棋子消失会立刻卸载，
// 所以要显式记住"刚刚消失的那些"，多渲染一帧幽灵节点。

import { useEffect, useRef, useState } from 'react';

import type { Pos, ViewState } from '../core/types';

export interface Ghost {
  id: string;
  at: Pos;
  side: 'red' | 'blue' | null;
  level: 0 | 1 | 2 | 3 | 4 | 5 | null;
  dire: 0 | 1;
}

export const GHOST_MS = 320;

export function useEatenGhosts(view: ViewState | null): Ghost[] {
  const known = useRef(new Map<string, Ghost>());
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);
  const [ghosts, setGhosts] = useState<Ghost[]>([]);

  // 卸载时清掉所有待触发定时器（每次 view 变化不清，否则 320ms 内连吃两子会有一子永不消失）
  useEffect(
    () => () => {
      for (const t of timers.current) clearTimeout(t);
      timers.current = [];
    },
    [],
  );

  useEffect(() => {
    if (!view) {
      known.current = new Map();
      setGhosts([]);
      return;
    }

    const current = new Map<string, Ghost>();
    for (const c of view.cells) {
      if (!c.id) continue;
      current.set(c.id, { id: c.id, at: c.at, side: c.side, level: c.level, dire: c.dire });
    }

    const gone: Ghost[] = [];
    for (const [id, ghost] of known.current) if (!current.has(id)) gone.push(ghost);
    known.current = current;

    if (!gone.length) return;
    setGhosts((list) => [...list, ...gone]);
    const ids = new Set(gone.map((g) => g.id));
    const timer = setTimeout(() => {
      setGhosts((list) => list.filter((g) => !ids.has(g.id)));
    }, GHOST_MS);
    timers.current.push(timer);
  }, [view]);

  return ghosts;
}
