import { resultArt } from '../game/hudText';
import type { ViewState } from '../core/types';

export interface ResultModalProps {
  view: ViewState;
  onOk: () => void;
}

/**
 * 终局弹窗 = **两张图上下拼接**：`wait_top_<结果>.webp`（320x122，王冠+红字）
 * 压在 `wait_panel.webp`（320x173，共用底板）上，合成 320x295。
 *
 * ⚠️ 面板的 class 是 `result-panel` 而不是 `panel`：`panel` 是 HUD 里"剩余子数"
 * 那块板子（蓝边 + 渐变 + 圆角），借过来会在结算图底下多出一圈蓝框（真实踩过）。
 */
export function ResultModal({ view, onOk }: ResultModalProps) {
  if (!view.over) return null;

  return (
    <div id="modal" data-testid="result-modal">
      <div className="result-panel" data-testid="result-panel">
        <img
          className="panel-top"
          src={`${import.meta.env.BASE_URL}assets/${resultArt(view.winner)}`}
          alt=""
        />
      </div>
      <button type="button" className="imgbtn b-clean b-ok" id="ok" onClick={onOk}>
        确定
      </button>
    </div>
  );
}
