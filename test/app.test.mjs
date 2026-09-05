import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
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
  t.after(async () => { await app.close(); await rm(cwd, { recursive: true, force: true }); });
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
