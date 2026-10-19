// @vitest-environment jsdom
import { expect, test } from 'vitest';

import { inviteLink, joinTarget, parseRoomCode, randomRoomCode, roomCodeFor } from './lobby';

test('房号 = 种子的后四位，补零到四位', () => {
  expect(roomCodeFor(4821)).toBe('4821');
  expect(roomCodeFor(99214375)).toBe('4375');
  expect(roomCodeFor(7)).toBe('0007');
  expect(roomCodeFor(10000)).toBe('0000');
  expect(roomCodeFor(0)).toBe('0000');
  expect(roomCodeFor(-42)).toBe('0042');
});

test('邀请链接：mode / host / seed 三个参数齐全，其余 query 一律丢掉', () => {
  const link = inviteLink(99214375, undefined, 'https://wu.dev/game/?mode=ai&side=red&ai=net');
  const url = new URL(link);
  expect(url.searchParams.get('mode')).toBe('online');
  expect(url.searchParams.get('host')).toBe('battlechess-99214375');
  expect(url.searchParams.get('seed'), '少 seed 会被房主判"不是这一盘棋"').toBe('99214375');
  expect(url.searchParams.get('side')).toBeNull();
  expect(url.searchParams.get('ai')).toBeNull();
});

test('邀请链接可以带自定义 hostId（撞号退化成随机 id 的情况）', () => {
  const url = new URL(inviteLink(42, 'battlechess-42-ab12cd34', 'https://wu.dev/'));
  expect(url.searchParams.get('host')).toBe('battlechess-42-ab12cd34');
  expect(url.searchParams.get('seed')).toBe('42');
});

test('parseRoomCode：整条链接 → 房号（和 roomCodeFor 对得上）', () => {
  const link = inviteLink(99214375, undefined, 'https://wu.dev/battlechess-web/');
  expect(parseRoomCode(link)).toBe('4375');
  expect(parseRoomCode(link)).toBe(roomCodeFor(99214375));
  expect(parseRoomCode(`房号 ${parseRoomCode(link)}`)).toBe('4375');
});

test('parseRoomCode：撞号退化成随机 id 时，退回看 seed 参数', () => {
  const link = inviteLink(1234, 'battlechess-1234-ab12cd34', 'https://wu.dev/');
  expect(parseRoomCode(link)).toBe('1234');
});

test('parseRoomCode：手输四位、带空白、带前缀都行', () => {
  expect(parseRoomCode('4821')).toBe('4821');
  expect(parseRoomCode('  4821  ')).toBe('4821');
  expect(parseRoomCode('battlechess-4821')).toBe('4821');
  expect(parseRoomCode('房号 4821')).toBe('4821');
});

test('parseRoomCode：抠不出来就是 null（不能误抓更长数字里的片段）', () => {
  expect(parseRoomCode('')).toBeNull();
  expect(parseRoomCode('   ')).toBeNull();
  expect(parseRoomCode('123')).toBeNull();
  expect(parseRoomCode('48210')).toBeNull();
  expect(parseRoomCode('?seed=12345678'), '没有 host，seed 参数要能被认出来').toBe('5678');
  expect(parseRoomCode('?mode=online&host=battlechess-abc')).toBeNull();
  expect(parseRoomCode('abcd')).toBeNull();
});

test('房号可以重新随机（房主建房时用），范围 1000~9999', () => {
  expect(randomRoomCode(() => 0)).toBe('1000');
  expect(randomRoomCode(() => 0.9999999)).toBe('9999');
});

test('joinTarget：整条链接 → host + seed', () => {
  const link = inviteLink(4821, undefined, 'https://wu.dev/game/');
  expect(joinTarget(link)).toEqual({ hostId: 'battlechess-4821', seed: 4821 });
});

test('joinTarget：手输四位房号也能连（房号就是房间种子）', () => {
  expect(joinTarget('4821')).toEqual({ hostId: 'battlechess-4821', seed: 4821 });
  expect(joinTarget('  1000  ')).toEqual({ hostId: 'battlechess-1000', seed: 1000 });
  expect(joinTarget('房号 4821')).toEqual({ hostId: 'battlechess-4821', seed: 4821 });
});

test('joinTarget：抠不出来就是 null', () => {
  expect(joinTarget('')).toBeNull();
  expect(joinTarget('123')).toBeNull();
  expect(joinTarget('hello')).toBeNull();
  // 缺 seed 的链接：干净的 id 还能反推，带随机后缀的就不猜了（宁可不连，别连错盘）
  expect(joinTarget('?mode=online&host=battlechess-4821')).toEqual({ hostId: 'battlechess-4821', seed: 4821 });
  expect(joinTarget('?mode=online&host=battlechess-4821-ab12cd34')).toBeNull();
});

test('joinTarget 与 parseRoomCode 对同一条链接给出一致的房号', () => {
  const link = inviteLink(4821, undefined, 'https://wu.dev/');
  const target = joinTarget(link)!;
  expect(parseRoomCode(link)).toBe(roomCodeFor(target.seed));
});
