import type { Action, GameState, Side, ViewState } from '../core/types';
import type { Mode } from '../game/hudText';
import { Board } from './Board';
import { Hud } from './Hud';
import { ResultModal } from './ResultModal';
import { Toast } from './Toast';
import { TruthPanel } from './TruthPanel';

export interface GameScreenProps {
  view: ViewState | null;
  mode: Mode;
  side: Side | null;
  toast: string | null;
  truth: GameState | null;
  onAction: (action: Action) => void;
  onResign: () => void;
  onOk: () => void;
  onRestart: () => void;
  onToastDone: () => void;
}

export function GameScreen({
  view,
  mode,
  side,
  toast,
  truth,
  onAction,
  onResign,
  onOk,
  onRestart,
  onToastDone,
}: GameScreenProps) {
  return (
    <div id="game">
      <img id="bg" src={`${import.meta.env.BASE_URL}assets/bg.jpg`} alt="" />
      {/* 首帧还没收到初始 state（transport 是异步下发的）*/}
      {view ? (
        <>
          <Board view={view} onAction={onAction} />
          <Hud view={view} mode={mode} side={side} onResign={onResign} />
          <ResultModal view={view} onOk={onOk} onRestart={onRestart} />
        </>
      ) : null}
      <Toast message={toast} onDone={onToastDone} />
      <TruthPanel state={truth} />
    </div>
  );
}
