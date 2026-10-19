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

      {/* 欢迎语：写在立绘那块空着的暗红盾牌里（y 262~390 是它最宽的一段），
          第一句说明来历，第二句告诉人两枚按钮各干什么，最后一句是授权口径。
          文案是产品要求，别自己精简 —— 尤其是"请勿用于商业目的的二次分发"这句。 */}
      <div className="welcome" data-testid="welcome">
        {/* 每段都写在一行里：JSX 会在换行处插一个空格，中文里就变成「对战，  或者」这样的双空格 */}
        <p>
          {/* prettier-ignore */}
          本游戏是已停服的 QQ 宠物内置游戏《皇家战棋》的网页复刻版，你可以点击左侧按钮与电脑对战，或者点击右侧按钮生成邀请链接，发给朋友即可对战。
        </p>
        <p className="welcome-rules">
          规则：所有棋子扣放，轮流翻棋或走一格；等级低的可吃等级高的，刺客能吃国王。
        </p>
        <p className="welcome-license">本项目免费开源、非官方同人复刻，请勿商用或二次分发。</p>
      </div>

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
