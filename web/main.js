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
let probeTimer = null, hasMore = false, historyPending = false;

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
// `action` añade un botón dentro del propio aviso: si el aviso pide hacer algo,
// lo suyo es poder hacerlo ahí mismo y no ir a buscarlo.
function notice(text, action = null) {
  clearTimeout(noticeTimer);
  const caja = $('notice');
  caja.replaceChildren(document.createTextNode(text));
  if (action) {
    const boton = document.createElement('button');
    boton.type = 'button'; boton.className = 'notice-action'; boton.textContent = action.label;
    boton.onclick = () => { caja.hidden = true; clearTimeout(noticeTimer); action.run(); };
    caja.append(boton);
  }
  caja.hidden = false;
  noticeTimer = setTimeout(() => { caja.hidden = true; resize(); }, action ? 12_000 : 6000);
  resize();
}
function viewport() {
  const v = window.visualViewport;
  document.documentElement.style.setProperty('--app-height', `${v?.height ?? innerHeight}px`);
  document.documentElement.style.setProperty('--app-top', `${v?.offsetTop ?? 0}px`);
  resize();
}
let resizeFrame;
// PowerShell lays its tables out for the width it is told it has, and quietly
// drops the columns on the right when they do not fit. Below this many columns
// `ls` stops showing the file names at all, which looks like a broken listing
// rather than a window that is too narrow.
const COMFORTABLE_COLS = 70;
let warnedNarrow = false;
function checkWidth() {
  if (term.cols >= COMFORTABLE_COLS) { warnedNarrow = false; return; }
  if (warnedNarrow) return;
  warnedNarrow = true;
  notice(
    `Solo caben ${term.cols} columnas. PowerShell recortará las tablas: en «ls» se pierden los nombres. Gira el móvil o reduce la letra.`,
    fontSize > 12 ? { label: 'Reducir la letra', run: () => setFont(fontSize - 2) } : null,
  );
}
function resize() {
  cancelAnimationFrame(resizeFrame);
  resizeFrame = requestAnimationFrame(() => {
    if (!opened || $('terminal').hidden || restoring) return;
    try {
      fit.fit();
      if (online && !exited) { send({ type: 'resize', cols: term.cols, rows: term.rows }); checkWidth(); }
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
  generation++; clearTimeout(retryTimer); clearTimeout(probeTimer); probeTimer = null;
  online = false; restoring = false; historyPending = false;
  const old = socket; socket = null; old?.close();
}
// Rebuild the connection without clearing the screen first. The snapshot
// handler replaces the contents once it arrives, so the text stays readable
// throughout instead of blanking on every return to the foreground.
function reattach() {
  if (locked || !selected || stopRetry) return;
  disconnect(); retryCount = 0; connect();
}
// A mobile browser can freeze a socket without ever firing close, so an open
// readyState proves nothing. Ask for a round trip and only rebuild the
// connection when the answer fails to arrive.
function probe() {
  if (locked || !selected || stopRetry || probeTimer) return;
  if (!online || socket?.readyState !== WebSocket.OPEN) { reattach(); return; }
  if (send({ type: 'ping' })) probeTimer = setTimeout(() => { probeTimer = null; reattach(); }, 2500);
  else reattach();
}
function requestHistory() {
  if (!hasMore || historyPending || restoring || !online) return;
  historyPending = send({ type: 'history' });
  if (historyPending) notice('Cargando el historial anterior…');
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
  $('terminal').hidden = true; $('empty-state').hidden = false; pad.hidden = true;
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
  $('empty-state').hidden = true; $('terminal').hidden = false; pad.hidden = !$('tools').hidden;
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
      // How far up the user had scrolled, so the same text stays on screen
      // after the snapshot replaces the buffer.
      const fromBottom = term.buffer.active.baseY - term.buffer.active.viewportY;
      restoring = true; exited = message.exited;
      hasMore = Boolean(message.hasMore); historyPending = false;
      term.reset(); term.resize(message.cols, message.rows);
      term.write(message.data, () => {
        if (mine !== generation) return;
        restoring = false; online = true; retryCount = 0;
        if (fromBottom > 0) term.scrollLines(-Math.min(fromBottom, term.buffer.active.baseY));
        status(exited ? `Finalizada · código ${message.exitCode}` : 'Conectada', exited ? '' : 'online');
        resize();
      });
    } else if (message.type === 'output') term.write(message.data);
    else if (message.type === 'pong') { clearTimeout(probeTimer); probeTimer = null; }
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
      // Solo un cliente por terminal, o dos navegadores se pelearían por el
      // tamaño y las pulsaciones. Recuperarla tiene que ser un toque, no un
      // paseo por los ajustes.
      stopRetry = true; status('Abierta en otro sitio', 'error');
      notice('Esta terminal se ha abierto en otra pestaña o en otro dispositivo. Solo puede usarse desde un sitio a la vez.',
        { label: 'Recuperarla aquí', run: () => { if (selected) choose(selected); } });
      return;
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

async function submitLogin() {
  if ($('login-button').disabled) return;
  $('login-button').disabled = true; $('login-error').textContent = '';
  try { await api('/login', { method: 'POST', body: JSON.stringify({ password: $('password').value }) }); $('password').value = ''; await unlock(); }
  catch (error) { $('login-error').textContent = error.message; }
  finally { $('login-button').disabled = false; }
}
$('login-form').addEventListener('submit', event => { event.preventDefault(); submitLogin(); });
// La contraseña llega por Telegram y se trae en el portapapeles, así que pegarla
// ya es toda la intención: no hace falta un segundo toque en Entrar.
$('paste-password').onclick = async () => {
  try {
    const texto = (await navigator.clipboard.readText()).trim();
    if (!texto) { $('login-error').textContent = 'El portapapeles está vacío.'; return; }
    $('password').value = texto;
    submitLogin();
  } catch {
    $('login-error').textContent = 'El navegador no deja leer el portapapeles. Mantén pulsado el campo y pega a mano.';
    $('password').focus();
  }
};
$('password').addEventListener('paste', () => { setTimeout(() => { if ($('password').value.trim()) submitLogin(); }, 0); });

$('session-select').addEventListener('change', event => { if (event.target.value) choose(event.target.value); });

// Carpetas recientes: abrir una terminal donde ya estuviste es lo más común, y
// teclear una ruta de Windows en un móvil es lo más incómodo que hay.
const RECENT_KEY = 'pocket-recent-cwds';
function recentCwds() {
  try { return JSON.parse(readPref(RECENT_KEY, '[]')).filter(p => typeof p === 'string').slice(0, 5); }
  catch { return []; }
}
function rememberCwd(path) {
  const lista = [path, ...recentCwds().filter(p => p !== path)].slice(0, 5);
  savePref(RECENT_KEY, JSON.stringify(lista));
}
function paintRecents() {
  const caja = $('recent-cwds'), lista = recentCwds();
  caja.replaceChildren();
  caja.hidden = !lista.length;
  for (const path of lista) {
    const boton = document.createElement('button');
    boton.type = 'button';
    boton.textContent = path.split(/[\\/]/).filter(Boolean).at(-1) || path;
    boton.title = path;
    boton.onclick = () => { $('session-cwd').value = path; };
    caja.append(boton);
  }
}
function newDialog() {
  $('session-cwd').value = recentCwds()[0] ?? state?.defaultCwd ?? '';
  $('new-error').textContent = '';
  paintRecents();
  $('new-dialog').showModal();
}
$('new-button').onclick = newDialog; $('first-terminal').onclick = newDialog;
$('new-form').addEventListener('submit', async event => {
  event.preventDefault(); $('create-button').disabled = true; $('new-error').textContent = '';
  try {
    const cwd = $('session-cwd').value;
    const s = await api('/sessions', { method: 'POST', body: JSON.stringify({ cwd, cols: opened ? term.cols : 40, rows: opened ? term.rows : 24 }) });
    rememberCwd(s.cwd || cwd);
    state.sessions.push(s); $('new-dialog').close(); choose(s.id);
  } catch (error) { $('new-error').textContent = error.message; }
  finally { $('create-button').disabled = false; }
});
// Explorador de carpetas. It only lists names so the folder for a new terminal
// can be picked by tapping instead of typing a Windows path on a phone.
let browsePath = null, browseRoots = [], browseSep = '\\';
function browseRow(icon, label, open) {
  const item = document.createElement('li'), button = document.createElement('button');
  const mark = document.createElement('span'), name = document.createElement('span');
  button.type = 'button';
  mark.className = 'entry-icon'; mark.textContent = icon; mark.setAttribute('aria-hidden', 'true');
  name.className = 'entry-name'; name.textContent = label;
  button.append(mark, name);
  if (open) button.onclick = open; else button.disabled = true;
  item.append(button);
  return item;
}
async function openFolder(path, fallback = true) {
  $('browse-error').textContent = ''; $('browse-path').textContent = 'Cargando…';
  $('browse-pick').disabled = true; $('browse-up').disabled = true; $('browse-list').replaceChildren();
  try {
    const data = await api(`/browse?path=${encodeURIComponent(path ?? '')}`);
    browsePath = data.path; browseRoots = data.roots; browseSep = data.sep;
    $('browse-path').textContent = data.path;
    $('browse-pick').disabled = false;
    $('browse-up').disabled = !data.parent;
    $('browse-up').onclick = () => { if (data.parent) openFolder(data.parent); };
    const child = name => data.path + (data.path.endsWith(browseSep) ? '' : browseSep) + name;
    const rows = data.entries.map(e => browseRow(e.dir ? '📁' : '📄', e.name, e.dir ? () => openFolder(child(e.name)) : null));
    if (data.truncated) rows.push(browseRow('…', 'Hay más elementos de los que caben aquí', null));
    if (!rows.length) rows.push(browseRow('·', 'Esta carpeta está vacía', null));
    $('browse-list').replaceChildren(...rows);
  } catch (error) {
    // A path typed by hand may not exist; show the default folder instead of nothing.
    if (fallback && path) { await openFolder('', false); $('browse-error').textContent = error.message; return; }
    $('browse-path').textContent = browsePath ?? ''; $('browse-error').textContent = error.message;
  }
}
$('browse-roots').onclick = () => {
  browsePath = null;
  $('browse-error').textContent = ''; $('browse-path').textContent = 'Unidades de tu ordenador';
  $('browse-pick').disabled = true; $('browse-up').disabled = true;
  const rows = browseRoots.map(root => browseRow('💾', root, () => openFolder(root)));
  $('browse-list').replaceChildren(...(rows.length ? rows : [browseRow('·', 'No se han encontrado unidades', null)]));
};
$('browse-button').onclick = () => {
  $('browse-dialog').showModal();
  openFolder($('session-cwd').value.trim() || state?.defaultCwd || '');
};
$('browse-pick').onclick = () => {
  if (!browsePath) return;
  $('session-cwd').value = browsePath;
  $('browse-dialog').close();
};
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
// Full-screen programs ask for the application form of the cursor keys.
const cursorKey = name => term.modes.applicationCursorKeysMode ? keys[name].replace('[', 'O') : keys[name];
document.querySelectorAll('[data-key]').forEach(button => {
  button.addEventListener('pointerdown', event => event.preventDefault());
  button.onclick = () => {
    setCtrl(false);
    const name = button.dataset.key;
    input(['up', 'down', 'left', 'right'].includes(name) ? cursorKey(name) : keys[name]);
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
// Mando de desplazamiento. Dragging a finger over the text cannot work
// everywhere: xterm.js 6 ships no touch scrolling at all, and a program that
// turns on mouse reporting (Claude Code does) keeps every touch that lands on
// the terminal. A control living outside the terminal works in every program.
const pad = $('scroll-pad'), knob = $('scroll-knob');
const PAD_DEADZONE = 5; // px around the centre that move nothing
const MIN_RATE = 2;     // lines per second just outside the dead zone
const MAX_RATE = 90;    // lines per second at full travel
const HOLD_BOOST = 1.6; // extra speed once the knob is held away from centre
const HOLD_RAMP = 900;  // ms taken to reach that extra speed
let padPointer = null, padStart = 0, padTravel = 44, padOffset = 0;
let padFrame = 0, padLast = 0, padHeldSince = 0, padDebt = 0;

// One push has to move three different things. xterm scrolls its own buffer,
// a program holding the mouse expects wheel notches, and a full-screen program
// without the mouse only understands cursor and page keys.
function scrollMode() {
  if (term.buffer.active.type !== 'alternate') return 'buffer';
  return term.modes.mouseTrackingMode === 'none' ? 'keys' : 'wheel';
}
function padSend(mode, forward, page) {
  if (mode === 'buffer') { term.scrollLines(forward ? 1 : -1); return; }
  if (mode === 'wheel') {
    // SGR wheel report: button 65 moves towards the end of the text, 64 back.
    const col = Math.max(1, Math.round(term.cols / 2)), row = Math.max(1, Math.round(term.rows / 2));
    input(`\x1b[<${forward ? 65 : 64};${col};${row}M`);
    return;
  }
  input(page ? (forward ? '\x1b[6~' : '\x1b[5~') : cursorKey(forward ? 'down' : 'up'));
}
function padTick(now) {
  padFrame = requestAnimationFrame(padTick);
  const seconds = Math.min(0.1, (now - padLast) / 1000); padLast = now;
  if (!padOffset) { padDebt = 0; return; }
  const mode = scrollMode();
  if (mode !== 'buffer' && (!online || exited)) return;
  const boost = 1 + (HOLD_BOOST - 1) * Math.min(1, (now - padHeldSince) / HOLD_RAMP);
  const strength = Math.abs(padOffset);
  const rate = (MIN_RATE + (MAX_RATE - MIN_RATE) * strength * strength) * boost;
  const page = mode === 'keys' && rate > term.rows;
  const unit = mode === 'wheel' ? 3 : page ? Math.max(1, term.rows - 2) : 1;
  padDebt += rate * seconds;
  let guard = 40;
  while (padDebt >= unit && guard--) { padDebt -= unit; padSend(mode, padOffset > 0, page); }
  if (mode === 'buffer' && padOffset < 0 && term.buffer.active.viewportY === 0) requestHistory();
}
function padSet(y) {
  const travel = Math.max(-padTravel, Math.min(padTravel, y));
  knob.style.transform = `translateY(${travel}px)`;
  const reach = Math.max(1, padTravel - PAD_DEADZONE);
  const size = Math.abs(travel) <= PAD_DEADZONE ? 0 : Math.min(1, (Math.abs(travel) - PAD_DEADZONE) / reach);
  // Pushing the knob up moves the view towards the end of the text, the same
  // direction a finger drag gives in any mobile application.
  const next = travel < 0 ? size : -size;
  if (Boolean(next) !== Boolean(padOffset)) padHeldSince = performance.now();
  padOffset = next;
}
function padRelease(event) {
  if (event.pointerId !== padPointer) return;
  padPointer = null; delete pad.dataset.active;
  padSet(0); padDebt = 0;
  cancelAnimationFrame(padFrame); padFrame = 0;
}
pad.addEventListener('pointerdown', event => {
  event.preventDefault();
  if (!selected || padPointer !== null) return;
  padPointer = event.pointerId; pad.setPointerCapture(padPointer);
  padTravel = Math.max(20, (pad.clientHeight - knob.clientHeight) / 2 - 4);
  padStart = event.clientY; padDebt = 0; padLast = performance.now(); padHeldSince = padLast;
  pad.dataset.active = 'true'; padSet(0);
  cancelAnimationFrame(padFrame); padFrame = requestAnimationFrame(padTick);
});
pad.addEventListener('pointermove', event => {
  if (event.pointerId !== padPointer) return;
  event.preventDefault(); padSet(event.clientY - padStart);
});
pad.addEventListener('pointerup', padRelease);
pad.addEventListener('pointercancel', padRelease);

const heartbeat = setInterval(() => { if (online) send({ type: 'ping' }); }, 10_000);
window.addEventListener('pagehide', () => { clearTimeout(retryTimer); socket?.close(); });
window.addEventListener('pageshow', event => { if (event.persisted) probe(); });
window.addEventListener('online', probe);
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') probe(); });
window.addEventListener('beforeunload', () => clearInterval(heartbeat));

// Panel de herramientas. Todo lo que no es la terminal vive aquí, de modo que
// con el panel cerrado la pantalla es terminal y teclado y nada más. Se queda
// abierto entre pulsaciones: las flechas y Tab se usan en tandas, y reabrirlo
// para cada una sería peor que la barra fija que había antes.
const tools = $('tools'), toolsTab = $('tools-tab');
function showTools(open) {
  tools.hidden = !open;
  toolsTab.setAttribute('aria-expanded', String(open));
  toolsTab.setAttribute('aria-label', open ? 'Cerrar herramientas' : 'Abrir herramientas');
  toolsTab.firstElementChild.textContent = open ? '›' : '‹';
  // El panel se superpone en lugar de encoger la terminal: redimensionarla
  // haría que el programa en marcha repintase toda la pantalla cada vez.
  pad.hidden = open || !selected;
}
toolsTab.addEventListener('pointerdown', event => event.preventDefault());
toolsTab.onclick = () => showTools(tools.hidden);

// Atajos a comandos: escribir `claude` en un teclado de móvil, cada vez que se
// abre una terminal, es de las cosas que más se repiten.
for (const boton of document.querySelectorAll('[data-run]')) {
  boton.addEventListener('pointerdown', event => event.preventDefault());
  boton.onclick = () => { setCtrl(false); input(`${boton.dataset.run}\r`); };
}

// Volver al final del texto. Solo aparece cuando hay algo por debajo, para no
// poner un botón que no hace nada la mayor parte del tiempo.
const toBottom = $('to-bottom');
function checkBottom() {
  const b = term.buffer.active;
  toBottom.hidden = $('terminal').hidden || b.type === 'alternate' || b.viewportY >= b.baseY;
}
toBottom.addEventListener('pointerdown', event => event.preventDefault());
toBottom.onclick = () => { term.scrollToBottom(); checkBottom(); };
term.onScroll(checkBottom);
term.onRender(checkBottom);
// Tocar la terminal la devuelve al frente; el panel no estorba más de la cuenta.
$('terminal-area').addEventListener('pointerdown', () => { if (!tools.hidden) showTools(false); });
showTools(false);
// Keeps a copy of the page so the app opens instead of showing a network
// error when there is no connection. The terminal still needs the server.
navigator.serviceWorker?.register('/sw.js').catch(() => {});
setFont(fontSize); viewport();
unlock().catch(error => { if (!locked || $('login-view').hidden) { showLogin(); $('login-error').textContent = error.message; } });
