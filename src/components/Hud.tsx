import { countText, bannerText, footText, playerNames, resignDisabled, type Mode } from '../game/hudText';
import type { Side, ViewState } from '../core/types';

export interface HudProps {
  view: ViewState;
  mode: Mode;
  side: Side | null;
  onResign: () => void;
}

export function Hud({ view, mode, side, onResign }: HudProps) {
  const names = playerNames(mode);
  const active = (which: Side) => !view.over && view.turn === which;

  return (
    <>
      <div id="heads">
        {(['red', 'blue'] as const).map((which) => (
          <div key={which} className={`head${active(which) ? ' is-active' : ''}`} id={`head-${which}`}>
            <img src={`${import.meta.env.BASE_URL}assets/head_${which}.webp`} alt="" />
            <div className="line title">{which === 'red' ? '红方' : '蓝方'}</div>
            <div className="line name">{names[which]}</div>
            <div className="line count">{countText(view, which)}</div>
          </div>
        ))}
      </div>

      <div id="panels">
        {(['red', 'blue'] as const).map((which) => (
          <div className="panel" id={`panel-${which}`} key={which}>
            <span className="plate" aria-hidden="true" />
            <div className="num" data-testid={`panel-count-${which}`}>
              {view.counts[which]}
            </div>
            <div className="cap">{which === 'red' ? '红方剩余' : '蓝方剩余'}</div>
          </div>
        ))}
      </div>

      <div id="banner" data-testid="banner">
        {bannerText(view, mode)}
      </div>

      <div id="controls">
        <button
          type="button"
          className="imgbtn b-giveup"
          id="giveup"
          title="认输"
          disabled={resignDisabled(view, side)}
          onClick={onResign}
        />
        <div className="hint" id="foot">
          {footText(view)}
        </div>
      </div>
    </>
  );
}
