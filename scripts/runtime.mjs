import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { open, readFile, writeFile, rm, stat, mkdir } from 'node:fs/promises';
import { randomBytes, randomInt } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { hashPassword } from '../server/auth.mjs';
import { configPath, projectRoot, validateConfig } from '../server/config.mjs';

const dataDir = resolve(projectRoot, '.pocket-terminal');
export const telegramPath = resolve(dataDir, 'telegram.json');
export const statePath = resolve(dataDir, 'state.json');
export const botLogPath = resolve(dataDir, 'bot.log');
export const serverLogPath = resolve(dataDir, 'server.log');
export const tunnelLogPath = resolve(dataDir, 'tunnel.log');
export const botPidPath = resolve(dataDir, 'bot.json');
const tunnelsPath = resolve(dataDir, 'tunnels.json');
const controlPath = resolve(dataDir, 'control.json');
export const INSTALL_CLOUDFLARED = 'No encuentro cloudflared. Instálalo con:\n\n  New-Item -ItemType Directory -Force "$env:LOCALAPPDATA\\cloudflared"\n  Invoke-WebRequest -Uri "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe" -OutFile "$env:LOCALAPPDATA\\cloudflared\\cloudflared.exe" -UseBasicParsing';

// Ambiguous glyphs are painful to retype on a phone keyboard.
const ALPHABET = 'abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const newPassword = () => Array.from({ length: 24 }, () => ALPHABET[randomInt(ALPHABET.length)]).join('');

export async function readConfig() { return JSON.parse(await readFile(configPath, 'utf8')); }
export async function configPort() { try { return (await readConfig()).port ?? 3210; } catch { return 3210; } }
// One extra port next to the server: it serves the control panel and, by being
// bound at all, acts as the single-instance lock for the bot.
export const botLockPort = port => port + 1;

/* ---------- estado compartido entre el panel y el bot ---------- */

export async function readState() {
  try { return JSON.parse(await readFile(statePath, 'utf8')); } catch { return null; }
}
async function writeState(state) {
  await mkdir(dirname(statePath), { recursive: true, mode: 0o700 });
  await writeFile(statePath, JSON.stringify(state, null, 2) + '\n', { mode: 0o600 });
}
async function clearState() { await rm(statePath, { force: true }); }

// The control panel is served on the loopback address only, but any web page
// the user visits could still POST to it. A token that only the launcher knows
// keeps those requests out: a foreign page can neither read it nor set the
// header that carries it.
export async function writeControlToken() {
  const token = randomBytes(24).toString('hex');
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  await writeFile(controlPath, JSON.stringify({ token }), { mode: 0o600 });
  return token;
}
export async function readControlToken() {
  try { return JSON.parse(await readFile(controlPath, 'utf8')).token || null; } catch { return null; }
}

export async function writeBotPid() {
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  await writeFile(botPidPath, JSON.stringify({ pid: process.pid }), { mode: 0o600 });
}
export async function readBotPid() {
  try { return JSON.parse(await readFile(botPidPath, 'utf8')).pid ?? null; } catch { return null; }
}

export function alive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
}

export function portBusy(port) {
  return new Promise(done => {
    const probe = createServer();
    probe.once('error', () => done(true));
    probe.once('listening', () => probe.close(() => done(false)));
    probe.listen(port, '127.0.0.1');
  });
}

// Synchronous on purpose: a control panel must not report something as stopped
// before it actually is.
//
// `process.kill` takes about a millisecond here while spawning taskkill takes
// thirty seconds, so taskkill is only the fallback. Killing the server alone is
// enough: ConPTY closes the PowerShell processes of every open terminal as soon
// as their console goes away, verified by counting them before and after.
export function stopProcess(pid) {
  if (!pid || !alive(pid)) return true;
  try { process.kill(pid); } catch {}
  if (!alive(pid)) return true;
  if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
  return !alive(pid);
}

/* ---------- Telegram ---------- */

export async function readTelegram() {
  try {
    const settings = JSON.parse(await readFile(telegramPath, 'utf8'));
    return settings.botToken && settings.chatId ? settings : null;
  } catch { return null; }
}

export async function telegramCall(botToken, method, payload) {
  const response = await fetch(`https://api.telegram.org/bot${botToken}/${method}`, payload
    ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }
    : undefined);
  const body = await response.json();
  if (!body.ok) throw new Error(body.description);
  return body.result;
}

export async function say(settings, text, extra = {}) {
  // Previews would make Telegram's servers fetch the tunnel themselves.
  return telegramCall(settings.botToken, 'sendMessage', { chat_id: settings.chatId, text, disable_web_page_preview: true, ...extra });
}

// Two messages on purpose: the link stays tappable, and the password sits alone
// in a code block that Telegram copies with a single tap.
export async function announce(settings, url, password) {
  await say(settings, `Pocket Terminal en marcha\n\n${url}`);
  await say(settings, `\`${password}\``, { parse_mode: 'MarkdownV2' });
}

/* ---------- arranque y parada ---------- */

export async function cloudflaredPath() {
  const bundled = process.env.LOCALAPPDATA && resolve(process.env.LOCALAPPDATA, 'cloudflared/cloudflared.exe');
  if (bundled) { try { await stat(bundled); return bundled; } catch {} }
  return process.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared';
}

export async function hasCloudflared() {
  const exe = await cloudflaredPath();
  if (exe.includes('\\') || exe.includes('/')) return true;
  return new Promise(done => {
    const probe = spawn(exe, ['--version'], { stdio: 'ignore', windowsHide: true });
    probe.on('error', () => done(false));
    probe.on('exit', code => done(code === 0));
  });
}

// Detached so the tunnel and the server outlive the window that started them.
// Their output goes to a file because there is no parent left to read a pipe.
async function spawnDetached(command, args, logPath) {
  await mkdir(dirname(logPath), { recursive: true, mode: 0o700 });
  const handle = await open(logPath, 'w', 0o600);
  try {
    const child = spawn(command, args, { cwd: projectRoot, detached: true, windowsHide: true, stdio: ['ignore', handle.fd, handle.fd] });
    child.unref();
    return child;
  } finally { await handle.close(); }
}

async function waitForTunnelUrl(child, ms = 60_000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const log = await readFile(tunnelLogPath, 'utf8').catch(() => '');
    const found = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/.exec(log);
    if (found) return found[0];
    if (!alive(child.pid)) throw new Error(`cloudflared se ha cerrado.\n${log.slice(-600)}`);
    await delay(250);
  }
  throw new Error('El túnel no dio una dirección en 60 segundos.');
}

async function waitForServer(port, ms = 25_000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    try { await fetch(`http://127.0.0.1:${port}/`); return true; } catch {}
    await delay(300);
  }
  return false;
}

export async function startService({ localOnly = false, log = () => {} } = {}) {
  const current = await status();
  if (current.server.running) return { ...current, alreadyRunning: true };

  const raw = await readConfig();
  const port = raw.port ?? 3210;
  try { await stat(resolve(projectRoot, 'dist/index.html')); }
  catch { throw new Error('Falta la web compilada. Recompílala desde el panel o con: npm run build'); }
  if (await portBusy(port)) throw new Error(`Algo ocupa el puerto ${port} y no lo he arrancado yo. Ciérralo antes de seguir.`);

  let url = `http://localhost:${port}`;
  let tunnelPid = null;
  if (!localOnly) {
    if (!await hasCloudflared()) throw new Error(INSTALL_CLOUDFLARED);
    log('Abriendo el túnel de Cloudflare…');
    const exe = await cloudflaredPath();
    const tunnel = await spawnDetached(exe, ['tunnel', '--url', `http://127.0.0.1:${port}`], tunnelLogPath);
    try { url = await waitForTunnelUrl(tunnel); }
    catch (error) { stopProcess(tunnel.pid); throw error; }
    tunnelPid = tunnel.pid;
    await rememberTunnel(tunnelPid);
  }

  const password = newPassword();
  Object.assign(raw, await hashPassword(password), { publicOrigin: url });
  validateConfig(raw);
  await writeFile(configPath, JSON.stringify(raw, null, 2) + '\n', { mode: 0o600 });

  log('Arrancando Pocket Terminal…');
  const server = await spawnDetached(process.execPath, [resolve(projectRoot, 'server/index.mjs')], serverLogPath);
  if (!await waitForServer(port)) {
    const serverLog = await readFile(serverLogPath, 'utf8').catch(() => '');
    stopProcess(server.pid); stopProcess(tunnelPid);
    await clearState();
    throw new Error(`Pocket Terminal no respondió.\n${serverLog.slice(-600)}`);
  }

  const state = { serverPid: server.pid, tunnelPid, url, password, localOnly, startedAt: new Date().toISOString() };
  await writeState(state);
  return { ...await status(), alreadyRunning: false };
}

export async function stopService() {
  const state = await readState();
  const wasRunning = Boolean(state && alive(state.serverPid));
  if (state) { stopProcess(state.serverPid); stopProcess(state.tunnelPid); }
  for (const pid of await strayTunnels()) stopProcess(pid);
  await clearState();
  const port = await configPort();
  // Binding is cheap, so poll that first; Windows takes a moment to hand the
  // port back even after the process is gone.
  for (let intento = 0; intento < 15 && await portBusy(port); intento++) await delay(200);
  // Still taken means a server nobody tracked. Looking up its owner costs a
  // netstat call, so it only happens in that rare case, never in the loop.
  if (await portBusy(port)) {
    const owner = await portOwner(port);
    if (owner) {
      stopProcess(owner);
      for (let intento = 0; intento < 10 && await portBusy(port); intento++) await delay(200);
    }
  }
  return wasRunning || !(await portBusy(port));
}

// A tunnel left running without a server behind it still holds a public address
// open, so the panel has to see it and be able to close it.
//
// The list is kept in a file instead of asking Windows for it: `tasklist` hangs
// forever inside a nested ConPTY console, which is exactly where the panel runs
// when it is opened from Pocket Terminal.cmd.
async function readTunnelPids() {
  try { return JSON.parse(await readFile(tunnelsPath, 'utf8')).filter(pid => alive(pid)); }
  catch { return []; }
}
async function rememberTunnel(pid) {
  const pids = [...new Set([...await readTunnelPids(), pid])];
  await writeFile(tunnelsPath, JSON.stringify(pids), { mode: 0o600 });
}
export async function strayTunnels() {
  const state = await readState();
  const mine = state?.tunnelPid ?? null;
  const pids = (await readTunnelPids()).filter(pid => pid !== mine);
  await writeFile(tunnelsPath, JSON.stringify(mine ? [...pids, mine] : pids), { mode: 0o600 }).catch(() => {});
  return pids;
}

// Only used to clean up a server that is listening without a state file.
export async function portOwner(port) {
  if (process.platform !== 'win32') return null;
  return new Promise(done => {
    const child = spawn('netstat', ['-ano', '-p', 'TCP'], { windowsHide: true });
    let out = '';
    child.stdout.on('data', d => { out += d; });
    child.on('error', () => done(null));
    child.on('exit', () => {
      const line = out.split('\n').find(l => /LISTEN/i.test(l) && new RegExp(`[:.]${port}\\s`).test(l));
      const pid = line && Number(line.trim().split(/\s+/).at(-1));
      done(pid && pid !== process.pid ? pid : null);
    });
  });
}

/* ---------- diagnóstico ---------- */

export async function status() {
  const state = await readState();
  const port = await configPort();
  const serverRunning = Boolean(state && alive(state.serverPid));
  const botRunning = await portBusy(botLockPort(port));
  const botPid = botRunning ? await readBotPid() : null;
  // Something listening on the port without a state file: a leftover server
  // from a previous run. The panel has to show it instead of pretending all is
  // well, because it blocks every later start.
  const orphan = !serverRunning && await portBusy(port) ? await portOwner(port) : null;
  const strays = await strayTunnels();
  return {
    port,
    server: { running: serverRunning, pid: state?.serverPid ?? null },
    tunnel: { running: Boolean(state?.tunnelPid && alive(state.tunnelPid)), pid: state?.tunnelPid ?? null },
    bot: { running: botRunning, pid: botPid },
    orphan,
    strayTunnels: strays,
    url: serverRunning ? state.url : null,
    password: serverRunning ? state.password : null,
    localOnly: state?.localOnly ?? null,
    startedAt: serverRunning ? state.startedAt : null,
  };
}
