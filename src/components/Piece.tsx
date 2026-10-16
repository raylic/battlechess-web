import type { CSSProperties } from 'react';

import { piecePixel } from '../game/geometry';
import type { Dire, Level, Pos, Side } from '../core/types';

export interface PieceProps {
  id: string;
  at: Pos;
  side: Side | null;
  level: Level | null;
  revealed: boolean;
  dire: Dire;
  /** 轮到自己时给己方已翻开的子加一点高亮 */
  active?: boolean;
  /** 刚被吃掉的棋子：淡出中 */
  ghost?: boolean;
}

export function Piece({ id, at, dire, revealed, side, level, active, ghost }: PieceProps) {
  const { px, py } = piecePixel(at[0], at[1]);

  const style: CSSProperties & Record<string, string> = { '--px': px, '--py': py };
  if (revealed && level !== null) {
    // 精灵图是 6 列(等级) x 2 行(上红下蓝)
    style['--lv'] = String(level);
    style['--side'] = side === 'blue' ? '1' : '0';
  }

  const className = [
    'piece',
    revealed && 'is-revealed',
    dire === 1 && 'is-dir-1',
    active && 'is-active',
    ghost && 'is-eaten',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <div className={className} style={style} data-piece-id={id} data-at={`${at[0]},${at[1]}`}>
      <div className="card">
        <div className="face back" />
        <div className="face front" />
      </div>
    </div>
  );
}
