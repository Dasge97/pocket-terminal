import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import './style.css';

const $ = id => document.getElementById(id);
const readPref = (key, fallback) => { try { return localStorage.getItem(key) ?? fallback; } catch { return fallback; } };
const savePref = (key, value) => { try { localStorage.setItem(key, String(value)); } catch {} };
let fontSize = Math.max(12, Math.min(28, Number(readPref('pocket-font', 17)) || 17));
const term = new Terminal({
  fontSize, lineHeight: 1.2, fontFamily: '"Cascadia Mono", "SFMono-Regular", Consolas, "Liberation Mono", monospace',
  cursorBlink: true, scrollback: 3000, scrollOnUserInput: true, allowProposedApi: false,
  theme: { background: '#10141c', foreground: '#e4eaf3', cursor: '#a3edb8', selectionBackground: '#46654f99', black: '#192230', red: '#ff929c', green: '#a3edb8', yellow: '#f2d58c', blue: '#8dbdff', magenta: '#d7acff', cyan: '#84d9df', white: '#e4eaf3', brightBlack: '#8e9eb7' },
});
const fit = new FitAddon(); term.loadAddon(fit);
let opened = false, socket = null, selected = null, state = null;
let online = false, restoring = false, exited = false, locked = true;
let retryTimer, noticeTimer, generation = 0, retryCount = 0, ctrl = false, stopRetry = false;

async function api(path, options = {}) {
  const res = await fetch(`/api${path}`, {
    credentials: 'same-origin', cache: 'no-store', ...options,
    headers: { 'Content-Type': 'application/json', ...options.headers },
  });
  const body = await res.json();
  if (!res.ok) {
    if (res.status === 401 && path !== '/login') showLogin();
    throw new Error(body.error || 'No se pudo completar la operación.');
  }
  return body;
}
function status(text, kind = '') {
  $('connection-status').textContent = text; $('connection-status').dataset.state = kind;
}
function notice(text) {
  clearTimeout(noticeTimer); $('notice').textContent = text; $('notice').hidden = false;
  noticeTimer = setTimeout(() => { $('notice').hidden = true; resize(); }, 6000); resize();
}
function viewport() {
  const v = window.visualViewport;
  document.documentElement.style.setProperty('--app-height', `${v?.height ?? innerHeight}px`);
  document.documentElement.style.setProperty('--app-top', `${v?.offsetTop ?? 0}px`);
  resize();
}
let resizeFrame;
function resize() {
  cancelAnimationFrame(resizeFrame);
  resizeFrame = requestAnimationFrame(() => {
    if (!opened || $('terminal').hidden || restoring) return;
    try {
      fit.fit();
      if (online && !exited) send({ type: 'resize', cols: term.cols, rows: term.rows });
    } catch { /* Hidden surfaces have no measurable cells yet. */ }
  });
}
window.visualViewport?.addEventListener('resize', viewport);
window.visualViewport?.addEventListener('scroll', viewport);
window.addEventListener('resize', viewport);
new ResizeObserver(resize).observe($('terminal-area'));

function send(message) {
  if (!online || socket?.readyState !== WebSocket.OPEN) return false;
  socket.send(JSON.stringify(message)); return true;
}
function input(data) {
  if (restoring) return;
  if (!online || exited) { notice(exited ? 'Esta terminal ha finalizado. Abre una nueva.' : 'Espera a que la terminal se conecte.'); return; }
  send({ type: 'input', data });
}
term.onData(data => {
  if (ctrl && data.length === 1) {
    const code = data.toUpperCase().charCodeAt(0);
    if (code >= 64 && code <= 95) data = String.fromCharCode(code - 64);
    setCtrl(false);
  }
  input(data);
});
function setCtrl(value) { ctrl = value; $('ctrl-key').setAttribute('aria-pressed', String(value)); }

function disconnect() {
  generation++; clearTimeout(retryTimer); online = false; restoring = false;
  const old = socket; socket = null; old?.close();
}
function showLogin() {
  locked = true; disconnect(); term.reset();
  for (const dialog of document.querySelectorAll('dialog[open]')) dialog.close();
  $('loading-view').hidden = true; $('workspace').hidden = true; $('login-view').hidden = false;
  $('password').value = ''; state = null;
}
function options() {
  const select = $('session-select'); select.replaceChildren();
  if (!state.sessions.length) select.append(new Option('Tus terminales', ''));
  for (const s of state.sessions) select.append(new Option(`${s.name}${s.exited ? ' · finalizada' : ''}`, s.id));
  select.value = selected ?? '';
}
async function refresh() { state = await api('/state'); options(); }
function empty() {
  disconnect(); selected = null; term.reset();
  $('terminal').hidden = true; $('empty-state').hidden = false;
  status('Sin terminales abiertas'); options();
}
async function unlock() {
  state = await api('/state'); locked = false;
  $('loading-view').hidden = true; $('login-view').hidden = true; $('workspace').hidden = false;
  const last = readPref('pocket-session', '');
  const session = state.sessions.find(s => s.id === selected || s.id === last) ?? state.sessions[0];
  if (session) choose(session.id); else empty();
  viewport();
}
function choose(id) {
  disconnect(); selected = id; retryCount = 0; stopRetry = false;
  savePref('pocket-session', id); options();
  $('empty-state').hidden = true; $('terminal').hidden = false;
  if (!opened) { term.open($('terminal')); opened = true; }
  term.reset(); fit.fit(); connect();
}
function connect() {
  if (locked || !selected || stopRetry) return;
  const mine = ++generation;
  const url = new URL(`/ws/${selected}`, location.href); url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const ws = new WebSocket(url); socket = ws; online = false;
  status(retryCount ? 'Reconectando…' : 'Conectando…');
  ws.onmessage = event => {
    if (mine !== generation) return;
    let message;
    try { message = JSON.parse(event.data); } catch { ws.close(); return; }
    if (message.type === 'snapshot') {
      restoring = true; exited = message.exited;
      term.reset(); term.resize(message.cols, message.rows);
      term.write(message.data, () => {
        if (mine !== generation) return;
        restoring = false; online = true; retryCount = 0;
        status(exited ? `Finalizada · código ${message.exitCode}` : 'Conectada', exited ? '' : 'online');
        resize();
      });
    } else if (message.type === 'output') term.write(message.data);
    else if (message.type === 'exit') {
      exited = true; status(`Finalizada · código ${message.exitCode}`);
      refresh().catch(() => {});
    }
  };
  ws.onclose = async event => {
    if (mine !== generation) return;
    online = false; restoring = false;
    if (event.code === 4401) { showLogin(); return; }
    if (event.code === 4409) {
      stopRetry = true; status('Abierta en otro dispositivo', 'error');
      notice('Puedes recuperarla desde Ajustes → Volver a conectar.'); return;
    }
    if (event.code === 4404) {
      try { await refresh(); const first = state.sessions[0]; if (first) choose(first.id); else empty(); }
      catch {} return;
    }
    status('Sin conexión · tu sesión sigue en el PC', 'error');
    clearTimeout(retryTimer);
    retryTimer = setTimeout(async () => {
      if (mine !== generation || locked || stopRetry) return;
      try {
        await refresh();
        if (mine !== generation || locked) return;
        if (!state.sessions.some(s => s.id === selected)) { empty(); notice('La sesión ya no existe. Es posible que se haya reiniciado el servidor.'); return; }
        connect();
      } catch { if (!locked && mine === generation) connect(); }
    }, Math.min(1000 * 2 ** retryCount++, 10_000));
  };
  ws.onerror = () => {}; // onclose handles connection failures without duplicate retries.
}

$('login-form').addEventListener('submit', async event => {
  event.preventDefault(); $('login-button').disabled = true; $('login-error').textContent = '';
  try { await api('/login', { method: 'POST', body: JSON.stringify({ password: $('password').value }) }); $('password').value = ''; await unlock(); }
  catch (error) { $('login-error').textContent = error.message; }
  finally { $('login-button').disabled = false; }
});
$('session-select').addEventListener('change', event => { if (event.target.value) choose(event.target.value); });
function newDialog() {
  $('session-cwd').value = state?.defaultCwd ?? ''; $('session-name').value = ''; $('new-error').textContent = '';
  $('new-dialog').showModal();
}
$('new-button').onclick = newDialog; $('first-terminal').onclick = newDialog;
$('new-form').addEventListener('submit', async event => {
  event.preventDefault(); $('create-button').disabled = true; $('new-error').textContent = '';
  try {
    const s = await api('/sessions', { method: 'POST', body: JSON.stringify({ cwd: $('session-cwd').value, name: $('session-name').value, cols: opened ? term.cols : 40, rows: opened ? term.rows : 24 }) });
    state.sessions.push(s); $('new-dialog').close(); choose(s.id);
  } catch (error) { $('new-error').textContent = error.message; }
  finally { $('create-button').disabled = false; }
});
document.querySelectorAll('[data-close]').forEach(button => { button.onclick = () => $(button.dataset.close).close(); });
$('settings-button').onclick = () => $('settings-dialog').showModal();
function setFont(value) {
  fontSize = Math.max(12, Math.min(28, Number(value)));
  term.options.fontSize = fontSize; savePref('pocket-font', fontSize);
  $('font-size').value = fontSize; $('font-value').textContent = `${fontSize} px`; resize();
}
$('font-size').oninput = event => setFont(event.target.value);
$('font-down').onclick = () => setFont(fontSize - 1); $('font-up').onclick = () => setFont(fontSize + 1);
$('reconnect-button').onclick = () => { $('settings-dialog').close(); if (selected) choose(selected); };
$('fullscreen-button').onclick = async () => {
  $('settings-dialog').close();
  try {
    if (document.fullscreenElement) await document.exitFullscreen();
    else if (document.documentElement.requestFullscreen) await document.documentElement.requestFullscreen();
    else notice('En Safari, añade esta web a la pantalla de inicio para abrirla como una app.');
  } catch { notice('Usa «Añadir a pantalla de inicio» en el navegador.'); }
};
$('logout-button').onclick = async () => {
  try { await api('/logout', { method: 'POST', body: '{}' }); showLogin(); }
  catch (error) { notice(error.message); }
};
$('end-button').onclick = () => {
  $('settings-dialog').close();
  if (selected) $('end-dialog').showModal();
};
$('end-form').onsubmit = async event => {
  event.preventDefault(); const id = selected;
  try {
    disconnect(); await api(`/sessions/${id}`, { method: 'DELETE' });
    $('end-dialog').close(); await refresh();
    if (state.sessions[0]) choose(state.sessions[0].id); else empty();
  } catch (error) { $('end-dialog').close(); notice(error.message); if (selected && !locked) choose(selected); }
};

const keys = { escape: '\x1b', tab: '\t', interrupt: '\x03', up: '\x1b[A', down: '\x1b[B', left: '\x1b[D', right: '\x1b[C', enter: '\r' };
document.querySelectorAll('[data-key]').forEach(button => {
  button.addEventListener('pointerdown', event => event.preventDefault());
  button.onclick = () => {
    setCtrl(false);
    let data = keys[button.dataset.key];
    if (['up', 'down', 'left', 'right'].includes(button.dataset.key) && term.modes.applicationCursorKeysMode) {
      data = data.replace('[', 'O');
    }
    input(data);
  };
});
$('ctrl-key').addEventListener('pointerdown', event => event.preventDefault());
$('ctrl-key').onclick = () => { setCtrl(!ctrl); if (online && !exited) term.focus(); };
$('keyboard-button').onclick = () => {
  if (!selected) return notice('Abre una terminal primero.');
  if (document.activeElement === term.textarea) term.blur(); else term.focus();
};
$('keyboard-button').addEventListener('pointerdown', event => event.preventDefault());
function compose(text = '') {
  if (!online || exited) return notice('Conecta una terminal activa primero.');
  $('compose-text').value = text; $('compose-dialog').showModal(); $('compose-text').focus();
}
$('compose-button').onclick = () => compose();
$('paste-button').onclick = async () => {
  try { compose(await navigator.clipboard.readText()); }
  catch { compose(); }
};
$('compose-form').onsubmit = event => {
  event.preventDefault();
  if (!online || exited) return notice('La terminal se ha desconectado. El texto sigue aquí.');
  setCtrl(false); term.paste($('compose-text').value); $('compose-text').value = ''; $('compose-dialog').close();
};
$('copy-button').onclick = async () => {
  const selection = term.getSelection();
  if (!selection) return notice('Selecciona texto en la terminal antes de copiarlo.');
  try { await navigator.clipboard.writeText(selection); notice('Texto copiado.'); }
  catch { notice('Usa la opción Copiar del menú de selección del navegador.'); }
};
const heartbeat = setInterval(() => { if (online) send({ type: 'ping' }); }, 10_000);
window.addEventListener('pagehide', () => { clearTimeout(retryTimer); socket?.close(); });
window.addEventListener('pageshow', event => { if (event.persisted && !locked && selected) choose(selected); });
window.addEventListener('online', () => { if (!online && !locked && selected && !stopRetry) choose(selected); });
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && !locked && selected && !stopRetry) {
    // Mobile browsers may freeze sockets without firing close; reattach to the same PTY.
    choose(selected);
  }
});
window.addEventListener('beforeunload', () => clearInterval(heartbeat));
setFont(fontSize); viewport();
unlock().catch(error => { if (!locked || $('login-view').hidden) { showLogin(); $('login-error').textContent = error.message; } });
