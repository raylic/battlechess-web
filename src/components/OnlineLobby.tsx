// 联机大厅：三屏共用一块画布（①中间页 ②房主邀请 ③客人加入）。
//
// 这一层**只有界面**：数据全靠 props 进来、动作全靠 props 出去，自己不发网络请求。
// 于是同一份组件既能跑在假数据上（现在），也能在接上 transport 后原样复用 ——
// 接线的活全部落在 App 里那几个 handler 上。
//
// 视觉：面板是 public/assets/wait_panel_clean.webp（320x173，PS 去掉人像的版本），
// 按钮是 button_clean.png（一张 120x86 的上下两态图，靠 background-position 切行）。

import { useEffect, useRef, useState } from 'react';

export type LobbyStep = 'menu' | 'host' | 'join';

export interface Invite {
  /** 四位房号，给人念的 */
  code: string;
  /** 完整邀请链接，真正解析用的是它 */
  link: string;
}

export interface OnlineLobbyProps {
  step: LobbyStep;
  invite: Invite | null;
  /** ③ 的错误行（null = 不显示） */
  joinError: string | null;
  onHost: () => void;
  onShowJoin: () => void;
  onJoin: (raw: string) => void;
  /** ② 取消 / ③ 返回 → 回中间页 */
  onMenu: () => void;
  /** ① 返回 → 回开始界面 */
  onExit: () => void;
}

/** 复制/粘贴被浏览器拒时的兜底文案（icon 尺寸的提示行，别抢焦点） */
const COPY_OK = '已复制到剪贴板';
const COPY_FAIL = '复制失败，请手动选中复制';

export function OnlineLobby({
  step,
  invite,
  joinError,
  onHost,
  onShowJoin,
  onJoin,
  onMenu,
  onExit,
}: OnlineLobbyProps) {
  // 提示自带“属于哪一屏”：切屏后旧提示自然不再渲染，不用在 effect 里 setState
  // （在 effect 里同步 setState 会触发级联渲染，lint 也会报）
  const [copyHint, setCopyHint] = useState<{ step: LobbyStep; text: string } | null>(null);
  const linkRef = useRef<HTMLInputElement>(null);

  // 提示自己消失：不留定时器跨屏残留（这一步是定时器，属于合法副作用）
  useEffect(() => {
    if (!copyHint) return;
    const timer = setTimeout(() => setCopyHint(null), 2400);
    return () => clearTimeout(timer);
  }, [copyHint]);

  async function copyLink(): Promise<void> {
    const text = invite?.link ?? '';
    try {
      // 非 https / 无权限时这里会抛 —— 正好落进下面的兜底
      await navigator.clipboard.writeText(text);
      setCopyHint({ step: 'host', text: COPY_OK });
    } catch {
      linkRef.current?.focus();
      linkRef.current?.select();
      setCopyHint({ step: 'host', text: COPY_FAIL });
    }
  }

  return (
    <div id="lobby" className="lobby-root" data-testid="online-lobby" data-step={step}>
      <div className="lobby-panel" />

      {step === 'menu' ? (
        <>
          <h1 className="lobby-title">联机对战</h1>
          <p className="lobby-sub">两个浏览器直接连线 · 棋局跑在房主那一侧</p>
          <button type="button" className="imgbtn b-clean b-create" onClick={onHost}>
            创建
          </button>
          <button type="button" className="imgbtn b-clean b-join" onClick={onShowJoin}>
            加入
          </button>
          <button type="button" className="lobby-back" onClick={onExit}>
            ← 返回开始界面
          </button>
        </>
      ) : null}

      {step === 'host' ? (
        <>
          <h1 className="lobby-title">房间已创建</h1>
          <p className="lobby-sub">房间号 {invite?.code ?? '----'} · 把链接发给朋友</p>
          {invite?.link ? (
            <input
              ref={linkRef}
              className="lobby-link"
              data-testid="invite-link"
              aria-label="邀请链接"
              readOnly
              value={invite.link}
              onFocus={(e) => e.currentTarget.select()}
            />
          ) : (
            // 房间还没起来（peer 正在开）：先说清楚在干嘛，别摆一个空输入框
            <p className="lobby-hint" data-testid="invite-pending">
              正在创建房间…
            </p>
          )}
          {copyHint?.step === step ? (
            <p className="lobby-hint" data-testid="copy-hint" role="status">
              {copyHint.text}
            </p>
          ) : null}
          <button
            type="button"
            className="imgbtn b-clean b-copy"
            data-testid="copy-link"
            disabled={!invite?.link}
            onClick={() => void copyLink()}
          >
            复制
          </button>
          <button type="button" className="imgbtn b-clean b-cancel" onClick={onMenu}>
            取消
          </button>
        </>
      ) : null}

      {step === 'join' ? (
        <JoinRoom joinError={joinError} onJoin={onJoin} onMenu={onMenu} />
      ) : null}
    </div>
  );
}

interface JoinRoomProps {
  joinError: string | null;
  onJoin: (raw: string) => void;
  onMenu: () => void;
}

/** ③ 客人加入：输入框 + 粘贴 + 错误行。输入值是这一屏自己的局部状态 */
function JoinRoom({ joinError, onJoin, onMenu }: JoinRoomProps) {
  const [code, setCode] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  async function paste(): Promise<void> {
    try {
      const text = await navigator.clipboard.readText();
      setCode(text.trim());
    } catch {
      // 读不到剪贴板（Safari / 非 https / 用户拒绝）就只是聚焦输入框，别弹错
      inputRef.current?.focus();
    }
  }

  return (
    <>
      <h1 className="lobby-title">加入房间</h1>
      <label className="lobby-label" htmlFor="room-code">
        房间号 / 邀请链接
      </label>
      <div className="lobby-field">
        <input
          id="room-code"
          ref={inputRef}
          data-testid="room-code"
          value={code}
          inputMode="numeric"
          autoComplete="off"
          spellCheck={false}
          placeholder="4821"
          onChange={(e) => setCode(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') onJoin(code);
          }}
        />
        <button type="button" className="lobby-paste" data-testid="paste-link" onClick={() => void paste()}>
          粘贴
        </button>
      </div>
      <p className="lobby-error" data-testid="join-error" role={joinError ? 'alert' : undefined}>
        {joinError ?? ''}
      </p>
      <button
        type="button"
        className="imgbtn b-clean b-go"
        data-testid="do-join"
        onClick={() => onJoin(code)}
      >
        加入
      </button>
      <button type="button" className="lobby-back" onClick={onMenu}>
        ← 返回
      </button>
    </>
  );
}
