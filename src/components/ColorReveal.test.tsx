// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import { expect, test } from 'vitest';

import { ColorReveal } from './ColorReveal';

const faces = () =>
  [...document.querySelectorAll('.reveal-face')].map((n) =>
    (n.querySelector('.plate-art') as HTMLImageElement).src.split('/').pop(),
  );

test('两面的牌面就是 HUD 那份名牌：正面红、背面蓝', () => {
  render(<ColorReveal side="red" />);
  expect(faces()).toEqual(['head_red.webp', 'head_blue.webp']);
  expect(document.querySelector('.reveal-face.back')).toBeTruthy();
  // 两面各有一枚圆盘头像，且都来自 chess.webp 的裁切
  const discs = [...document.querySelectorAll('.reveal-face .plate-disc')] as HTMLElement[];
  expect(discs).toHaveLength(2);
  expect(discs.every((d) => d.style.backgroundImage.includes('chess.webp'))).toBe(true);
});

test('牌面带上我的等级与积分（转的时候就能看见自己几级）', () => {
  render(<ColorReveal side="blue" points={820} />);
  // 820 分 = 将军（5 星）
  expect(screen.getAllByText('将军')).toHaveLength(2);
  expect(screen.getAllByText('820')).toHaveLength(2);
  expect(document.querySelectorAll('.reveal-face .plate-star')).toHaveLength(10);
});

test('落定的角度决定停在哪一面：红 4 圈、蓝 4 圈半', () => {
  const { unmount } = render(<ColorReveal side="red" />);
  const red = screen.getByTestId('color-reveal');
  expect(red.dataset.side).toBe('red');
  expect(red.style.getPropertyValue('--turns')).toBe('1440deg');
  expect(screen.getByTestId('reveal-text')).toHaveTextContent('你执红方');
  unmount();

  render(<ColorReveal side="blue" />);
  const blue = screen.getByTestId('color-reveal');
  expect(blue.style.getPropertyValue('--turns')).toBe('1620deg');
  expect(screen.getByTestId('reveal-text')).toHaveTextContent('你执蓝方');
});

test('纯装饰层：对读屏隐藏，不劫持焦点', () => {
  render(<ColorReveal side="blue" />);
  expect(screen.getByTestId('color-reveal')).toHaveAttribute('aria-hidden', 'true');
});
