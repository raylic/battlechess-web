import type { Mode } from '../game/hudText';

export interface StartScreenProps {
  notice: string | null;
  onChoose: (mode: Mode) => void;
}

export function StartScreen({ notice, onChoose }: StartScreenProps) {
  return (
    <div id="start" data-testid="start-screen">
      <img className="art" src={`${import.meta.env.BASE_URL}assets/begin.webp`} alt="皇家战棋" />

      <button
        type="button"
        className="imgbtn b-mode"
        data-col="0"
        data-testid="mode-ai"
        onClick={() => onChoose('ai')}
      >
        <span className="sr-only">单人 · 对战电脑</span>
      </button>
      <button
        type="button"
        className="imgbtn b-mode"
        data-col="1"
        data-testid="mode-dual"
        onClick={() => onChoose('dual')}
      >
        <span className="sr-only">双人 · 两个视角</span>
      </button>

      {notice ? (
        <div className="hint" id="start-notice" data-testid="start-notice" style={{ left: 330, top: 76, width: 340 }}>
          {notice}
        </div>
      ) : null}
    </div>
  );
}
