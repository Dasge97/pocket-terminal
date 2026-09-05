import { createServer } from 'node:http';
import { readFile, readdir, realpath, stat } from 'node:fs/promises';
import { resolve, sep, extname, dirname, isAbsolute, join } from 'node:path';
import { WebSocketServer } from 'ws';
import { Auth } from './auth.mjs';
import { Sessions } from './sessions.mjs';

const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.woff2': 'font/woff2' };
const securityHeaders = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Cache-Control': 'no-store',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  // xterm positions cells and its textarea through inline styles, but scripts remain self-only.
  'Content-Security-Policy': "default-src 'none'; script-src 'self'; worker-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; manifest-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
};

function json(res, status, body, headers = {}) {
  res.writeHead(status, { ...securityHeaders, 'Content-Type': 'application/json; charset=utf-8', ...headers });
  res.end(JSON.stringify(body));
}
async function readJson(req) {
  if (!(req.headers['content-type'] ?? '').startsWith('application/json')) throw Object.assign(new Error('Se requiere JSON.'), { status: 415 });
  let size = 0; const parts = [];
  for await (const part of req) {
    size += part.length;
    if (size > 8192) throw Object.assign(new Error('Solicitud demasiado grande.'), { status: 413 });
    parts.push(part);
  }
  try {
    const body = JSON.parse(Buffer.concat(parts).toString('utf8'));
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error();
    return body;
  } catch { throw Object.assign(new Error('JSON inválido.'), { status: 400 }); }
}

// The folder picker only ever lists names. It never opens, reads, runs or
// changes a file, and its single result is the folder a new terminal starts in.
const BROWSE_LIMIT = 2000;
let rootsCache = { at: 0, value: null };
async function roots() {
  if (process.platform !== 'win32') return ['/'];
  if (rootsCache.value && Date.now() - rootsCache.at < 30_000) return rootsCache.value;
  const found = await Promise.all([...'ABCDEFGHIJKLMNOPQRSTUVWXYZ'].map(letter => Promise.race([
    stat(`${letter}:${sep}`).then(() => `${letter}:${sep}`, () => null),
    // A drive that never answers must not hold up the whole listing.
    new Promise(done => { setTimeout(() => done(null), 1500).unref?.(); }),
  ])));
  rootsCache = { at: Date.now(), value: found.filter(Boolean) };
  return rootsCache.value;
}
async function browse(requested, config) {
  if (requested && (requested.length > 4096 || !isAbsolute(requested))) {
    throw Object.assign(new Error('Introduce una ruta absoluta de tu ordenador.'), { status: 400 });
  }
  let path;
  try { path = await realpath(resolve(requested || config.defaultCwd)); }
  catch { throw Object.assign(new Error('No se encuentra esa carpeta en tu ordenador.'), { status: 404 }); }
  if (!(await stat(path)).isDirectory()) throw Object.assign(new Error('La ruta no es una carpeta.'), { status: 400 });
  let found;
  try { found = await readdir(path, { withFileTypes: true }); }
  catch { throw Object.assign(new Error('No tienes permiso para ver esta carpeta.'), { status: 403 }); }
  const entries = [];
  for (const item of found.slice(0, BROWSE_LIMIT)) {
    // A link to a folder should behave like the folder it points at.
    const dir = item.isDirectory() || (item.isSymbolicLink() && await stat(join(path, item.name)).then(s => s.isDirectory(), () => false));
    entries.push({ name: item.name, dir });
  }
  entries.sort((a, b) => (b.dir - a.dir) || a.name.localeCompare(b.name, 'es', { numeric: true, sensitivity: 'base' }));
  const parent = dirname(path);
  return { path, parent: parent === path ? null : parent, sep, entries, truncated: found.length > BROWSE_LIMIT, roots: await roots() };
}

export function createApp(config) {
  const auth = new Auth(config);
  const sessions = new Sessions(config);
  const allowedHosts = new Set([new URL(config.publicOrigin).host, `localhost:${config.port}`, `127.0.0.1:${config.port}`]);
  const hostOK = req => allowedHosts.has(req.headers.host);
  const originOK = req => req.headers.origin === config.publicOrigin;
  const pageHeaders = {
    ...securityHeaders,
    // Some mobile browsers do not include WebSockets in connect-src 'self'.
    'Content-Security-Policy': securityHeaders['Content-Security-Policy'].replace("connect-src 'self'", `connect-src 'self' ${config.publicOrigin.replace(/^http/, 'ws')}`),
  };
  const server = createServer(async (req, res) => {
    try {
      if (!hostOK(req)) return json(res, 403, { error: 'Host no permitido.' });
      const url = new URL(req.url, config.publicOrigin);
      if (!['GET', 'HEAD'].includes(req.method) && !originOK(req)) return json(res, 403, { error: 'Origen no permitido.' });
      if (req.method === 'POST' && url.pathname === '/api/login') {
        const { password } = await readJson(req);
        const result = await auth.login(password);
        if (result.status !== 200) return json(res, result.status, { error: result.status === 429 ? 'Demasiados intentos. Espera un minuto.' : 'Contraseña incorrecta.' }, result.status === 429 ? { 'Retry-After': '60' } : {});
        return json(res, 200, { ok: true }, { 'Set-Cookie': auth.cookie(result.token) });
      }
      if (url.pathname.startsWith('/api/')) {
        if (!auth.check(req)) return json(res, 401, { error: 'Inicia sesión para continuar.' });
        if (req.method === 'GET' && url.pathname === '/api/state') {
          return json(res, 200, { sessions: sessions.list(), defaultCwd: config.defaultCwd, shell: config.shell, platform: process.platform });
        }
        if (req.method === 'GET' && url.pathname === '/api/browse') {
          return json(res, 200, await browse(url.searchParams.get('path'), config));
        }
        if (req.method === 'POST' && url.pathname === '/api/logout') {
          const token = auth.token(req);
          auth.tokens.delete(token);
          for (const ws of wss.clients) if (ws.authToken === token) ws.close(4401, 'Sesión de acceso cerrada');
          return json(res, 200, { ok: true }, { 'Set-Cookie': auth.cookie('', true) });
        }
        if (req.method === 'POST' && url.pathname === '/api/sessions') {
          const body = await readJson(req);
          try { return json(res, 201, await sessions.create(body)); }
          catch (error) { return json(res, 400, { error: `No se pudo abrir la terminal: ${error.message}` }); }
        }
        const match = url.pathname.match(/^\/api\/sessions\/([a-f0-9-]{36})$/);
        if (req.method === 'DELETE' && match) {
          const found = await sessions.remove(match[1]);
          return json(res, found ? 200 : 404, found ? { ok: true } : { error: 'La sesión ya no existe.' });
        }
        return json(res, 404, { error: 'Ruta no encontrada.' });
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') return json(res, 405, { error: 'Método no permitido.' });
      let pathname;
      try { pathname = decodeURIComponent(url.pathname); }
      catch { return json(res, 400, { error: 'Ruta inválida.' }); }
      const path = resolve(config.distPath, `.${pathname === '/' ? '/index.html' : pathname}`);
      if (!path.startsWith(resolve(config.distPath) + sep)) return json(res, 403, { error: 'Ruta no permitida.' });
      try {
        if (!(await stat(path)).isFile()) throw new Error();
        const content = await readFile(path);
        res.writeHead(200, {
          ...pageHeaders,
          // Built assets carry a content hash in their name, so a cached copy is
          // always the right one. Everything else must stay fresh.
          'Cache-Control': pathname.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-store',
          'Content-Type': types[extname(path)] || 'application/octet-stream', 'Content-Length': content.length,
        });
        res.end(req.method === 'HEAD' ? undefined : content);
      } catch { json(res, 404, { error: 'Archivo no encontrado. Ejecuta npm run build si aún no has compilado la web.' }); }
    } catch (error) {
      if (!res.headersSent) json(res, error.status || 500, { error: error.status ? error.message : 'Error interno.' });
      else res.end();
    }
  });
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  server.maxHeadersCount = 40;
  const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024, perMessageDeflate: false });
  server.on('upgrade', (req, socket, head) => {
    socket.on('error', () => {});
    const reject = code => { socket.end(`HTTP/1.1 ${code} Rejected\r\nConnection: close\r\n\r\n`); };
    if (!hostOK(req) || !originOK(req)) return reject(403);
    if (!auth.check(req)) return reject(401);
    let match;
    try { match = new URL(req.url, config.publicOrigin).pathname.match(/^\/ws\/([a-f0-9-]{36})$/); }
    catch { return reject(400); }
    if (!match || !sessions.items.has(match[1])) return reject(404);
    if (wss.clients.size >= 24) return reject(429);
    wss.handleUpgrade(req, socket, head, ws => {
      ws.authToken = auth.token(req); ws.alive = true;
      ws.on('error', () => {});
      ws.on('pong', () => { ws.alive = true; });
      // Check expiry on every input as well as heartbeat; an open socket never bypasses logout.
      sessions.attach(match[1], ws, () => auth.valid(ws.authToken));
    });
  });
  const heartbeat = setInterval(() => {
    auth.sweep();
    for (const ws of wss.clients) {
      if (!auth.valid(ws.authToken)) { ws.close(4401, 'Vuelve a iniciar sesión'); continue; }
      if (!ws.alive) { ws.terminate(); continue; }
      ws.alive = false; ws.ping();
    }
  }, 15_000);
  heartbeat.unref();
  return {
    server, auth, sessions,
    async close() {
      clearInterval(heartbeat);
      for (const ws of wss.clients) ws.terminate();
      await sessions.close();
      wss.close();
      server.closeAllConnections();
      if (server.listening) await new Promise(resolve => server.close(resolve));
    },
  };
}
