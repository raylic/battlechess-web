// @vitest-environment jsdom
import { render } from '@testing-library/react';
import { expect, test } from 'vitest';

import { piecePixel } from '../game/geometry';
import { Piece } from './Piece';

test('未翻开：只有两个面片、没有等级/阵营变量', () => {
  const { container } = render(
    <Piece id="p0" at={[0, 0]} side={null} level={null} revealed={false} dire={0} />,
  );
  const el = container.querySelector('.piece') as HTMLElement;
  expect(el).not.toBeNull();
  expect(el.dataset.pieceId).toBe('p0');
  expect(el.className).not.toContain('is-revealed');
  expect(el.style.getPropertyValue('--lv')).toBe('');
  expect(el.style.getPropertyValue('--side')).toBe('');
  expect(el.querySelectorAll('.face')).toHaveLength(2);
  expect(el.querySelector('.card')).not.toBeNull();
});

test('位置：--px/--py 来自几何换算（单一事实来源）', () => {
  const { container } = render(
    <Piece id="p1" at={[2, 3]} side={null} level={null} revealed={false} dire={0} />,
  );
  const el = container.querySelector('.piece') as HTMLElement;
  const { px, py } = piecePixel(2, 3);
  expect(el.style.getPropertyValue('--px')).toBe(px);
  expect(el.style.getPropertyValue('--py')).toBe(py);
});

test('已翻开：带上精灵图的行列坐标（6 列等级 x 2 行红蓝）', () => {
  const red = render(<Piece id="p2" at={[0, 0]} side="red" level={5} revealed dire={0} />);
  const redEl = red.container.querySelector('.piece') as HTMLElement;
  expect(redEl.className).toContain('is-revealed');
  expect(redEl.style.getPropertyValue('--lv')).toBe('5');
  expect(redEl.style.getPropertyValue('--side'), '红方 = 精灵图上半行').toBe('0');

  const blue = render(<Piece id="p3" at={[0, 0]} side="blue" level={0} revealed dire={0} />);
  const blueEl = blue.container.querySelector('.piece') as HTMLElement;
  expect(blueEl.style.getPropertyValue('--lv')).toBe('0');
  expect(blueEl.style.getPropertyValue('--side'), '蓝方 = 精灵图下半行').toBe('1');
});

test('朝向：dire=1 加镜像类', () => {
  const flat = render(<Piece id="p4" at={[0, 0]} side="red" level={1} revealed dire={0} />);
  expect((flat.container.querySelector('.piece') as HTMLElement).className).not.toContain('is-dir-1');

  const mirrored = render(<Piece id="p5" at={[0, 0]} side="red" level={1} revealed dire={1} />);
  expect((mirrored.container.querySelector('.piece') as HTMLElement).className).toContain('is-dir-1');
});

test('active / ghost 状态类', () => {
  const { container } = render(
    <Piece id="p6" at={[1, 1]} side="red" level={0} revealed active ghost dire={0} />,
  );
  const el = container.querySelector('.piece') as HTMLElement;
  expect(el.className).toContain('is-active');
  expect(el.className).toContain('is-eaten');
});
