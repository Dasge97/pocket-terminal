import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { projectRoot } from '../server/config.mjs';
import {
  announce, botLogPath, hasCloudflared, readTelegram, startService, status,
  stopProcess, stopService, strayTunnels, writeControlToken,
} from './runtime.mjs';

const TASK = 'PocketTerminalBot';
const pagePath = resolve(projectRoot, 'scripts/control.html');

function run(command, args) {
  return new Promise(done => {
    const child = spawn(command, args, { cwd: projectRoot, windowsHide: true });
    let out = '';
    child.stdout?.on('data', d => { out += d; });
    child.stderr?.on('data', d => { out += d; });
    child.on('error', error => done({ code: 1, out: error.message }));
    child.on('exit', code => done({ code: code ?? 1, out }));
  });
}

async function taskState() {
  if (process.platform !== 'win32') return 'sin soporte';
  const { code, out } = await run('schtasks', ['/Query', '/TN', TASK, '/FO', 'LIST']);
  if (code !== 0) return 'sin registrar';
  return /Deshabilitado|Disabled/i.test(out) ? 'registrada pero deshabilitada' : 'registrada';
}

async function fullStatus() {
  const now = await status();
  const telegram = await readTelegram();
  return {
    ...now,
    task: await taskState(),
    cloudflared: await hasCloudflared(),
    telegram: telegram ? { chatId: telegram.chatId } : null,
    web: await readFile(resolve(projectRoot, 'dist/index.html')).then(() => true, () => false),
    node: process.version,
  };
}

// Every action returns the fresh status, so the page never has to guess what
// changed and a stale view cannot survive a click.
const actions = {
  async start({ localOnly = false }) {
    const result = await startService({ localOnly });
    const telegram = await readTelegram();
    let aviso = 'Telegram no configurado.';
    if (telegram) {
      try { await announce(telegram, result.url, result.password); aviso = 'Enviado por Telegram.'; }
      catch (error) { aviso = `No se pudo enviar por Telegram: ${error.message}`; }
    }
    return { message: result.alreadyRunning ? `Ya estaba en marcha. ${aviso}` : `Arrancado. ${aviso}` };
  },
  async stop() {
    await stopService();
    const now = await status();
    if (now.server.running || now.orphan) throw new Error(`No he podido parar el proceso ${now.server.pid ?? now.orphan}.`);
    return { message: 'Detenido. Las terminales abiertas se han cerrado.' };
  },
  async restart({ localOnly = false }) {
    await stopService();
    return actions.start({ localOnly });
  },
  async announce() {
    const now = await status();
    if (!now.server.running) throw new Error('No hay nada en marcha que anunciar.');
    const telegram = await readTelegram();
    if (!telegram) throw new Error('Telegram no está configurado.');
    await announce(telegram, now.url, now.password);
    return { message: 'Enviado por Telegram.' };
  },
  async autostart({ enable }) {
    const script = enable ? 'Enable-BotAutostart.ps1' : 'Disable-BotAutostart.ps1';
    const { code, out } = await run('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', resolve(projectRoot, 'scripts', script)]);
    if (code !== 0) throw new Error(out.trim() || 'No se pudo cambiar el arranque automático.');
    return { message: enable ? 'Arranque automático instalado.' : 'Arranque automático quitado.' };
  },
  async build() {
    // Vite directamente: en Windows, lanzar npm.cmd sin shell falla con EINVAL.
    const { code, out } = await run(process.execPath, [resolve(projectRoot, 'node_modules/vite/bin/vite.js'), 'build']);
    if (code !== 0) throw new Error(out.slice(-600) || 'No se pudo compilar la web.');
    return { message: 'Web recompilada.' };
  },
  async clearTunnels() {
    const sueltos = await strayTunnels();
    if (!sueltos.length) return { message: 'No había túneles sueltos.' };
    for (const pid of sueltos) stopProcess(pid);
    const quedan = await strayTunnels();
    if (quedan.length) throw new Error(`Siguen abiertos: ${quedan.join(', ')}.`);
    return { message: 'Túneles sueltos cerrados.' };
  },
  async log() {
    const texto = await readFile(botLogPath, 'utf8').catch(() => '');
    return { log: texto.split('\n').slice(-60).join('\n') || 'El registro está vacío.' };
  },
};

export async function startControlServer(port, { onStopBot } = {}) {
  const token = await writeControlToken();
  const allowedHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
  const page = await readFile(pagePath, 'utf8');

  const server = createServer(async (req, res) => {
    const send = (code, body, type = 'application/json; charset=utf-8') => {
      res.writeHead(code, {
        'Content-Type': type,
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
        'Referrer-Policy': 'no-referrer',
        'Content-Security-Policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
      });
      res.end(typeof body === 'string' ? body : JSON.stringify(body));
    };
    try {
      // No CORS headers anywhere, so a foreign page cannot read a reply either.
      if (!allowedHosts.has(req.headers.host)) return send(403, { error: 'Host no permitido.' });
      const url = new URL(req.url, `http://127.0.0.1:${port}`);

      if (req.method === 'GET' && url.pathname === '/') return send(200, page, 'text/html; charset=utf-8');

      if (req.headers['x-control-token'] !== token) return send(401, { error: 'Abre el panel desde Pocket Terminal.cmd.' });

      if (req.method === 'GET' && url.pathname === '/api/status') return send(200, await fullStatus());

      if (req.method === 'POST' && url.pathname === '/api/stopBot') {
        send(200, { message: 'Parando el bot.' });
        // Contestar antes de morir: si no, el navegador se queda esperando.
        setTimeout(() => onStopBot?.(), 150);
        return;
      }
      if (req.method === 'POST' && url.pathname.startsWith('/api/')) {
        const name = url.pathname.slice(5);
        const action = Object.hasOwn(actions, name) ? actions[name] : null;
        if (!action) return send(404, { error: 'Acción desconocida.' });
        let size = 0; const parts = [];
        for await (const part of req) {
          size += part.length;
          if (size > 4096) return send(413, { error: 'Petición demasiado grande.' });
          parts.push(part);
        }
        let body = {};
        if (parts.length) { try { body = JSON.parse(Buffer.concat(parts).toString('utf8')) ?? {}; } catch { return send(400, { error: 'JSON inválido.' }); } }
        try {
          const result = await action(body);
          return send(200, { ...result, status: await fullStatus() });
        } catch (error) { return send(200, { error: error.message, status: await fullStatus() }); }
      }
      return send(404, { error: 'Ruta no encontrada.' });
    } catch (error) {
      if (!res.headersSent) send(500, { error: error.message });
      else res.end();
    }
  });
  server.requestTimeout = 20_000;

  const listening = await new Promise(done => {
    server.once('error', () => done(false));
    server.once('listening', () => done(true));
    server.listen(port, '127.0.0.1');
  });
  if (!listening) return null;
  return { server, token, url: `http://127.0.0.1:${port}/?k=${token}` };
}
