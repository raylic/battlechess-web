import { resultArt } from '../game/hudText';
import type { ViewState } from '../core/types';

export interface ResultModalProps {
  view: ViewState;
  onOk: () => void;
  /** 导出全部对局记录（复盘用） */
  onExport?: () => void;
  recordCount?: number;
}

export function ResultModal({ view, onOk, onExport, recordCount = 0 }: ResultModalProps) {
  if (!view.over) return null;

  return (
    <div id="modal" data-testid="result-modal">
      <div className="panel" data-testid="result-panel">
        <img
          className="panel-top"
          src={`${import.meta.env.BASE_URL}assets/${resultArt(view.winner)}`}
          alt=""
        />
      </div>
      <button type="button" className="imgbtn b-ok" id="ok" onClick={onOk} />
      {onExport ? (
        <div className="logrow" data-testid="log-row">
          <button type="button" data-testid="export-log" onClick={onExport}>
            导出对局记录（{recordCount}）
          </button>
        </div>
      ) : null}
    </div>
  );
}
