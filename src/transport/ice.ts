// WebRTC 的 ICE 配置（STUN/TURN）—— 决定"跨网络能不能连上"的唯一开关。
//
// 为什么需要 TURN：两端只要有一边是**对称 NAT**（4G / 5G / 企业网 / 部分家宽），
// 打洞就一定失败，必须有中继兜底。没有 TURN 时表现为"同一个 WiFi 能连、换网络就连不上"，
// 失败点在 ICE 阶段，跟信令、房间号、邀请链接都没关系。
//
// ⚠️ PeerJS 自带的那个 TURN（`turn:0.peerjs.com:3478` / peer / peerjsp）实测**不返回 relay
//    candidate**（2026-02 用 headless Chrome 验过：只有 host + srflx）。Open Relay 的老静态
//    账号（openrelayproject / openrelayproject）同样失效。所以这里不指望任何"公共免费 TURN"，
//    要么走 `VITE_TURN_ENDPOINT`（短时凭据，推荐），要么走 `VITE_TURN_*` 静态凭据。
//
// 三条来源，优先级从高到低：
//   1. `VITE_TURN_ENDPOINT` —— 一个返回 `{ urls, username, credential }` 的地址。凭据是短时的，
//      密钥不进前端（Cloudflare Calls TURN 就是这么用的，见 workers/turn-credentials.js）
//   2. `VITE_TURN_URLS` + `VITE_TURN_USERNAME` + `VITE_TURN_CREDENTIAL` —— 静态凭据
//   3. 只剩 STUN —— 退化成"同网段能连"，此时设置 status 会写明原因

export interface IceServer {
  urls: string | string[];
  username?: string;
  credential?: string;
}

/** 国内可用的 STUN：Google 在某些网络下不稳，多组并行收集，谁通用谁 */
export const STUN_SERVERS: IceServer[] = [
  { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] },
  // 小米 / B站在成都电信实测都能拿到 srflx；stun.qq.com 实测只有 host（别用）
  { urls: ['stun:stun.miwifi.com:3478', 'stun:stun.chat.bilibili.com:3478'] },
  { urls: 'stun:stun.cloudflare.com:3478' },
];

/** 凭据来源，供测试注入 */
export interface IceEnv {
  turnUrls?: string;
  turnUser?: string;
  turnCred?: string;
  endpoint?: string;
}

/** 从 `import.meta.env` 取 VITE_* 配置（构建期注入；取值见 README §联机） */
export function iceEnvFromImportMeta(env: Record<string, unknown>): IceEnv {
  const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
  return {
    turnUrls: str(env.VITE_TURN_URLS),
    turnUser: str(env.VITE_TURN_USERNAME),
    turnCred: str(env.VITE_TURN_CREDENTIAL),
    endpoint: str(env.VITE_TURN_ENDPOINT),
  };
}

/** `"turn:a:3478, turns:b:5349"` → 数组（逗号/空白分隔都认） */
export function parseUrls(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** 静态凭据那一组（没配 url 或没配用户名就当没配） */
export function staticIceServers(env: IceEnv): IceServer[] {
  const urls = parseUrls(env.turnUrls);
  if (urls.length === 0 || !env.turnUser || !env.turnCred) return [];
  return [{ urls, username: env.turnUser, credential: env.turnCred }];
}

/** 合并多组并按 url 去重（后面的同 url 覆盖前面的） */
export function mergeIceServers(...groups: IceServer[][]): IceServer[] {
  const byUrl = new Map<string, IceServer>();
  for (const group of groups) {
    for (const server of group) {
      const urls = Array.isArray(server.urls) ? server.urls : [server.urls];
      for (const url of urls) {
        if (!url) continue;
        byUrl.set(url, { ...server, urls: url });
      }
    }
  }
  return [...byUrl.values()];
}

/** 是不是中继（只有 `turn:` / `turns:` 才是；`stun:` 只是打洞辅助） */
export function isRelayUrl(url: string): boolean {
  const u = url.trim().toLowerCase();
  return u.startsWith('turn:') || u.startsWith('turns:');
}

/**
 * 从任意形状的 JSON 里抠出 ICE server。
 *
 * 实测见过的三种：
 *   Cloudflare Calls：`{ iceServers: [ {urls:[stun…]}, {urls:[turn…], username, credential} ], ttl }`
 *   Cloudflare 文档里的另一种：`{ iceServers: { urls: [...], username, credential } }`（**对象**，不是数组）
 *   Metered 之类：`{ urls, username, credential }` 摊平
 *
 * 三种都认。只认数组的那版会把「对象」那种解析成 0 条 —— 表现是「中继明明配了、跨网络照样连不上」，
 * 而且日志里一句错都没有。
 */
export function normalizeIceResponse(json: unknown): IceServer[] {
  if (typeof json !== 'object' || json === null) return [];
  const record = json as Record<string, unknown>;
  const nested = record.iceServers;
  const raw = Array.isArray(nested) ? nested : typeof nested === 'object' && nested !== null ? [nested] : [record];
  const out: IceServer[] = [];
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) continue;
    const s = item as Record<string, unknown>;
    const urls = Array.isArray(s.urls)
      ? s.urls.filter((u): u is string => typeof u === 'string')
      : typeof s.urls === 'string'
        ? [s.urls]
        : typeof s.url === 'string'
          ? [s.url]
          : [];
    if (urls.length === 0) continue;
    const server: IceServer = { urls: urls.length === 1 ? urls[0]! : urls };
    if (typeof s.username === 'string') server.username = s.username;
    if (typeof s.credential === 'string') server.credential = s.credential;
    out.push(server);
  }
  return out;
}

export interface ResolveIceOptions {
  env: IceEnv;
  fetchImpl?: typeof fetch;
  /** 取凭据的超时：拿不到就当没配，别把开房流程卡死 */
  timeoutMs?: number;
  now?: () => number;
}

export interface ResolvedIce {
  servers: IceServer[];
  /** 有没有中继（没有就只可能同网段/开放 NAT 能连） */
  relay: boolean;
  /** 给界面/排错用的来源说明 */
  source: 'endpoint' | 'static' | 'stun-only';
}

/** 端点返回的 `ttl`（秒）：短时凭据的有效期，拿不到就按 1 小时算 */
export function iceTtlSeconds(json: unknown, fallback = 3600): number {
  if (typeof json !== 'object' || json === null) return fallback;
  const ttl = (json as Record<string, unknown>).ttl;
  if (typeof ttl !== 'number' || !Number.isFinite(ttl)) return fallback;
  return Math.min(Math.max(ttl, 60), 24 * 3600);
}

/** 模块级缓存：凭据是短时的，但没必要每局都换一份 */
interface CacheEntry {
  at: number;
  /** 到期时刻（不是「取的那一刻」）—— 短时凭据必须在过期前换新的 */
  expiresAt: number;
  value: ResolvedIce;
}
const CACHE_TTL_MS = 30 * 60 * 1000;
/** 缓存下限：再短的 ttl 也别每次建连都打端点 */
const MIN_CACHE_MS = 60 * 1000;
/** 拿不到中继（端点挂了 / 没配）只缓存这么久：一次网络抖动不该把整局锁死在 STUN-only */
const NEGATIVE_CACHE_MS = 20 * 1000;
/** 凭据到期前留的余量：刚好过期那一刻建连，最容易掉进「allocation 被拒」 */
const TTL_MARGIN_MS = 5 * 60 * 1000;

let cache: CacheEntry | null = null;
/** 正在取的请求：开房和第一次建连可能同时要 ICE 配置，别打两次端点 */
let inflight: Promise<CacheEntry> | null = null;

export function clearIceCache(): void {
  cache = null;
  inflight = null;
}

/**
 * 解析出这次要用的 iceServers。
 *
 * 顺序：短时凭据端点 → 静态凭据 → 只剩 STUN。端点超时/报错/返回空都静默降级，
 * 不能因为"中继没配好"就把联机整体弄挂（那比只能局域网更糟）。
 *
 * 缓存按**服务端给的 ttl** 到期（最多 30 分钟，且提前 5 分钟换），失败只缓存 20 秒 ——
 * 原来不管成败都缓存 30 分钟，端点抖一下整局就只剩 STUN，而界面上看不出任何异常。
 */
export async function resolveIceServers(opts: ResolveIceOptions): Promise<ResolvedIce> {
  const now = opts.now ?? Date.now;
  if (cache && now() < cache.expiresAt) return cache.value;
  if (inflight) return (await inflight).value;

  inflight = fetchIceEntry(opts, now);
  try {
    const entry = await inflight;
    cache = entry;
    return entry.value;
  } finally {
    inflight = null;
  }
}

async function fetchIceEntry(opts: ResolveIceOptions, now: () => number): Promise<CacheEntry> {
  const staticServers = staticIceServers(opts.env);
  let endpointServers: IceServer[] = [];
  let ttlSeconds = 3600;

  if (opts.env.endpoint) {
    const fetchImpl = opts.fetchImpl ?? (typeof fetch === 'function' ? fetch : null);
    if (fetchImpl) {
      const controller = typeof AbortController === 'function' ? new AbortController() : null;
      const timer = controller ? setTimeout(() => controller.abort(), opts.timeoutMs ?? 4000) : null;
      try {
        const res = await fetchImpl(opts.env.endpoint, controller ? { signal: controller.signal } : {});
        if (res.ok) {
          const json = await res.json();
          endpointServers = normalizeIceResponse(json);
          ttlSeconds = iceTtlSeconds(json);
        }
      } catch {
        // 端点不通就当没配，继续往下退
      } finally {
        if (timer) clearTimeout(timer);
      }
    }
  }

  const servers = mergeIceServers(endpointServers, staticServers, STUN_SERVERS);
  // 「返回了点东西」不等于「有中继」：端点可能只回 STUN。必须是 turn:/turns: 才算
  const relay = [...endpointServers, ...staticServers].some((server) =>
    (Array.isArray(server.urls) ? server.urls : [server.urls]).some(isRelayUrl),
  );
  const value: ResolvedIce = {
    servers,
    relay,
    source: endpointServers.length > 0 ? 'endpoint' : staticServers.length > 0 ? 'static' : 'stun-only',
  };

  const life = relay
    ? Math.min(Math.max(ttlSeconds * 1000 - TTL_MARGIN_MS, MIN_CACHE_MS), CACHE_TTL_MS)
    : NEGATIVE_CACHE_MS;
  const at = now();
  return { at, expiresAt: at + life, value };
}
