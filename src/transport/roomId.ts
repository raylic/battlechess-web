// 房间 id 的派生公式 —— 单独一个文件，**不能留在 peer.ts 里**。
//
// peer.ts 静态 import 了 peerjs（88 KB min / 24 KB gzip），而 UI 层的 `game/lobby.ts`
// 也要用这个公式（房号 = 种子的后四位，跟 host 参数必须对得上）。从 peer.ts 借一个
// 纯函数会把整个 peerjs 拽进主包 —— 单机 / 热座玩家白下 24 KB。
//
// 所以：公式住在这里，peer.ts 和 lobby.ts 都只 import 这个文件。

export const ROOM_PREFIX = 'battlechess';

/** 房主 peer id 由种子派生：同一盘棋 id 固定，邀请链接不用问也知道 */
export function hostIdForSeed(seed: number): string {
  return `${ROOM_PREFIX}-${seed}`;
}
