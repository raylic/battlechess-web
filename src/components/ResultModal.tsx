import { resultPanelStyle, resultWhy } from '../game/hudText';
import type { ViewState } from '../core/types';

export interface ResultModalProps {
  view: ViewState;
  onOk: () => void;
  onRestart: () => void;
}

export function ResultModal({ view, onOk, onRestart }: ResultModalProps) {
  if (!view.over) return null;

  return (
    <div id="modal" data-testid="result-modal">
      <div className="panel" data-testid="result-panel" style={resultPanelStyle(view.winner)} />
      <button type="button" className="imgbtn b-ok" id="ok" onClick={onOk} />
      <div className="why" data-testid="result-why">
        {resultWhy(view)}
      </div>
      <div className="again">
        <button type="button" onClick={onRestart}>
          再来一局（换一盘）
        </button>
      </div>
    </div>
  );
}
