import { useEffect, useState } from 'react';

import { BOARD_SIZE } from '../core/pieces';
import type { Action, Pos, ViewState } from '../core/types';
import { cellFlags, resolveClick } from '../game/boardInteraction';
import { useEatenGhosts } from '../game/useEatenGhosts';
import { Piece } from './Piece';

export interface BoardProps {
  view: ViewState;
  onAction: (action: Action) => void;
}

export function Board({ view, onAction }: BoardProps) {
  const [selected, setSelected] = useState<Pos | null>(null);
  const ghosts = useEatenGhosts(view);

  // 选中态是纯 UI 局部状态，不该跨对局状态存活（每次收到新 state 就清掉）
  useEffect(() => {
    setSelected(null);
  }, [view]);

  const handleClick = (at: Pos) => {
    const result = resolveClick(view, selected, at);
    setSelected(result.selected);
    if (result.action) onAction(result.action);
  };

  const cells = [];
  for (let row = 0; row < BOARD_SIZE; row++) {
    for (let col = 0; col < BOARD_SIZE; col++) {
      const at: Pos = [row, col];
      const flags = cellFlags(view, selected, at);
      const className = [
        'cell',
        `parity-${(row + col) % 2}`,
        flags.isLast && 'is-last',
        flags.isSelected && 'is-selected',
        flags.isTarget && 'is-target',
        flags.isHoverable && 'is-hoverable',
      ]
        .filter(Boolean)
        .join(' ');
      cells.push(
        <div
          key={`${row}-${col}`}
          className={className}
          data-cell={`${row},${col}`}
          data-testid={`cell-${row}-${col}`}
          onClick={() => handleClick(at)}
        />,
      );
    }
  }

  const myTurn = !view.over && view.you === view.turn;

  return (
    <div id="stage">
      <div id="board" data-testid="board">
        {/* 棋盘外观（紫白格 + 金边）是**一张贴图**，它比 6×6 盒子大一圈（金边画在盒子外）。
            必须排在格子之前：格子是 position:relative，同层按 DOM 顺序画，
            贴图在前才不会被选中/可走那几个覆盖色挡住。 */}
        <div className="board-art" aria-hidden="true" />
        {cells}
        <div id="pieces">
          {view.cells
            .filter((cell) => cell.id !== null)
            .map((cell) => (
              <Piece
                key={cell.id}
                id={cell.id!}
                at={cell.at}
                side={cell.side}
                level={cell.level}
                revealed={cell.revealed}
                dire={cell.dire}
                active={myTurn && cell.revealed && cell.side === view.turn}
              />
            ))}
          {ghosts.map((ghost) => (
            <Piece key={`ghost-${ghost.id}`} {...ghost} revealed ghost />
          ))}
        </div>
      </div>
    </div>
  );
}
