import type { Action, Side, ViewState } from '../core/types';
import type { Mode } from '../game/hudText';
import { Board } from './Board';
import { Hud } from './Hud';
import { ResultModal } from './ResultModal';
import { Toast } from './Toast';

export interface GameScreenProps {
  view: ViewState | null;
  mode: Mode;
  side: Side | null;
  toast: string | null;
  onAction: (action: Action) => void;
  onResign: () => void;
  onOk: () => void;
  onToastDone: () => void;
  onExport?: () => void;
  recordCount?: number;
}

export function GameScreen({
  view,
  mode,
  side,
  toast,
  onAction,
  onResign,
  onOk,
  onToastDone,
  onExport,
  recordCount,
}: GameScreenProps) {
  return (
    <div id="game">
      <img id="bg" src={`${import.meta.env.BASE_URL}assets/bg.jpg`} alt="" />
      {/* 首帧还没收到初始 state（transport 是异步下发的）*/}
      {view ? (
        <>
          <Board view={view} onAction={onAction} />
          <Hud view={view} mode={mode} side={side} onResign={onResign} />
          <ResultModal view={view} onOk={onOk} onExport={onExport} recordCount={recordCount} />
        </>
      ) : null}
      <Toast message={toast} onDone={onToastDone} />
    </div>
  );
}
