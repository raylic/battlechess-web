import { useEffect, useLayoutEffect, useRef, useState } from 'react';

import type { Action, Side } from './core/types';
import { REVEAL_LAND_MS, REVEAL_TOTAL_MS } from './components/ColorReveal';
import { ColorReveal } from './components/ColorReveal';
import { ConnectingScreen } from './components/ConnectingScreen';
import { GameScreen } from './components/GameScreen';
import { OnlineLobby, type Invite, type LobbyStep } from './components/OnlineLobby';
import { StartScreen } from './components/StartScreen';
import type { Mode } from './game/hudText';
import { joinTarget, parseRoomCode, randomRoomCode } from './game/lobby';
import { identityFor, recordsRating } from './game/plate';
import { loadPoints, savePoints, settlePoints } from './game/rating';
import { otherSide } from './game/side';
import { randomSeed } from './core/rng';
import { useAiMove, useAiView, useNet, readAiKind, type AiKind } from './game/useAi';
import { useFitScale } from './game/useFitScale';
import { useGame } from './game/useGame';
import { useSession } from './game/useSession';
import { workerSupported } from './transport/worker';

function readParams() {
  const p = new URLSearchParams(window.location.search);
  const rawMode = p.get('mode');
  const rawSide = p.get('side');
  const rawSeed = Number(p.get('seed'));
  return {
    mode: (['ai', 'hotseat', 'dual', 'online'] as const).find((m) => m === rawMode) ?? null,
    side: (['red', 'blue'] as const).find((s) => s === rawSide) ?? null,
    seed: Number.isFinite(rawSeed) && rawSeed > 0 ? rawSeed : randomSeed(),
    /** 联机模式下有 host 就是客人，没有就是房主 */
    host: p.get('host')?.trim() || null,
    ai: readAiKind(window.location.search),
  };
}

const params = readParams();

export default function App() {
  useFitScale();

  const [notice, setNotice] = useState<string | null>(null);
  // 联机大厅：房号就是房间种子（四位数），链接由真正的 hostId 拼出来。
  const [screen, setScreen] = useState<'start' | LobbyStep>('start');
  const [invite, setInvite] = useState<Invite | null>(null);
  const [joinError, setJoinError] = useState<string | null>(null);
  /** 房主：房间已起、还在等客人（此时不渲染棋盘，显示 ②那屏） */
  const [waiting, setWaiting] = useState(false);
  /** 客人：正在连的房间号（连接屏上显示） */
  const [joinCode, setJoinCode] = useState<string | null>(null);
  /** 开局揭晓颜色（null = 不播）。每个会话只播一次：先转（landed=false），再飞到头像位 */
  const [reveal, setReveal] = useState<{ side: Side; landed: boolean; id: number } | null>(null);
  const revealedFor = useRef<object | null>(null);
  /** 我的积分：开局读一次 localStorage，终局结算后写回 */
  const [points, setPoints] = useState<number>(() => loadPoints());
  /** 一局只结算一次（view.over 会连续多次渲染，不挡就会 +20 好几遍） */
  const settledFor = useRef<object | null>(null);
  const { session, seed, start, back } = useSession(params.seed, { hostId: params.host ?? undefined });
  const booted = useRef(false);

  // ?mode=... 直接开局。用 layout effect 避免开始界面闪一帧；
  // booted 守卫是为了 StrictMode 下（dev）不重复建会话。
  useLayoutEffect(() => {
    if (booted.current) return;
    booted.current = true;
    // `?mode=online` 不带 host：进大厅（建房/加入由用户点），而不是直接开一个空房间
    if (params.mode === 'online' && !params.host) {
      setScreen('menu');
      return;
    }
    if (params.mode) start(params.mode, params.side);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const human = useGame(session?.client ?? null);
  /**
   * 棋盘这一帧到底在不在画面上 —— 判据必须和下面的渲染分支一模一样：
   *   房主等客人（waiting）/ 客人还在连（没有 view）→ 棋盘没出现。
   * 揭晓动画只认这个，不认"会话建立"（房主建房那一刻会话就建立了）。
   */
  const boardOnScreen = !!session && !(session.mode === 'online' && (waiting || !human.view));
  const aiView = useAiView(session?.aiClient ?? null);
  // 只有选中网络档才去拉权重；没拉好之前 think() 会自动退回搜索
  const aiKind: AiKind = params.ai;
  const net = useNet(aiKind === 'net');

  // 用 seed（useSession 里"当前棋局"的那个），不是 session.seed —— 后者在"再来一局"之后是旧的
  // 人机模式下 AI 执"我方颜色的反面"（颜色本身由种子派生，见 game/side.ts）
  const aiSide: Side = otherSide(session?.side ?? 'red');
  useAiMove(session?.aiClient ?? null, aiView, seed, aiSide, aiKind, net);

  // 棋盘真正出现的那一刻播一次揭晓动画：客人要等到连上（view 有值）才算开局，
  // 在"正在连接"那屏转牌子毫无意义。房主同理 —— 建房后还在等客人，棋盘也没出现。
  // ⚠️ 必须是 layout effect：useEffect 在 paint 之后才跑，那就会先画出一帧
  // "棋局本来该有的样子"（左右剩余子面板、头像全在），下一帧才被揭晓层盖住 ——
  // 表现就是进游戏时闪一下两边的棋子面板。layout effect 在 paint 之前改状态，
  // React 当场补一次渲染，观众一帧都看不到。
  useLayoutEffect(() => {
    const s = session;
    if (!s || !human.view || !s.side) return;
    // 房主建房之后会话就已经存在（权威在本页、view 立刻就有），但那一屏是"等客人"，
    // 棋盘根本没露脸 —— 在这儿转牌子等于在邀请界面放动画。判据跟下面渲染分支保持一致：
    // 只有棋盘真的在画面上，才允许揭晓。
    if (!boardOnScreen) return;
    if (revealedFor.current === s) return;
    // 减弱动态效果的用户直接跳过（这一层是纯装饰）
    if (typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      revealedFor.current = s;
      return;
    }
    revealedFor.current = s;
    setReveal({ side: s.side, landed: false, id: Date.now() });
  }, [session, human.view, boardOnScreen]);

  // 两段计时：转完（landed）→ 名牌飞向左侧头像位、对方的颜色同时浮现 → 整层卸载
  useEffect(() => {
    if (!reveal) return;
    const land = setTimeout(() => setReveal((r) => (r ? { ...r, landed: true } : r)), REVEAL_LAND_MS);
    const done = setTimeout(() => setReveal(null), REVEAL_TOTAL_MS);
    return () => {
      clearTimeout(land);
      clearTimeout(done);
    };
    // 只在"开始一次新的揭晓"时重挂计时器：phase 变化不该重置它们
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reveal?.id]);

  // 终局结算：人机 / 联机各记各的；热座与双窗口是同一台机器，不记分。
  // 认输也算负（winner 落在对面），和棋 0 分 —— 结果判定统一走 rating.outcomeFor。
  useEffect(() => {
    const s = session;
    const v = human.view;
    if (!s || !v || !s.side) return;
    if (settledFor.current === s) return;
    const next = settlePoints(points, { over: v.over, winner: v.winner, me: s.side, record: recordsRating(s.mode) });
    if (next === null) return;
    settledFor.current = s;
    setPoints(savePoints(next));
  }, [session, human.view, points]);

  function sendAction(action: Action): void {
    human.send(action);
  }

  function handleChoose(mode: Mode): void {
    if (mode === 'dual' && !workerSupported()) {
      setNotice('这个浏览器不支持 SharedWorker，已退回单机热座');
      start('hotseat');
      return;
    }
    setNotice(null);
    start(mode);
  }

  function openLobby(): void {
    setInvite(null);
    setJoinError(null);
    setJoinCode(null);
    setWaiting(false);
    setScreen('menu');
  }

  /** ① 创建：房号 = 房间种子，会话立刻起来（权威在本页），链接等 peer 起来再填 */
  function createRoom(): void {
    const code = randomRoomCode();
    setJoinError(null);
    setInvite({ code, link: '' });
    setWaiting(true);
    setScreen('host');

    const s = start('online', 'red', { seed: Number(code) });
    const host = s.host;
    if (!host) return;

    host.invitation
      .then((link) => setInvite({ code, link }))
      .catch((err: unknown) => {
        setJoinError(`房间没起来：${err instanceof Error ? err.message : String(err)}`);
      });
    // 客人握手成功 → 收起邀请屏，直接进棋盘（GameScreen 用同一个 session）
    host.onGuest(() => setWaiting(false));
  }

  /** ③ 加入：链接里抠 host + seed，或手输四位房号（房号就是种子） */
  function joinRoom(raw: string): void {
    const target = joinTarget(raw);
    if (!target) {
      setJoinError('请粘贴完整邀请链接，或输入 4 位房号');
      return;
    }
    setJoinError(null);
    setJoinCode(parseRoomCode(raw) ?? String(target.seed % 10_000).padStart(4, '0'));
    start('online', 'blue', { seed: target.seed, hostId: target.hostId });
    setScreen('join');
  }

  /** ② 取消 / ③ 返回：把房间拆掉，回大厅 */
  function leaveRoom(): void {
    back();
    setWaiting(false);
    setInvite(null);
    setJoinError(null);
    setJoinCode(null);
    setScreen('menu');
  }

  return (
    <div id="app">
      {session && waiting && session.mode === 'online' ? (
        // 房主：房间已经起来了，正在等客人 —— 显示 ②那屏（链接要到手才填进去）
        <OnlineLobby
          step="host"
          invite={invite}
          joinError={joinError}
          onHost={createRoom}
          onShowJoin={() => {}}
          onJoin={() => {}}
          onMenu={leaveRoom}
          onExit={leaveRoom}
        />
      ) : session && session.mode === 'online' && !human.view ? (
        // 客人刚点开邀请链接：房主的 state 还没到。没有这一屏就只剩一张背景图，
        // 连接中/连不上都毫无反馈。连接失败的原因走 human.toast（留在屏上，不弹 Toast）。
        <ConnectingScreen
          code={joinCode ?? parseRoomCode(params.host ?? '')}
          error={human.toast}
          onCancel={leaveRoom}
        />
      ) : session ? (
        <GameScreen
          view={human.view}
          mode={session.mode}
          side={session.side}
          toast={human.toast}
          onAction={sendAction}
          onResign={() => sendAction({ t: 'resign' })}
          onOk={back}
          onToastDone={human.dismissToast}
          points={session.mode === 'ai' || session.mode === 'online' ? points : null}
          reveal={reveal ? { side: reveal.side, landed: reveal.landed } : null}
        />
      ) : screen !== 'start' ? (
        <OnlineLobby
          step={screen}
          invite={invite}
          joinError={joinError}
          onHost={createRoom}
          onShowJoin={() => {
            setJoinError(null);
            setScreen('join');
          }}
          onJoin={joinRoom}
          onMenu={() => {
            setJoinError(null);
            setScreen('menu');
          }}
          onExit={() => setScreen('start')}
        />
      ) : (
        <StartScreen notice={notice} onChoose={handleChoose} onOnline={openLobby} />
      )}
      {reveal ? (
        <ColorReveal
          side={reveal.side}
          identity={session ? identityFor(session.mode, session.side, reveal.side) : '玩家'}
          points={session && recordsRating(session.mode) ? points : null}
          onSkip={() => setReveal(null)}
        />
      ) : null}
    </div>
  );
}
