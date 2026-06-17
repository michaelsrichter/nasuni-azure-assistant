// Token-proxy sidecar for the Foundry hosted agent.
//
// The browser cannot mint Microsoft Entra tokens, and we don't want to ship a
// secret to the SPA. This tiny Node service runs as a second container in the
// same Azure Container App as nginx, acquires a token for the Foundry agent
// using the workload's managed identity, and streams the request straight
// through to the agent. nginx in front of it proxies /api/responses here.

import http from 'node:http';
import { DefaultAzureCredential } from '@azure/identity';

const PORT = Number(process.env.PROXY_PORT ?? 8090);
const HOST = process.env.PROXY_HOST ?? '127.0.0.1';
const AGENT_ENDPOINT = required('FOUNDRY_AGENT_ENDPOINT'); // e.g. https://<agent>.<region>.foundry.azure.com
const TOKEN_SCOPE = process.env.FOUNDRY_TOKEN_SCOPE ?? 'https://ai.azure.com/.default';

function required(name) {
  const v = process.env[name];
  if (!v) {
    console.error(`Missing required env var: ${name}`);
    process.exit(1);
  }
  return v;
}

const credential = new DefaultAzureCredential();
let cached = null; // { token: string, expiresOn: number }

async function getToken() {
  const now = Date.now();
  if (cached && cached.expiresOn - now > 5 * 60 * 1000) return cached.token;
  const result = await credential.getToken(TOKEN_SCOPE);
  if (!result) throw new Error('Failed to acquire token from DefaultAzureCredential');
  cached = { token: result.token, expiresOn: result.expiresOnTimestamp };
  return result.token;
}

const upstream = new URL('/responses', AGENT_ENDPOINT);

const server = http.createServer(async (req, res) => {
  if (req.method === 'GET' && req.url === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('ok');
    return;
  }
  if (req.method !== 'POST') {
    res.writeHead(405).end('method not allowed');
    return;
  }

  try {
    const token = await getToken();
    const userKey = req.headers['x-agent-user-isolation-key'] || deriveUserKey(req);
    const chatKey = req.headers['x-agent-chat-isolation-key'] || deriveChatKey(req);

    // Buffer the request body — Foundry expects a content-length, and the
    // body is small (a JSON request, not a stream).
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = Buffer.concat(chunks);

    const upstreamReq = http.request(
      {
        protocol: upstream.protocol,
        hostname: upstream.hostname,
        port: upstream.port || (upstream.protocol === 'https:' ? 443 : 80),
        path: upstream.pathname + upstream.search,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': String(body.length),
          Authorization: `Bearer ${token}`,
          'x-agent-user-isolation-key': userKey,
          'x-agent-chat-isolation-key': chatKey,
          Accept: req.headers.accept ?? 'text/event-stream',
        },
      },
      (upstreamRes) => {
        const headers = { ...upstreamRes.headers };
        // Disable any proxy buffering on the way back.
        headers['cache-control'] = 'no-cache, no-transform';
        headers['x-accel-buffering'] = 'no';
        res.writeHead(upstreamRes.statusCode ?? 502, headers);
        upstreamRes.pipe(res);
      },
    );

    upstreamReq.on('error', (err) => {
      console.error('upstream error:', err.message);
      if (!res.headersSent) res.writeHead(502);
      res.end(`upstream error: ${err.message}`);
    });

    upstreamReq.end(body);
  } catch (err) {
    console.error('proxy error:', err);
    if (!res.headersSent) res.writeHead(500);
    res.end(`proxy error: ${err instanceof Error ? err.message : String(err)}`);
  }
});

// Derive stable per-client isolation keys when the SPA didn't supply them.
// The browser doesn't ship its identity; we hash an opaque client fingerprint
// from the request so each session keeps its conversation state separate.
function deriveUserKey(req) {
  const fwd = String(req.headers['x-forwarded-for'] ?? req.socket.remoteAddress ?? 'anon');
  return `client-${fwd.split(',')[0].trim()}`;
}

function deriveChatKey(req) {
  const sid = req.headers['x-session-id'];
  if (typeof sid === 'string' && sid.length > 0) return `chat-${sid}`;
  return `chat-default`;
}

// Use http2/keep-alive friendly timeouts. SSE responses can be long-lived.
const SSE_TIMEOUT_MS = 10 * 60 * 1000;
server.requestTimeout = SSE_TIMEOUT_MS;
server.headersTimeout = 60_000;
server.keepAliveTimeout = SSE_TIMEOUT_MS;

server.listen(PORT, HOST, () => {
  console.log(`token-proxy listening on http://${HOST}:${PORT} -> ${upstream.href}`);
});
