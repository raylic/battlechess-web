import type { Mode } from '../game/hudText';

export interface StartScreenProps {
  seed: number;
  notice: string | null;
  onChoose: (mode: Mode) => void;
}

export function StartScreen({ seed, notice, onChoose }: StartScreenProps) {
  return (
    <div id="start" data-testid="start-screen">
      <img className="art" src={`${import.meta.env.BASE_URL}assets/begin.png`} alt="皇家战棋" />

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

      <div className="hint" style={{ left: 272, top: 558, width: 200 }}>
        单人 · 对战电脑
        <br />
        <span style={{ opacity: 0.75 }}>（原版「本地对战」）</span>
      </div>
      <div className="hint" style={{ left: 528, top: 558, width: 200 }}>
        双人 · 两个视角
        <br />
        <span style={{ opacity: 0.75 }}>（原版「联网对战」，本机双窗口）</span>
      </div>

      <div className="hint" style={{ left: 330, top: 614, width: 340 }} data-testid="seed-hint">
        棋盘种子 #{seed} · 核心玩法复刻（无服务端）
      </div>

      {notice ? (
        <div className="hint" id="start-notice" data-testid="start-notice" style={{ left: 330, top: 76, width: 340 }}>
          {notice}
        </div>
      ) : null}
    </div>
  );
}
