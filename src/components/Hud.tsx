import type { CSSProperties } from 'react';

import { bannerText, footText, resignDisabled, type Mode } from '../game/hudText';
import { panelRows } from '../game/panel';
import type { Side, ViewState } from '../core/types';

export interface HudProps {
  view: ViewState;
  mode: Mode;
  side: Side | null;
  onResign: () => void;
}

export function Hud({ view, mode, side, onResign }: HudProps) {
  const active = (which: Side) => !view.over && view.turn === which;

  return (
    <>
      <div id="heads">
        {(['red', 'blue'] as const).map((which) => (
          <div key={which} className={`head${active(which) ? ' is-active' : ''}`} id={`head-${which}`}>
            <img src={`${import.meta.env.BASE_URL}assets/head_${which}.webp`} alt={which === 'red' ? '红方' : '蓝方'} />
          </div>
        ))}
      </div>

      {/* 剩余子：每方 5 行、每行按该等级默认个数摆满。三种状态（存活/没翻起/被吃）
          全部来自公开信息，格位固定，只换状态（推导在 game/panel.ts）。 */}
      <div id="panels">
        {(['red', 'blue'] as const).map((which) => (
          <div className="panel" id={`panel-${which}`} key={which} data-testid={`panel-${which}`} aria-hidden="true">
            {panelRows(view, which).map((row, ri) => (
              <div className="prow" key={ri}>
                {row.map((group, gi) => (
                  <div className="pgrp" key={gi}>
                    {group.map((slot, si) => (
                      <span
                        key={si}
                        className={`pslot is-${slot.state}`}
                        data-state={slot.state}
                        data-level={slot.level}
                        style={{ '--lv': slot.level, '--pside': which === 'blue' ? 1 : 0 } as CSSProperties}
                      />
                    ))}
                  </div>
                ))}
              </div>
            ))}
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
