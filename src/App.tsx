import { useEffect, useLayoutEffect, useRef, useState } from 'react';

import type { Action } from './core/types';
import { GameScreen } from './components/GameScreen';
import { StartScreen } from './components/StartScreen';
import type { Mode } from './game/hudText';
import { randomSeed } from './core/rng';
import { useAiMove, useAiView, useNet, readAiKind, type AiKind } from './game/useAi';
import { useFitScale } from './game/useFitScale';
import { useGame } from './game/useGame';
import { useSession } from './game/useSession';
import {
  appendRecord,
  downloadRecords,
  encodeActions,
  loadRecords,
  setFlagged,
  type GameRecord,
} from './game/gameLog';
import { workerSupported } from './transport/worker';

function readParams() {
  const p = new URLSearchParams(window.location.search);
  const rawMode = p.get('mode');
  const rawSide = p.get('side');
  const rawSeed = Number(p.get('seed'));
  return {
    mode: (['ai', 'hotseat', 'dual'] as const).find((m) => m === rawMode) ?? null,
    side: (['red', 'blue'] as const).find((s) => s === rawSide) ?? null,
    seed: Number.isFinite(rawSeed) && rawSeed > 0 ? rawSeed : randomSeed(),
    debug: p.get('debug') === '1',
    ai: readAiKind(window.location.search),
  };
}

const params = readParams();

export default function App() {
  useFitScale();

  const [notice, setNotice] = useState<string | null>(null);
  const { session, seed, start, back, restart } = useSession(params.seed, { debug: params.debug });
  const booted = useRef(false);

  // ?mode=... 直接开局。用 layout effect 避免开始界面闪一帧；
  // booted 守卫是为了 StrictMode 下（dev）不重复建会话。
  useLayoutEffect(() => {
    if (booted.current) return;
    booted.current = true;
    if (params.mode) start(params.mode, params.side);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const human = useGame(session?.client ?? null);
  const aiView = useAiView(session?.aiClient ?? null);
  // 只有选中网络档才去拉权重；没拉好之前 think() 会自动退回搜索
  const aiKind: AiKind = params.ai;
  const net = useNet(aiKind === 'net');

  // ── 对局记录 ──────────────────────────────────────────────
  // 只记「种子 + 动作序列」：整盘棋是确定性的，拿这两样能完整重放（含每步真相）。
  const actions = useRef<Action[]>([]);
  const archived = useRef(false);
  const [records, setRecords] = useState<GameRecord[]>(() => loadRecords());
  const [flaggedTs, setFlaggedTs] = useState<number | null>(null);

  // 用 seed（useSession 里"当前棋局"的那个），不是 session.seed —— 后者在"再来一局"之后是旧的
  useAiMove(session?.aiClient ?? null, aiView, seed, aiKind, net, (action) => {
    actions.current.push(action);
  });

  const view = human.view;
  useEffect(() => {
    if (!view) return;
    // 新的一局（step 归零）：清空缓冲区，允许再次落档
    if (!view.over) {
      if (view.step === 0) {
        actions.current = [];
        archived.current = false;
        setFlaggedTs(null);
      }
      return;
    }
    if (archived.current || !view.winner) return;
    archived.current = true;
    const record: GameRecord = {
      ts: Date.now(),
      seed,
      mode: session?.mode ?? 'ai',
      ai: aiKind,
      you: session?.side ?? null,
      winner: view.winner,
      reason: view.reason ?? 'noEat',
      steps: view.step,
      actions: encodeActions(actions.current),
    };
    setRecords(appendRecord(record));
    setFlaggedTs(record.ts);
    // 只依赖 view：session 在同一局里不会变，放进依赖反而会重复落档
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view]);

  function sendAction(action: Action): void {
    actions.current.push(action);
    human.send(action);
  }

  function toggleFlag(): void {
    if (flaggedTs === null) return;
    const target = records.find((r) => r.ts === flaggedTs);
    const next = setFlagged(flaggedTs, !target?.flagged);
    setRecords(next);
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

  return (
    <div id="app">
      {session ? (
        <GameScreen
          view={human.view}
          mode={session.mode}
          side={session.side}
          toast={human.toast}
          // 真相面板只在单机 + ?debug=1 时有；每次视图更新都会重渲染，所以读的是最新快照
          truth={params.debug ? (session.authority?.truth() ?? null) : null}
          onAction={sendAction}
          onResign={() => sendAction({ t: 'resign' })}
          onOk={back}
          onRestart={restart}
          onToastDone={human.dismissToast}
          flagged={records.find((r) => r.ts === flaggedTs)?.flagged ?? false}
          onFlag={toggleFlag}
          onExport={() => downloadRecords(records)}
          recordCount={records.length}
        />
      ) : (
        <StartScreen seed={seed} notice={notice} onChoose={handleChoose} />
      )}
    </div>
  );
}
