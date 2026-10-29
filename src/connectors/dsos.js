// DSOS connector: reads and writes the DSOS API (/api/v1, Bearer token).
//
// Config (environment, set by the HUB installer):
//   FLOW_DSOS_URL      default http://127.0.0.1:3000 (DSOS on the same HUB)
//   FLOW_DSOS_TOKEN    the token itself, or leave unset and put it in
//   FLOW_SECRETS_DIR\dsos-token.txt  (C:\Flow\secrets on the HUB). Read on every call,
//                      so dropping the file in works without a restart.
//   FLOW_DSOS_WRITES   'live' to allow real writes. Anything else = shadow.
//
// Safety:
// - Reads (GET) go through. Writes (POST/PUT/PATCH/DELETE) are SHADOW by default: nothing is
//   sent, the request is logged as what it *would* do. A write only goes live when the step
//   says `live: true` AND FLOW_DSOS_WRITES=live. Jake's yes in CHECKIN comes first.
// - Paths must be relative and start with /api/v1/, so the token can never go to another host.
// - The token never appears in outputs, logs or errors.
import fs from 'node:fs';
import path from 'node:path';

export const DSOS_DEFAULT_URL = 'http://127.0.0.1:3000';
const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const ALL_METHODS = new Set(['GET', ...WRITE_METHODS]);

export function dsosConfig(env = process.env) {
  let token = env.FLOW_DSOS_TOKEN?.trim() || null;
  let tokenSource = token ? 'env' : null;
  if (!token && env.FLOW_SECRETS_DIR) {
    try {
      token = fs.readFileSync(path.join(env.FLOW_SECRETS_DIR, 'dsos-token.txt'), 'utf8').trim() || null;
      if (token) tokenSource = 'file';
    } catch { /* not there yet */ }
  }
  return {
    baseUrl: (env.FLOW_DSOS_URL?.trim() || DSOS_DEFAULT_URL).replace(/\/+$/, ''),
    token,
    tokenSource,
    writesLive: env.FLOW_DSOS_WRITES === 'live',
  };
}

export function checkDsosPath(p) {
  if (typeof p !== 'string' || !p.startsWith('/api/v1/')) {
    throw new Error(`DSOS path must start with /api/v1/ (got ${JSON.stringify(p)})`);
  }
  // Plain characters only (no %-encoding, which URL would decode back into "..").
  if (!/^\/api\/v1\/[A-Za-z0-9._~:@\-\/]*$/.test(p) || /\/\.\.?(\/|$)|\/\//.test(p)) {
    throw new Error(`DSOS path not allowed: ${JSON.stringify(p)} (use \`query\` for parameters)`);
  }
  return p;
}

export function buildDsosUrl(baseUrl, p, query) {
  const url = new URL(baseUrl + checkDsosPath(p));
  for (const [k, v] of Object.entries(query ?? {})) {
    if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
  }
  return url;
}

// request({ method, path, query, body, live, signal, timeoutMs })
// → GET:            { status, body }
// → write, shadow:  { shadow: true, wouldSend: { method, path, query, body } }
// → write, live:    { status, body, live: true }
export function makeDsosClient({ env = process.env, fetchImpl = fetch } = {}) {
  return {
    config: () => {
      const c = dsosConfig(env);
      return { baseUrl: c.baseUrl, configured: Boolean(c.token), tokenSource: c.tokenSource, writesLive: c.writesLive };
    },

    async request({ method = 'GET', path: p, query, body, live = false, signal, timeoutMs = 30000 }) {
      method = String(method).toUpperCase();
      if (!ALL_METHODS.has(method)) throw new Error(`DSOS method not allowed: ${method}`);
      const cfg = dsosConfig(env);
      const url = buildDsosUrl(cfg.baseUrl, p, query); // validates path even in shadow
      const isWrite = WRITE_METHODS.has(method);

      if (isWrite && !(live === true && cfg.writesLive)) {
        return {
          shadow: true,
          reason: live === true ? 'FLOW_DSOS_WRITES is not "live"' : 'step is not marked live',
          wouldSend: { method, path: p, query: query ?? null, body: body ?? null },
        };
      }

      if (!cfg.token) {
        throw new Error('DSOS connector not configured: put the DSOS API token in C:\\Flow\\secrets\\dsos-token.txt');
      }

      const timeout = AbortSignal.timeout(timeoutMs);
      let res;
      try {
        res = await fetchImpl(url, {
          method,
          headers: {
            authorization: `Bearer ${cfg.token}`,
            accept: 'application/json',
            ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
          },
          body: body !== undefined ? JSON.stringify(body) : undefined,
          signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
        });
      } catch (err) {
        throw new Error(scrub(`DSOS ${method} ${p} failed: ${err.message}`, cfg.token));
      }
      const text = await res.text();
      let parsed;
      try { parsed = JSON.parse(text); } catch { parsed = text; }
      if (!res.ok) {
        const hint = res.status === 401 || res.status === 403 ? ' (check the DSOS token and its scopes)' : '';
        throw new Error(scrub(`DSOS ${method} ${p} → HTTP ${res.status}${hint}: ${String(text).slice(0, 300)}`, cfg.token));
      }
      return isWrite ? { status: res.status, body: parsed, live: true } : { status: res.status, body: parsed };
    },
  };
}

function scrub(message, token) {
  return token ? message.split(token).join('***') : message;
}

export function isDsosWrite(method) {
  return WRITE_METHODS.has(String(method ?? 'GET').toUpperCase());
}
