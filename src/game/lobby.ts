// 联机大厅的纯函数：房号 / 邀请链接。
//
// 三条不变量（测试都钉着）：
//   1. 房号是**种子的后四位**：房主念得出来，客人在链接里也能对得上；
//   2. 邀请链接里的 `host` 必须等于 `hostIdForSeed(seed)`，且 `seed` 必须带上 ——
//      房主握手时会校验 `join.seed !== seed`，少一个参数就会被判"不是这一盘棋"；
//   3. `parseRoomCode` 对"整条链接"和"手输四位"都要工作，抠不出来返回 null。

import { hostIdForSeed } from '../transport/roomId';

/** 房号长度：四位，念得出来、记得住 */
export const ROOM_CODE_LEN = 4;

/** 随机房号（1000~9999）。注入 rand 是为了测试可复现 */
export function randomRoomCode(rand: () => number = Math.random): string {
  return String(1000 + Math.floor(rand() * 9000));
}

/** 房号 = 种子的后四位（`99214375` → `4375`） */
export function roomCodeFor(seed: number): string {
  const n = Math.abs(Math.trunc(seed));
  return String(n % 10 ** ROOM_CODE_LEN).padStart(ROOM_CODE_LEN, '0');
}

/**
 * 从「四位房号」或「整条邀请链接」里抠出房号。
 *
 * 抠不出来就返回 null —— 调用方据此给出「请输入 4 位房号」这类提示，
 * 而不是把一个非法字符串塞进连接流程。
 */
export function parseRoomCode(raw: string): string | null {
  const text = raw.trim();
  if (!text) return null;

  // 整条链接优先：房号藏在 host=battlechess-<seed> 的尾巴上（撞号退化成随机 id 时尾巴是随机的，
  // 那就退回去看 seed 参数 —— 我们拼链接时一定带 seed）
  const host = /[?&]host=([^&\s]+)/.exec(text);
  if (host) {
    // 只认"干净"的 `battlechess-<种子>`。撞号退化成 `battlechess-<种子>-<随机后缀>` 时
    // 尾巴是随机十六进制，抠出来毫无意义（`…-ab12cd34` 会骗到 "34"），落到 seed 参数更可靠。
    const exact = /^[a-z]+-(\d+)$/i.exec(decodeURIComponent(host[1]!));
    if (exact) return roomCodeFor(Number(exact[1]));
  }
  const seed = /[?&]seed=(\d+)/.exec(text);
  if (seed) return roomCodeFor(Number(seed[1]));

  // 手输：四位数字，前后不能粘着更大的数字串（`?seed=12345678` 里的 5678 不能当房号）
  const m = /(?:^|\D)(\d{4})(?!\d)/.exec(text);
  return m ? m[1]! : null;
}

/**
 * 把「整条链接」或「手输四位房号」解析成真正可连的目标。
 *
 * 关键约定：**房间种子就是这个四位数房号**。房主建房时 `start('online', 'red', { seed: Number(code) })`，
 * 于是 `host = battlechess-<code>`、`seed = <code>` 都能从四个数字推出来 —— 手输房号才能连上。
 * （如果房间种子是随机 8 位数，光有四位尾巴是找不回房间的。）
 */
export function joinTarget(raw: string): { hostId: string; seed: number } | null {
  const text = raw.trim();
  if (!text) return null;

  const hostParam = /[?&]host=([^&\s]+)/.exec(text);
  const seedParam = /[?&]seed=(\d+)/.exec(text);
  if (hostParam) {
    const hostId = decodeURIComponent(hostParam[1]!);
    if (seedParam) {
      const seed = Number(seedParam[1]);
      if (!Number.isFinite(seed) || seed <= 0) return null;
      return { hostId, seed };
    }
    // 老链接可能没带 seed：host 是干净的 `battlechess-<种子>` 时还能反推；
    // 撞号退化成 `battlechess-<种子>-<随机后缀>` 的就没法猜了（宁可不连，也别连错盘）
    const clean = /^[a-z]+-(\d+)$/i.exec(hostId);
    return clean ? { hostId, seed: Number(clean[1]) } : null;
  }

  const code = /(?:^|\D)(\d{4})(?!\d)/.exec(text);
  if (!code) return null;
  const seed = Number(code[1]);
  return { hostId: hostIdForSeed(seed), seed };
}

/**
 * 拼邀请链接：把当前页换成"对方视角"的那一份（去掉原有 query，只留联机参数）。
 *
 * `hostId` 默认按种子派生；真正接线后传 `attachPeerHost()` 返回的那个
 * （撞号退化成随机 id 时它才是真的）。
 */
export function inviteLink(
  seed: number,
  hostId: string = hostIdForSeed(seed),
  base: string = window.location.href,
): string {
  const url = new URL(base);
  url.search = '';
  url.searchParams.set('mode', 'online');
  url.searchParams.set('host', hostId);
  url.searchParams.set('seed', String(seed));
  return url.toString();
}
