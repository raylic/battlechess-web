// 把整个 1000x650 的舞台等比缩放到视口 —— 保持与原版设计稿坐标一致。
// 几何参数以 JS 为单一事实来源，写进 CSS 变量。

import { useEffect } from 'react';

import { CELL, PIECE_SCALE } from './geometry';

export const DESIGN_WIDTH = 1000;
export const DESIGN_HEIGHT = 650;

export function useFitScale(): void {
  useEffect(() => {
    const style = document.documentElement.style;
    style.setProperty('--cell', `${CELL}px`);
    style.setProperty('--piece-scale', String(PIECE_SCALE));

    const fit = () => {
      const scale = Math.min(window.innerWidth / DESIGN_WIDTH, window.innerHeight / DESIGN_HEIGHT);
      style.setProperty('--fit', String(scale));
    };
    fit();
    window.addEventListener('resize', fit);
    return () => window.removeEventListener('resize', fit);
  }, []);
}
