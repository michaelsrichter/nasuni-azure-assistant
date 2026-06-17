// Token-proxy sidecar for the Foundry hosted agent.
//
// The browser cannot mint Microsoft Entra tokens, and we don't want to ship a
// secret to the SPA. This tiny Node service runs as a second container in the
// same Azure Container App as nginx, acquires a token for the Foundry Agent
// Service using the workload's managed identity, and streams the request
// straight through to the agent's Responses endpoint. nginx in front of it
// proxies /api/responses here.
//
// Production (Foundry Hosted Agent Service):
//   FOUNDRY_AGENT_RESPONSES_URL=https://<account>.services.ai.azure.com/api/projects/<project>/agents/<agent>/endpoint/protocols/openai/responses?api-version=v1
//   FOUNDRY_TOKEN_SCOPE=https://ai.azure.com/.default   (default)
//
// Local dev (a container you run yourself on :8088):
//   FOUNDRY_AGENT_ENDPOINT=http://127.0.0.1:8088   (the sidecar appends /responses)
//   FOUNDRY_TOKEN_SCOPE=                            (empty: skip token)
//   INJECT_ISOLATION_KEYS=true                      (the local runtime needs them)

import http from 'node:http';
import https from 'node:https';
import { DefaultAzureCredential } from '@azure/identity';

const PORT = Number(process.env.PROXY_PORT ?? 8090);
const HOST = process.env.PROXY_HOST ?? '127.0.0.1';

// The upstream is either a full Responses URL (Foundry hosted agent) or a base
// endpoint we append `/responses` to (a locally-run agent container).
const RESPONSES_URL = process.env.FOUNDRY_AGENT_RESPONSES_URL;
const AGENT_ENDPOINT = process.env.FOUNDRY_AGENT_ENDPOINT;
if (!RESPONSES_URL && !AGENT_ENDPOINT) {
  console.error('Set FOUNDRY_AGENT_RESPONSES_URL (Foundry hosted agent) or FOUNDRY_AGENT_ENDPOINT (local).');
  process.exit(1);
}
const upstream = RESPONSES_URL ? new URL(RESPONSES_URL) : new URL('/responses', AGENT_ENDPOINT);

// Set FOUNDRY_TOKEN_SCOPE='' to disable Entra token acquisition (e.g. when the
// upstream is a locally-run agent with open ingress). The Foundry Agent Service
// endpoint always requires an Entra token, so the default scope is set.
const TOKEN_SCOPE =
  process.env.FOUNDRY_TOKEN_SCOPE === undefined
    ? 'https://ai.azure.com/.default'
    : process.env.FOUNDRY_TOKEN_SCOPE;

// The Foundry Agent Service manages conversation sessions itself, so the
// per-client isolation headers are only needed for a locally-run agent (the
// in-memory session provider). Opt in with INJECT_ISOLATION_KEYS=true.
const INJECT_ISOLATION_KEYS = /^(1|true|yes)$/i.test(process.env.INJECT_ISOLATION_KEYS ?? '');

const credential = TOKEN_SCOPE ? new DefaultAzureCredential() : null;
let cached = null; // { token: string, expiresOn: number }

async function getToken() {
  if (!TOKEN_SCOPE || !credential) return null;
  const now = Date.now();
  if (cached && cached.expiresOn - now > 5 * 60 * 1000) return cached.token;
  const result = await credential.getToken(TOKEN_SCOPE);
  if (!result) throw new Error('Failed to acquire token from DefaultAzureCredential');
  cached = { token: result.token, expiresOn: result.expiresOnTimestamp };
  return result.token;
}

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

    // Buffer the request body — the upstream expects a content-length, and the
    // body is small (a JSON request, not a stream).
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = Buffer.concat(chunks);

    const headers = {
      'Content-Type': 'application/json',
      'Content-Length': String(body.length),
      Accept: req.headers.accept ?? 'text/event-stream',
    };
    if (token) headers.Authorization = `Bearer ${token}`;
    if (INJECT_ISOLATION_KEYS) {
      // A locally-run agent uses an in-memory session provider that requires
      // these headers; the Foundry Agent Service injects its own in prod.
      headers['x-agent-user-isolation-key'] =
        req.headers['x-agent-user-isolation-key'] || deriveUserKey(req);
      headers['x-agent-chat-isolation-key'] =
        req.headers['x-agent-chat-isolation-key'] || deriveChatKey(req);
    }

    const upstreamReq = (upstream.protocol === 'https:' ? https : http).request(
      {
        protocol: upstream.protocol,
        hostname: upstream.hostname,
        port: upstream.port || (upstream.protocol === 'https:' ? 443 : 80),
        path: upstream.pathname + upstream.search,
        method: 'POST',
        headers,
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
