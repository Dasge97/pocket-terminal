import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, mkdir, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { WebSocket } from 'ws';
import { createApp } from '../server/app.mjs';
import { hashPassword, Auth } from '../server/auth.mjs';
import { validateConfig } from '../server/config.mjs';

async function freePort() {
  const server = createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const port = server.address().port; await new Promise(resolve => server.close(resolve)); return port;
}
async function fixture(t) {
  const cwd = await mkdtemp(join(tmpdir(), 'pocket-test-'));
  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  const config = validateConfig({ port, publicOrigin: origin, defaultCwd: cwd, shell: process.execPath, shellArgs: [resolve('test/fixtures/terminal.mjs')], ...await hashPassword('test-password-only') });
  const app = createApp(config);
  app.server.listen(port, '127.0.0.1'); await once(app.server, 'listening');
  t.after(async () => { await app.close(); await rm(cwd, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); });
  const request = (path, { cookie, origin: requestOrigin = origin, ...options } = {}) => fetch(`${origin}${path}`, {
    ...options, headers: { Origin: requestOrigin, 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}), ...options.headers },
  });
  const login = async () => {
    const response = await request('/api/login', { method: 'POST', body: JSON.stringify({ password: 'test-password-only' }) });
    assert.equal(response.status, 200);
    assert.match(response.headers.get('set-cookie'), /HttpOnly; SameSite=Strict/);
    return response.headers.get('set-cookie').split(';')[0];
  };
  return { app, config, cwd, port, origin, request, login };
}
function connect(f, id, cookie) {
  const ws = new WebSocket(`ws://127.0.0.1:${f.port}/ws/${id}`, { headers: { Origin: f.origin, Cookie: cookie } });
  const messages = [];
  ws.on('message', data => messages.push(JSON.parse(data.toString())));
  ws.on('error', () => {});
  const until = async predicate => {
    const deadline = Date.now() + 8000;
    while (!predicate(messages)) {
      if (Date.now() > deadline) throw new Error(`No llegó la salida esperada: ${JSON.stringify(messages).slice(-1200)}`);
      await delay(20);
    }
    return messages;
  };
  return { ws, messages, until, write: data => ws.send(JSON.stringify({ type: 'input', data })) };
}
const text = messages => messages.map(m => m.data || '').join('');

test('authentication, CSRF, cookie, private files and request limits', async t => {
  const f = await fixture(t);
  assert.equal((await f.request('/api/state')).status, 401);
  assert.equal((await f.request('/api/login', { method: 'POST', origin: 'https://attacker.example', body: '{}' })).status, 403);
  assert.equal((await f.request('/api/login', { method: 'POST', body: JSON.stringify({ password: 'incorrect' }) })).status, 401);
  const cookie = await f.login();
  assert.equal((await f.request('/api/state', { cookie })).status, 200);
  assert.equal((await f.request('/api/sessions', { cookie, method: 'POST', origin: 'https://attacker.example', body: '{}' })).status, 403);
  assert.equal((await f.request('/api/sessions', { cookie, method: 'POST', body: JSON.stringify({ cwd: 'relative/path' }) })).status, 400);
  assert.equal((await f.request('/api/sessions', { cookie, method: 'POST', body: JSON.stringify({ cols: 999999 }) })).status, 400);
  assert.equal((await f.request('/api/sessions', { cookie, method: 'POST', body: JSON.stringify({ name: 'a'.repeat(9000) }) })).status, 413);
  for (const path of ['/.pocket-terminal/config.json', '/server/app.mjs', '/package.json', '/..%2f..%2fpackage.json']) {
    assert.ok([403, 404].includes((await f.request(path, { cookie })).status));
  }
  const page = await f.request('/');
  assert.equal(page.status, 200); assert.match(await page.text(), /Pocket Terminal/);
  assert.match(page.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  assert.ok(page.headers.get('content-security-policy').includes(f.origin.replace('http:', 'ws:')));
  const manifest = await f.request('/manifest.webmanifest'); assert.equal(manifest.status, 200);
  const source = await readFile('web/main.js', 'utf8'); assert.ok(!source.includes('innerHTML'));
  assert.equal((await f.request('/api/logout', { cookie, method: 'POST', body: '{}' })).status, 200);
  assert.equal((await f.request('/api/state', { cookie })).status, 401);
});

test('WebSocket rejects unauthenticated and cross-origin access', async t => {
  const f = await fixture(t); const cookie = await f.login();
  const session = await f.app.sessions.create({});
  for (const headers of [{ Origin: f.origin }, { Origin: 'https://attacker.example', Cookie: cookie }, { Cookie: cookie }]) {
    await new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${f.port}/ws/${session.id}`, { headers });
      ws.on('open', () => { ws.close(); reject(new Error('Se aceptó una conexión no autorizada')); });
      ws.on('unexpected-response', (_, res) => { assert.ok([401, 403].includes(res.statusCode)); res.resume(); ws.terminate(); resolve(); });
      ws.on('error', () => {});
    });
  }
});

test('real PTY: input, resize, Ctrl+C, reconnect and output while disconnected', async t => {
  const f = await fixture(t); const cookie = await f.login();
  const res = await f.request('/api/sessions', { cookie, method: 'POST', body: JSON.stringify({ cwd: f.cwd, cols: 40, rows: 20 }) });
  assert.equal(res.status, 201); const s = await res.json();
  const a = connect(f, s.id, cookie);
  await a.until(m => m.some(x => x.type === 'snapshot') && text(m).includes('POCKET_READY'));
  a.write('hola móvil\r'); await a.until(m => text(m).includes('ECHO:hola móvil'));
  a.ws.send(JSON.stringify({ type: 'resize', cols: 52, rows: 18 }));
  await delay(150); a.write('size\r'); await a.until(m => text(m).includes('SIZE:52x18'));
  a.write('\x03'); await a.until(m => text(m).includes('INTERRUPTED'));
  a.write('delayed\rquery-later\r'); a.ws.close(); await once(a.ws, 'close');
  await delay(400);
  assert.equal(f.app.sessions.items.get(s.id).exited, false);
  const b = connect(f, s.id, cookie);
  await b.until(m => m.some(x => x.type === 'snapshot' && x.data.includes('OFFLINE_RESULT') && x.data.includes('QUERY_REPLIED')));
  assert.equal(text(b.messages).match(/ECHO:hola móvil/g)?.length, 1);
  const oldClosed = once(b.ws, 'close');
  const c = connect(f, s.id, cookie);
  await c.until(m => m.some(x => x.type === 'snapshot'));
  assert.equal((await oldClosed)[0], 4409);
  c.write('exit\r'); await c.until(m => m.some(x => x.type === 'exit' && x.exitCode === 0));
  assert.equal((await f.request(`/api/sessions/${s.id}`, { cookie, method: 'DELETE' })).status, 200);
  assert.equal(f.app.sessions.items.size, 0);
});

test('closing a live terminal releases the PTY instead of waiting for the shutdown timeout', async t => {
  const f = await fixture(t); const cookie = await f.login();
  const s = await f.app.sessions.create({});
  const a = connect(f, s.id, cookie);
  await a.until(m => text(m).includes('POCKET_READY'));
  const started = Date.now();
  assert.equal((await f.request(`/api/sessions/${s.id}`, { cookie, method: 'DELETE' })).status, 200);
  const elapsed = Date.now() - started;
  // node-pty on Windows only reports the exit once its conout worker is released.
  // Hitting the 3s fallback means that release regressed and workers are leaking.
  assert.ok(elapsed < 2500, `Cerrar la terminal tardó ${elapsed} ms: el PTY no notificó su salida.`);
  assert.equal(f.app.sessions.items.size, 0);
});

test('a burst of output is batched instead of parsed piece by piece', async t => {
  const f = await fixture(t); const cookie = await f.login();
  const s = await f.app.sessions.create({});
  const a = connect(f, s.id, cookie);
  await a.until(m => text(m).includes('POCKET_READY'));
  const started = Date.now();
  a.write('burst 20000\r');
  // The 8s deadline inside `until` is the real guard here: parsing ConPTY's
  // ~37-byte pieces one at a time takes minutes for this much output.
  await a.until(m => text(m).includes('BURST_DONE'));
  const outputs = a.messages.filter(m => m.type === 'output').length;
  assert.ok(outputs < 5000, `La salida llegó en ${outputs} mensajes para 20000 líneas: no se está agrupando.`);
  assert.ok(text(a.messages).includes('L19999 '), 'Se perdieron líneas al agrupar la salida.');
  assert.equal(f.app.sessions.items.get(s.id).pendingChars, 0);
  console.log(`      (ráfaga de 20000 líneas: ${outputs} mensajes en ${Date.now() - started} ms)`);
});

test('reattaching sends a trimmed snapshot, answers a ping and serves the full history on request', async t => {
  const f = await fixture(t); const cookie = await f.login();
  const s = await f.app.sessions.create({});
  const a = connect(f, s.id, cookie);
  await a.until(m => text(m).includes('POCKET_READY'));
  a.write('burst 1200\r');
  await a.until(m => text(m).includes('BURST_DONE'));
  a.ws.close(); await once(a.ws, 'close');

  const b = connect(f, s.id, cookie);
  await b.until(m => m.some(x => x.type === 'snapshot'));
  const first = b.messages.find(m => m.type === 'snapshot');
  // Returning to the foreground must not re-download the whole scrollback.
  assert.equal(first.scrollback, f.config.snapshotScrollback);
  assert.ok(first.hasMore, 'El servidor no avisó de que quedaba más historial.');
  assert.ok(!first.data.includes('L0 '), 'El primer snapshot trajo el historial entero.');
  assert.ok(first.data.includes('L1199 '), 'El primer snapshot perdió el final del historial.');

  // The client uses this round trip to tell a frozen socket from a live one.
  b.ws.send(JSON.stringify({ type: 'ping' }));
  await b.until(m => m.some(x => x.type === 'pong'));

  b.ws.send(JSON.stringify({ type: 'history' }));
  await b.until(m => m.some(x => x.type === 'snapshot' && x.full));
  const full = b.messages.find(m => m.type === 'snapshot' && m.full);
  assert.ok(full.data.includes('L0 '), 'El historial completo no llegó al pedirlo.');
  assert.equal(f.app.sessions.items.get(s.id).exited, false);
});

test('the app installs as a PWA and keeps a copy of itself for offline starts', async t => {
  const f = await fixture(t);
  const page = await f.request('/');
  const html = await page.text();
  assert.equal(page.headers.get('cache-control'), 'no-store');
  // Without worker-src the policy of default-src 'none' blocks the service worker.
  assert.match(page.headers.get('content-security-policy'), /worker-src 'self'/);
  // iOS ignores the manifest icons; without this PNG the home screen shows a screenshot.
  assert.match(html, /rel="apple-touch-icon"/);
  assert.match(html, /\/icon-180\.png/);

  const worker = await f.request('/sw.js');
  assert.equal(worker.status, 200);
  assert.match(worker.headers.get('content-type'), /javascript/);

  const manifest = await (await f.request('/manifest.webmanifest')).json();
  const icons = manifest.icons.map(icon => icon.src);
  assert.ok(icons.includes('/icon-192.png') && icons.includes('/icon-512.png'), 'Faltan los iconos PNG del manifest.');
  assert.ok(manifest.icons.some(icon => icon.purpose === 'maskable'), 'Falta el icono maskable.');
  for (const src of new Set(icons)) assert.equal((await f.request(src)).status, 200, `No se sirve el icono ${src}`);

  // Built assets carry a content hash, so they can be kept for good.
  const asset = html.match(/\/assets\/[\w.-]+\.js/)?.[0];
  assert.ok(asset, 'No se encontró ningún archivo compilado en la página.');
  assert.match((await f.request(asset)).headers.get('cache-control'), /immutable/);
});

test('the folder picker lists names only and refuses anything that is not a folder', async t => {
  const f = await fixture(t);
  assert.equal((await f.request('/api/browse')).status, 401);
  const cookie = await f.login();
  await mkdir(join(f.cwd, 'proyectos'));
  await writeFile(join(f.cwd, 'notas.txt'), 'contenido privado');
  const res = await f.request(`/api/browse?path=${encodeURIComponent(f.cwd)}`, { cookie });
  assert.equal(res.status, 200);
  const body = await res.json();
  // Folders come first so the ones that can be picked are within reach.
  assert.deepEqual(body.entries, [{ name: 'proyectos', dir: true }, { name: 'notas.txt', dir: false }]);
  assert.ok(!JSON.stringify(body).includes('contenido privado'), 'El explorador devolvió el contenido de un archivo.');
  assert.ok(body.roots.length > 0, 'No se devolvió ninguna unidad.');
  assert.equal((await f.request(`/api/browse?path=${encodeURIComponent(join(f.cwd, 'notas.txt'))}`, { cookie })).status, 400);
  assert.equal((await f.request(`/api/browse?path=${encodeURIComponent(join(f.cwd, 'no-existe'))}`, { cookie })).status, 404);
  assert.equal((await f.request('/api/browse?path=carpeta%2Frelativa', { cookie })).status, 400);
});

test('logout revokes open WebSockets without killing the PTY', async t => {
  const f = await fixture(t); const cookie = await f.login(); const s = await f.app.sessions.create({});
  const a = connect(f, s.id, cookie); await a.until(m => m.some(x => x.type === 'snapshot'));
  const closed = once(a.ws, 'close');
  await f.request('/api/logout', { cookie, method: 'POST', body: '{}' });
  assert.equal((await closed)[0], 4401);
  assert.equal(f.app.sessions.items.get(s.id).exited, false);
});

test('expired authentication cannot send terminal input', async t => {
  const f = await fixture(t); const cookie = await f.login(); const s = await f.app.sessions.create({});
  const a = connect(f, s.id, cookie); await a.until(m => m.some(x => x.type === 'snapshot'));
  f.app.auth.tokens.get(cookie.split('=')[1]).expires = Date.now() - 1;
  const closed = once(a.ws, 'close'); a.write('not-allowed\r');
  assert.equal((await closed)[0], 4401);
});

test('password rate limit and HTTPS configuration fail closed', async () => {
  const credentials = await hashPassword('test-password-only');
  assert.throws(() => validateConfig({ ...credentials, publicOrigin: 'http://192.168.1.5:3210' }), /HTTPS/);
  assert.throws(() => validateConfig({ ...credentials, publicOrigin: 'https://host.example/path' }), /origen/);
  assert.throws(() => validateConfig({ publicOrigin: 'https://host.example' }), /contraseña/);
  const config = validateConfig({ ...credentials, publicOrigin: 'https://host.example' });
  const auth = new Auth(config); assert.match(auth.cookie('test'), /Secure/);
  for (let i = 0; i < 10; i++) assert.equal((await auth.login('wrong')).status, 401);
  assert.equal((await auth.login('wrong')).status, 429);
});

test('Windows: PowerShell starts through ConPTY', { skip: process.platform !== 'win32', timeout: 15000 }, async t => {
  const f = await fixture(t);
  f.config.shell = 'powershell.exe';
  f.config.shellArgs = ['-NoLogo', '-NoProfile', '-Command', "Write-Output ('POCKET' + '_WINDOWS'); exit 0"];
  const cookie = await f.login(); const s = await f.app.sessions.create({});
  const a = connect(f, s.id, cookie);
  await a.until(m => text(m).includes('POCKET_WINDOWS'));
  await a.until(m => m.some(x => x.type === 'exit' || (x.type === 'snapshot' && x.exited)));
});
