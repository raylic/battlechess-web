import { useLayoutEffect, useRef, useState } from 'react';

import type { Action } from './core/types';
import { GameScreen } from './components/GameScreen';
import { StartScreen } from './components/StartScreen';
import type { Mode } from './game/hudText';
import { randomSeed } from './core/rng';
import { useAiMove, useAiView } from './game/useAi';
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
    mode: (['ai', 'hotseat', 'dual'] as const).find((m) => m === rawMode) ?? null,
    side: (['red', 'blue'] as const).find((s) => s === rawSide) ?? null,
    seed: Number.isFinite(rawSeed) && rawSeed > 0 ? rawSeed : randomSeed(),
    debug: p.get('debug') === '1',
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
  useAiMove(session?.aiClient ?? null, aiView, session?.seed ?? seed);

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
          onAction={(action: Action) => human.send(action)}
          onResign={() => human.send({ t: 'resign' })}
          onOk={back}
          onRestart={restart}
          onToastDone={human.dismissToast}
        />
      ) : (
        <StartScreen seed={seed} notice={notice} onChoose={handleChoose} />
      )}
    </div>
  );
}
