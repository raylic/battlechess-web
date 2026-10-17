import { resultPanelStyle, resultWhy } from '../game/hudText';
import type { ViewState } from '../core/types';

export interface ResultModalProps {
  view: ViewState;
  onOk: () => void;
  onRestart: () => void;
  /** 这局是否已被标为"有坏棋"（对局记录） */
  flagged?: boolean;
  onFlag?: () => void;
  /** 导出全部对局记录（复盘用） */
  onExport?: () => void;
  recordCount?: number;
}

export function ResultModal({ view, onOk, onRestart, flagged = false, onFlag, onExport, recordCount = 0 }: ResultModalProps) {
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
      <div className="logrow" data-testid="log-row">
        <button type="button" data-testid="flag-game" onClick={onFlag}>
          {flagged ? '⭐ 已标记这局' : '⭐ 标记这局有问题'}
        </button>
        <button type="button" data-testid="export-log" onClick={onExport}>
          导出对局记录（{recordCount}）
        </button>
      </div>
    </div>
  );
}
