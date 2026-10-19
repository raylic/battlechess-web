// Cloudflare Worker：给浏览器签发**短时** TURN 凭据。
//
// 为什么要有这一步：Cloudflare Calls TURN 不允许把长期密钥放在前端（静态站点上等于公开），
// 它的用法是「用 App Secret 换一组带 TTL 的 username/credential」。密钥只能待在服务端，
// 所以这里放一个 40 行的 Worker —— 免费额度足够，前端只认得一个 URL。
//
// 部署（一次性）：
//   1. Cloudflare 控制台 → Realtime（Calls）→ 创建一个 TURN App，记下 App ID 和 API Token
//   2. wrangler secret put TURN_TOKEN_ID    # = App ID
//      wrangler secret put TURN_API_TOKEN   # = API Token
//      wrangler deploy
//   3. 把部署出来的地址写进前端构建环境变量：
//      VITE_TURN_ENDPOINT=https://<worker>.workers.dev
//
// 前端拿到 `{ iceServers: [...] }` 就直接塞给 RTCPeerConnection（见 src/transport/ice.ts）。
// ALLOWED_ORIGIN 用逗号分隔，留空则回 `*`（TURN 凭据本身是短时的，风险有限）。

const CREDENTIALS_URL = 'https://rtc.live.cloudflare.com/v1/turn/keys';
const TTL_SECONDS = 3600; // Cloudflare 要求 600~86400

/**
 * @param {Request} request
 * @param {{ TURN_TOKEN_ID?: string, TURN_API_TOKEN?: string, ALLOWED_ORIGIN?: string }} env
 */
export default {
  async fetch(request, env) {
    const allowed = (env.ALLOWED_ORIGIN ?? '*')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    const origin = request.headers.get('Origin') ?? '';
    const allowOrigin = allowed.includes('*') ? '*' : allowed.includes(origin) ? origin : allowed[0] || '*';

    const cors = {
      'Access-Control-Allow-Origin': allowOrigin,
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Max-Age': '86400',
      Vary: 'Origin',
    };

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    if (request.method !== 'GET') {
      return json({ error: '只支持 GET' }, 405, cors);
    }
    if (!env.TURN_TOKEN_ID || !env.TURN_API_TOKEN) {
      return json({ error: '服务端没配 TURN_TOKEN_ID / TURN_API_TOKEN' }, 500, cors);
    }

    const upstream = await fetch(`${CREDENTIALS_URL}/${env.TURN_TOKEN_ID}/credentials/generate-ice-servers`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.TURN_API_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ ttl: TTL_SECONDS }),
    });

    if (!upstream.ok) {
      const detail = await upstream.text().catch(() => '');
      return json({ error: 'Cloudflare 拒绝了签发请求', status: upstream.status, detail: detail.slice(0, 300) }, 502, cors);
    }

    // 原样透传 `{ iceServers: { urls, username, credential } }`
    const data = await upstream.json();
    const ttl = TTL_SECONDS;
    return json({ ...data, ttl }, 200, { ...cors, 'Cache-Control': `public, max-age=${ttl - 300}` });
  },
};

/**
 * @param {unknown} body
 * @param {number} status
 * @param {Record<string, string>} headers
 */
function json(body, status, headers) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...headers, 'Content-Type': 'application/json; charset=utf-8' },
  });
}
