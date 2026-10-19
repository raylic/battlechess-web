import type { Mode } from '../game/hudText';

export interface StartScreenProps {
  notice: string | null;
  onChoose: (mode: Mode) => void;
  /** 第二枚按钮接的是联机大厅 */
  onOnline: () => void;
}

export function StartScreen({ notice, onChoose, onOnline }: StartScreenProps) {
  return (
    <div id="start" data-testid="start-screen">
      <img className="art" src={`${import.meta.env.BASE_URL}assets/begin.webp`} alt="皇家战棋" />

      <button
        type="button"
        className="imgbtn b-clean b-start-a is-long"
        data-testid="mode-ai"
        onClick={() => onChoose('ai')}
      >
        本地对战
      </button>
      <button
        type="button"
        className="imgbtn b-clean b-start-b is-long"
        data-testid="mode-online"
        onClick={onOnline}
      >
        联网对战
      </button>

      {notice ? (
        <div className="hint" id="start-notice" data-testid="start-notice" style={{ left: 330, top: 76, width: 340 }}>
          {notice}
        </div>
      ) : null}
    </div>
  );
}
