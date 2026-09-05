import { randomUUID } from 'node:crypto';
import { realpath, stat } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import pty from 'node-pty';
import headless from '@xterm/headless';
import serialize from '@xterm/addon-serialize';

const { Terminal } = headless;
const { SerializeAddon } = serialize;
export function dimensions(cols, rows) {
  if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols < 2 || cols > 400 || rows < 1 || rows > 200) {
    throw new Error('Dimensiones de terminal inválidas.');
  }
  return { cols, rows };
}

// node-pty 1.1.0 with `useConptyDll` only disposes its conout worker thread if
// more output arrives after `kill()`, and never when the shell exits on its own.
// The orphaned worker leaks per session and keeps the Node event loop alive, so
// release it explicitly. Draining still happens inside node-pty's own dispose.
export function releaseConoutWorker(processPty) {
  try { processPty?._agent?._conoutSocketWorker?.dispose(); } catch {}
}

export class Sessions {
  constructor(config) { this.config = config; this.items = new Map(); this.creating = 0; }
  list() { return [...this.items.values()].map(s => this.info(s)); }
  info(s) { return { id: s.id, name: s.name, cwd: s.cwd, createdAt: s.createdAt, exited: s.exited, exitCode: s.exitCode, cols: s.term.cols, rows: s.term.rows }; }
  async create({ cwd = this.config.defaultCwd, cols = 80, rows = 24, name = '' } = {}) {
    if (this.items.size + this.creating >= this.config.maxSessions) throw new Error('Límite de 8 sesiones. Cierra una antes de crear otra.');
    dimensions(cols, rows);
    if (typeof cwd !== 'string' || !isAbsolute(cwd)) throw new Error('Introduce una ruta absoluta de tu ordenador.');
    if (typeof name !== 'string' || name.length > 60) throw new Error('Nombre inválido (máximo 60 caracteres).');
    this.creating++;
    let term;
    try {
      try { cwd = await realpath(cwd); }
      catch { throw new Error('No se encuentra esa carpeta en tu ordenador.'); }
      if (!(await stat(cwd)).isDirectory()) throw new Error('La ruta no es una carpeta.');
      term = new Terminal({ cols, rows, scrollback: 3000, allowProposedApi: true });
      const serializer = new SerializeAddon();
      term.loadAddon(serializer);
      const env = Object.fromEntries(Object.entries(process.env).filter(([, value]) => typeof value === 'string'));
      env.TERM = 'xterm-256color';
      env.COLORTERM = 'truecolor';
      // Ship the same ConPTY implementation across Windows versions. The OS
      // implementation's process-list teardown can race early session closure.
      const processPty = pty.spawn(this.config.shell, this.config.shellArgs, { cols, rows, cwd, env, name: 'xterm-256color', ...(process.platform === 'win32' ? { useConptyDll: true } : {}) });
      let resolveExit;
      const closed = new Promise(resolve => { resolveExit = resolve; });
      const s = { id: randomUUID(), name: name.trim() || `Terminal ${this.items.size + 1}`, cwd, createdAt: new Date().toISOString(), term, serializer, pty: processPty, exited: false, client: null, queue: Promise.resolve(), pending: [], pendingChars: 0, flushTimer: null, closed };
      this.items.set(s.id, s);
      // Answer terminal queries while detached so interactive programs can start
      // without waiting for a browser. Attached clients answer their own queries.
      term.onData(data => {
        if (!s.exited && s.client?.readyState !== 1) { try { processPty.write(data); } catch {} }
      });
      // ConPTY hands over output in ~37-byte pieces. Parsing and forwarding each
      // piece on its own is orders of magnitude slower than doing it once per
      // batch, so gather a frame's worth before touching the terminal or the
      // socket. Parsing stays serialized so snapshots and live output cannot
      // race or duplicate text.
      s.flush = () => {
        clearTimeout(s.flushTimer); s.flushTimer = null;
        if (!s.pending.length) return;
        const data = s.pending.join(''); s.pending = [];
        this.enqueue(s, async () => {
          await new Promise(resolve => term.write(data, resolve));
          this.send(s.client, { type: 'output', data });
          s.pendingChars -= data.length;
          if (!s.exited && s.pendingChars < 256 * 1024) processPty.resume();
        });
      };
      processPty.onData(data => {
        s.pending.push(data);
        s.pendingChars += data.length;
        if (s.pendingChars > 1024 * 1024) processPty.pause();
        if (!s.flushTimer) s.flushTimer = setTimeout(s.flush, 8);
      });
      processPty.onExit(({ exitCode }) => {
        s.exited = true; s.exitCode = exitCode;
        releaseConoutWorker(processPty);
        s.flush();
        this.enqueue(s, () => this.send(s.client, { type: 'exit', exitCode }));
        resolveExit();
      });
      return this.info(s);
    } catch (error) { term?.dispose(); throw error; }
    finally { this.creating--; }
  }
  enqueue(s, action) {
    s.queue = s.queue.then(() => s.disposed ? undefined : action()).catch(() => { s.client?.close(1011, 'Error de terminal'); });
    return s.queue;
  }
  send(ws, payload) {
    if (ws?.readyState !== 1) return;
    if (ws.bufferedAmount > 2 * 1024 * 1024) { ws.close(1013, 'Conexión lenta; vuelve a conectar'); return; }
    ws.send(JSON.stringify(payload));
  }
  attach(id, ws, authorized = () => true) {
    const s = this.items.get(id);
    if (!s) { ws.close(4404, 'La sesión ya no existe'); return; }
    ws.on('close', () => { if (s.client === ws) s.client = null; });
    ws.on('message', (raw, binary) => {
      if (!authorized()) { ws.close(4401, 'Vuelve a iniciar sesión'); return; }
      if (s.client !== ws || binary) return;
      try {
        const message = JSON.parse(raw.toString());
        if (message.type === 'input' && typeof message.data === 'string') {
          if (message.data.length > 32768) throw new Error('Entrada demasiado larga');
          this.enqueue(s, () => { if (!s.exited) s.pty.write(message.data); });
        } else if (message.type === 'resize') {
          const { cols, rows } = dimensions(message.cols, message.rows);
          this.enqueue(s, () => {
            if (s.exited) return;
            s.term.resize(cols, rows);
            s.pty.resize(cols, rows);
          });
        } else if (message.type !== 'ping') throw new Error('Mensaje inválido');
      } catch { ws.close(1008, 'Mensaje inválido'); }
    });
    s.flush?.();
    this.enqueue(s, () => {
      if (ws.readyState !== 1) return;
      if (s.client && s.client !== ws) s.client.close(4409, 'Sesión abierta en otro dispositivo');
      s.client = ws;
      this.send(ws, { type: 'snapshot', ...this.info(s), data: s.serializer.serialize({ scrollback: 3000 }) });
    });
  }
  async remove(id) {
    const s = this.items.get(id);
    if (!s) return false;
    this.items.delete(id);
    s.client?.close(4404, 'Sesión cerrada');
    if (!s.exited) {
      try { s.pty.kill(); } catch {}
      releaseConoutWorker(s.pty);
      let timer;
      // ConPTY shutdown is asynchronous; wait before releasing the mirror/cwd.
      await Promise.race([s.closed, new Promise(resolve => { timer = setTimeout(resolve, 3000); })]);
      clearTimeout(timer);
    }
    s.flush?.();
    await s.queue;
    s.disposed = true;
    clearTimeout(s.flushTimer);
    s.term.dispose();
    return true;
  }
  async close() { await Promise.all([...this.items.keys()].map(id => this.remove(id))); }
}
