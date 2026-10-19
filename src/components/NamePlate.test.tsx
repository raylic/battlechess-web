// @vitest-environment jsdom
// 名牌渲染：头像从 chess.webp 的哪一块裁、星级几颗、三行字写什么。
import { render, screen } from '@testing-library/react';
import { expect, test } from 'vitest';

import { gradeFor } from '../game/rating';
import { NamePlate } from './NamePlate';

const disc = (side: 'red' | 'blue' = 'red') => screen.getByTestId(`portrait-${side}`) as HTMLElement;
const stars = () => document.querySelectorAll('.plate-star').length;

test('底板用游戏里那张盾图，头像是 chess.webp 的裁切（不另存图）', () => {
  render(<NamePlate side="red" identity="玩家" gradeIndex={0} points={0} />);
  const art = document.querySelector('.plate-art') as HTMLImageElement;
  expect(art.src).toContain('head_red.webp');
  // 圆盘本身没有 <img>，是一块带 background-position 的 div —— 头像不占新资源
  expect(disc().querySelector('img')).toBeNull();
  expect(disc().style.backgroundImage).toContain('chess.webp');
  expect(disc().style.backgroundSize).toContain('px');
  expect(disc().style.backgroundPosition).toContain('px');
});

test('等级决定星级：刺客 1 颗 … 国王 6 颗', () => {
  const cases: [number, number][] = [
    [0, 1],
    [1, 2],
    [2, 3],
    [3, 4],
    [4, 5],
    [5, 6],
  ];
  for (const [index, count] of cases) {
    const { unmount } = render(<NamePlate side="red" identity="玩家" gradeIndex={index} points={0} />);
    expect(stars(), `等级 ${index}`).toBe(count);
    unmount();
  }
});

test('称号默认取等级名，积分原样显示', () => {
  render(<NamePlate side="red" identity="玩家" gradeIndex={4} points={820} />);
  expect(screen.getByText('将军')).toBeTruthy();
  expect(screen.getByText('820')).toBeTruthy();
  expect(screen.getByText('玩家')).toBeTruthy();
});

test('没有等级信息：不画星、不写称号（热座/双窗口的两侧就是这样）', () => {
  render(<NamePlate side="blue" identity="蓝方" />);
  expect(stars()).toBe(0);
  expect(document.querySelector('.plate-title')).toBeNull();
  expect(document.querySelector('.plate-points')).toBeNull();
  // 头像退回国王当"徽记"，圆盘底色走蓝方
  expect(disc('blue')).toBeTruthy();
});

test('电脑那侧：称号写"普通"、没有积分，头像按国王裁', () => {
  render(<NamePlate side="blue" identity="电脑" title="普通" />);
  expect(screen.getByText('普通')).toBeTruthy();
  expect(document.querySelector('.plate-points')).toBeNull();
  const pos = (document.querySelector('.plate-disc') as HTMLElement).style.backgroundPosition;
  expect(pos.length).toBeGreaterThan(0);
});

test('积分与等级同步：等级名来自 GRADE 表而不是硬编码', () => {
  const grade = gradeFor(1000);
  render(<NamePlate side="red" identity="玩家" gradeIndex={grade.index} points={1000} />);
  expect(screen.getByText(grade.name)).toBeTruthy();
  expect(grade.name).toBe('国王');
});
