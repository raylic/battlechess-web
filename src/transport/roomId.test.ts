import { expect, test } from 'vitest';

import { hostIdForSeed, ROOM_PREFIX } from './roomId';

test('房间 id 由种子派生，同一盘棋算得出来', () => {
  expect(hostIdForSeed(42)).toBe('battlechess-42');
  expect(hostIdForSeed(99214375)).toBe(`${ROOM_PREFIX}-99214375`);
  expect(hostIdForSeed(42)).toBe(hostIdForSeed(42));
});
