// 网络权重的加载（懒加载 + 失败回退）。
//
// 权重放在 public/models/ 下当静态资源，**不进 JS 包**：
//   · 首屏不需要它（只有选了"网络"档才用得上）；
//   · Service Worker 会按"用到即缓存"把它存下来，离线也能用；
//   · 权重文件和代码分离，重新训练只换这个文件，不动 JS/CSS 的 hash。
//
// 拿不到权重（离线首访、文件缺失、格式不对）一律返回 null，调用方回退到搜索/启发式 ——
// 宁可下一盘弱棋，也不能让棋盘点不动。

import { TinyNet, parseWeights } from '../core/nn';

export const NET_PATH = 'models/net-v1.bin';

let cached: TinyNet | null = null;
let inflight: Promise<TinyNet | null> | null = null;
let failed = false;

/** 已经加载好的网络；没加载/失败则为 null（同步，给渲染路径用） */
export function currentNet(): TinyNet | null {
  return cached;
}

/** 是否尝试过加载但失败了（用于提示用户） */
export function netFailed(): boolean {
  return failed;
}

export function loadNet(): Promise<TinyNet | null> {
  if (cached) return Promise.resolve(cached);
  if (inflight) return inflight;
  const url = `${import.meta.env.BASE_URL}${NET_PATH}`;
  inflight = fetch(url)
    .then((res) => {
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.arrayBuffer();
    })
    .then((buf) => {
      cached = new TinyNet(parseWeights(buf));
      return cached;
    })
    .catch((err: unknown) => {
      failed = true;
      console.warn('网络权重加载失败，已回退到搜索 AI：', err);
      return null;
    });
  return inflight;
}

/** 测试用：清掉缓存 */
export function resetNetCache(): void {
  cached = null;
  inflight = null;
  failed = false;
}
