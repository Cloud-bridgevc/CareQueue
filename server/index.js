// CareQueue HTTP server (zero dependencies). Serves the public website at /,
// the operations dashboard at /app, and the JSON API at /api.

import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { extname, join, normalize, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createStore, sweep } from './store.js';
import { match, authorize } from './api.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.PORT) || 4310;
const SESSION_TTL_MS = 8 * 60 * 60 * 1000;
const SWEEP_INTERVAL_MS = 60 * 1000;

const store = createStore();

const STATIC = [
  ['/shared/', join(ROOT, 'shared')],
  ['/app/', join(ROOT, 'public', 'app')],
  ['/assets/', join(ROOT, 'public', 'assets')],
  ['/', join(ROOT, 'public', 'site')],
];
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json', '.ico': 'image/x-icon' };

const SECURITY_HEADERS = {
  'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  'X-Frame-Options': 'DENY',
};

function send(res, status, body, headers = {}) {
  const isJson = typeof body !== 'string' && !Buffer.isBuffer(body);
  res.writeHead(status, { ...SECURITY_HEADERS, 'Content-Type': isJson ? 'application/json; charset=utf-8' : headers['Content-Type'] || 'text/plain', 'Cache-Control': 'no-store', ...headers });
  res.end(isJson ? JSON.stringify(body) : body);
}

function cookies(req) {
  return Object.fromEntries((req.headers.cookie || '').split(';').map((c) => c.trim().split('=')).filter(([k]) => k).map(([k, ...v]) => [k, decodeURIComponent(v.join('='))]));
}

function sessionUser(req) {
  const sid = cookies(req).cq_session;
  const sess = sid && store.sessions.get(sid);
  if (!sess) return null;
  if (Date.now() - sess.lastSeen > SESSION_TTL_MS) { store.sessions.delete(sid); return null; }
  sess.lastSeen = Date.now();
  return store.staff.find((u) => u.id === sess.userId) || null;
}

async function readBody(req, limit = 64 * 1024) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw Object.assign(new Error('Request body too large.'), { status: 413 });
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw Object.assign(new Error('Invalid JSON.'), { status: 400 }); }
}

const hits = new Map();
function rateLimited(key, max = 5, windowMs = 60_000) {
  const now = Date.now();
  const list = (hits.get(key) || []).filter((t) => now - t < windowMs);
  list.push(now);
  hits.set(key, list);
  return list.length > max;
}

async function handleApi(req, res, url) {
  const method = req.method;
  // CSRF: cookies are SameSite=Strict and all state-changing calls must be same-origin JSON with a custom header.
  if (method !== 'GET' && req.headers['x-carequeue'] !== '1') return send(res, 403, { error: 'Missing request header.' });

  // Session endpoints
  if (url.pathname === '/api/session' && method === 'POST') {
    const body = await readBody(req);
    const user = store.staff.find((u) => u.id === body.userId);
    if (!user) return send(res, 400, { error: 'Unknown persona.' });
    const sid = randomBytes(24).toString('base64url');
    store.sessions.set(sid, { userId: user.id, lastSeen: Date.now() });
    store.audit.append({ actor: user, action: 'session.signed_in', entity: 'session', detail: { method: 'demo-persona' } });
    return send(res, 200, { ok: true }, { 'Set-Cookie': `cq_session=${sid}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_TTL_MS / 1000}` });
  }
  if (url.pathname === '/api/session' && method === 'DELETE') {
    const sid = cookies(req).cq_session;
    const user = sessionUser(req);
    if (sid) store.sessions.delete(sid);
    if (user) store.audit.append({ actor: user, action: 'session.signed_out', entity: 'session' });
    return send(res, 200, { ok: true }, { 'Set-Cookie': 'cq_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0' });
  }

  const r = match(method, url.pathname);
  if (!r) return send(res, 404, { error: 'Not found.' });
  const user = sessionUser(req);
  try {
    authorize(r, user);
  } catch (err) {
    if (user) store.audit.append({ actor: user, action: 'access.denied', entity: 'api', detail: { method, path: url.pathname }, outcome: 'denied' });
    return send(res, err.status, { error: err.message });
  }
  if (r.permission === 'public' && method === 'POST' && rateLimited(req.socket.remoteAddress)) return send(res, 429, { error: 'Too many requests. Try again shortly.' });

  const body = method === 'GET' ? {} : await readBody(req);
  const ctx = {
    s: store, user, params: r.params, query: url.searchParams, body, now: Date.now(),
    audit: (action, entity, entityId, detail) => store.audit.append({ actor: user, action, entity, entityId, detail }),
  };
  const data = await r.handler(ctx);
  return send(res, 200, data);
}

async function serveStatic(req, res, url) {
  let pathname = decodeURIComponent(url.pathname);
  if (pathname === '/app') pathname = '/app/';
  for (const [prefix, dir] of STATIC) {
    if (!pathname.startsWith(prefix)) continue;
    let rel = pathname.slice(prefix.length) || 'index.html';
    if (rel.endsWith('/')) rel += 'index.html';
    if (!extname(rel)) rel += '.html';
    const file = normalize(join(dir, rel));
    if (!file.startsWith(dir)) return send(res, 403, 'Forbidden');
    try {
      const st = await stat(file);
      if (!st.isFile()) throw new Error('not file');
      const data = await readFile(file);
      return send(res, 200, data, { 'Content-Type': TYPES[extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    } catch {
      if (prefix !== '/') return send(res, 404, 'Not found');
    }
  }
  const page404 = await readFile(join(ROOT, 'public', 'site', '404.html')).catch(() => 'Not found');
  return send(res, 404, page404, { 'Content-Type': 'text/html; charset=utf-8' });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  try {
    if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Method not allowed');
    return await serveStatic(req, res, url);
  } catch (err) {
    const status = err.status || 500;
    if (status === 500) console.error(err);
    return send(res, status, { error: status === 500 ? 'Something went wrong.' : err.message });
  }
});

// Background monitor (the Lambda sweep in AWS).
setInterval(() => sweep(store, Date.now()), SWEEP_INTERVAL_MS).unref();

server.listen(PORT, () => {
  console.log(`CareQueue running — website http://localhost:${PORT}/  ·  dashboard http://localhost:${PORT}/app/`);
  console.log('All data is synthetic. Summaries use the local drafter unless CAREQUEUE_BEDROCK_REGION is set.');
});
