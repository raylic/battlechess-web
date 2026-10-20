import type { CSSProperties } from 'react';

import { bannerText, footText, resignDisabled, type Mode } from '../game/hudText';
import { COMPUTER, identityFor, recordsRating } from '../game/plate';
import { panelRows } from '../game/panel';
import { gradeFor } from '../game/rating';
import type { Side, ViewState } from '../core/types';
import { NamePlate } from './NamePlate';

export interface HudProps {
  view: ViewState;
  mode: Mode;
  side: Side | null;
  onResign: () => void;
  /** 我的积分（localStorage 里的那个数）；null = 这一局不记分（热座/双窗口） */
  points?: number | null;
  /**
   * 开局揭晓阶段：
   *   转动中（landed=false）—— 名牌与剩余子面板**全藏起来**，画面里只允许有那枚转动的名牌；
   *   落位（landed=true）—— 对方的名牌浮现，我方仍藏着（名牌正飞到那个位置）。
   */
  reveal?: { side: Side; landed: boolean } | null;
}

export function Hud({ view, mode, side, onResign, points = null, reveal = null }: HudProps) {
  const active = (which: Side) => !view.over && view.turn === which;
  // 视角：我方永远在左。执蓝时红蓝左右互换；热座（side=null）保持红左蓝右。
  const leftSide: Side = side === 'blue' ? 'blue' : 'red';
  const pos = (which: Side) => (which === leftSide ? 'left' : 'right');
  // 转动阶段两枚都藏；落位阶段只藏我方那枚（名牌正飞过去），对方那枚淡入
  const headHidden = (which: Side) => (reveal ? !reveal.landed || which === reveal.side : false);
  const headIncoming = (which: Side) => !!reveal?.landed && which !== reveal.side;
  const panelsHidden = !!reveal && !reveal.landed;
  // 落位时其余部分也淡回来（不淡的话，剩余子面板会"啪"地出现）
  const panelsIncoming = !!reveal?.landed;

  /** 这一侧的名牌数据：只有"我"、且这一局记分时，才带等级/星级/积分 */
  const plateOf = (which: Side) => {
    const mine = side !== null && which === side;
    const scored = mine && recordsRating(mode) && points !== null;
    if (!scored) {
      const isComputer = mode === 'ai' && which !== side;
      return {
        identity: identityFor(mode, side, which),
        // 电脑那侧写“普通”当难度；热座/双窗口两侧都没有资料，称号留空
        title: isComputer ? COMPUTER.title : null,
        gradeIndex: null,
        points: null,
      };
    }
    const grade = gradeFor(points!);
    return { identity: identityFor(mode, side, which), title: grade.name, gradeIndex: grade.index, points };
  };

  return (
    <>
      <div id="heads">
        {(['red', 'blue'] as const).map((which) => {
          const plate = plateOf(which);
          return (
            <div
              key={which}
              className={`head${active(which) ? ' is-active' : ''}${headIncoming(which) ? ' is-incoming' : ''}`}
              id={`head-${which}`}
              data-pos={pos(which)}
              data-hidden={headHidden(which) ? '' : undefined}
            >
              <NamePlate
                side={which}
                identity={plate.identity}
                title={plate.title}
                gradeIndex={plate.gradeIndex}
                points={plate.points}
              />
            </div>
          );
        })}
      </div>

      {/* 剩余子：每方 5 行、每行按该等级默认个数摆满。三种状态（存活/没翻起/被吃）
          全部来自公开信息，格位固定，只换状态（推导在 game/panel.ts）。 */}
      <div id="panels">
        {(['red', 'blue'] as const).map((which) => (
          <div
            className={`panel${panelsIncoming ? ' is-incoming' : ''}`}
            id={`panel-${which}`}
            key={which}
            data-testid={`panel-${which}`}
            data-pos={pos(which)}
            data-hidden={panelsHidden ? '' : undefined}
            aria-hidden="true"
          >
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

      {/* 计数行：只报“已多少步未吃子 / 多少步判和”，摆在回合条下面一行。
          data-step 是给测试和 scripts/click-check.mjs 读“走没走成”的 —— 界面上不再显示总步数。 */}
      <div id="foot" data-testid="foot" data-step={view.step}>
        {footText(view)}
      </div>

      <div id="controls">
        <button
          type="button"
          className="imgbtn b-clean b-giveup"
          id="giveup"
          title="认输"
          disabled={resignDisabled(view, side)}
          onClick={onResign}
        >
          认输
        </button>
      </div>
    </>
  );
}
