// 客人点开邀请链接后、房主那边的 state 还没到之前的那一屏。
//
// 没有这一屏会怎样：`GameScreen` 里 `view ? … : null`，而客人的 view 在连上之前
// 一直是 null —— 于是整块只剩一张背景图，连接中/连不上都毫无反馈（真实踩到过）。
//
// 故意**不叠压暗层**：背景必须是"棋局那一屏"的 field-bg.webp，连上之后切到 GameScreen 才不跳。
// 视觉零件（面板/标题/按钮）和联机大厅共用同一批类名，改一处两边一起变。
//
// 也故意**不渲染 Toast**：失败原因要留在屏幕上让人看清，而 Toast 几秒就自己消失了。

export interface ConnectingScreenProps {
  /** 四位房号（从邀请链接里解析出来的，纯展示用） */
  code: string | null;
  /** 连接失败的原因（null = 还在连） */
  error: string | null;
  onCancel: () => void;
}

export function ConnectingScreen({ code, error, onCancel }: ConnectingScreenProps) {
  return (
    <div id="game" data-testid="connecting-screen">
      <img id="bg" src={`${import.meta.env.BASE_URL}assets/field-bg.webp`} alt="" />
      <div className="lobby-root" data-step="connecting">
        <div className="lobby-panel" />
        <h1 className="lobby-title">{error ? '连不上这个房间' : '正在连接'}</h1>
        <p className="lobby-sub" data-testid="connecting-detail">
          {error ?? `房间 ${code ?? '----'} · 等待房主回应…`}
        </p>
        <button type="button" className="imgbtn b-clean b-go" onClick={onCancel}>
          返回
        </button>
      </div>
    </div>
  );
}
