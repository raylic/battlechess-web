import { BOARD_SIZE, LEVEL_NAMES } from '../core/pieces';
import type { GameState } from '../core/types';

/** ?debug=1 时的"真面目"面板。只有单机模式拿得到真相（双窗口的真相在 SharedWorker 里） */
export function TruthPanel({ state }: { state: GameState | null }) {
  if (!state) return null;

  const lines = ['真面目（?debug=1）  [x]=已翻开  小写=未翻开'];
  for (let row = 0; row < BOARD_SIZE; row++) {
    const cells: string[] = [];
    for (let col = 0; col < BOARD_SIZE; col++) {
      const p = state.grid[row]![col];
      if (!p) {
        cells.push('  ·  ');
        continue;
      }
      const tag = `${p.side === 'red' ? 'R' : 'B'}${LEVEL_NAMES[p.level]![0]}`;
      cells.push(p.revealed ? `[${tag}]` : ` ${tag} `);
    }
    lines.push(cells.join(''));
  }
  lines.push(`turn=${state.turn} step=${state.step} noEat=${state.noEat} winner=${state.winner}`);

  return (
    <div id="truth" data-testid="truth">
      {lines.join('\n')}
    </div>
  );
}
