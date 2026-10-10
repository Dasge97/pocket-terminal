import { appendFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { startControlServer } from './control.mjs';
import { escribirEstadoKit } from './kit-estado.mjs';
import { alive, announce, BOTONERA, botLockPort, botLogPath, configPort, ownerCheck, readState, readTelegram, say, startService, status, stopService, telegramCall, writeBotPid } from './runtime.mjs';

// Started by the scheduled task there is no console to read, so keep a file.
const stamp = () => new Date().toLocaleString('es-ES');
const log = message => {
  const line = `[${stamp()}] ${message}`;
  console.log(line);
  // Síncrono a propósito: cuando ya hay otro vigilante, este proceso escribe y
  // sale de inmediato, y una escritura diferida se perdería por el camino.
  try { appendFileSync(botLogPath, line + '\n'); } catch {}
};

// The scheduled task retries every few minutes so a crashed bot comes back on
// its own. The control panel's port doubles as the single-instance lock: if it
// is already taken another bot is alive, and it frees itself if that one dies.
const port = await configPort();
const control = await startControlServer(botLockPort(port), {
  onStopBot: () => { log('parado desde el panel'); process.exit(0); },
});
if (!control) {
  log('ya hay otro vigilante escuchando; me retiro');
  process.exit(0);
}
await writeBotPid();
log(`panel de control escuchando en 127.0.0.1:${botLockPort(port)}`);

/* ---------- estado para el panel KitDani ---------- */
// Solo a partir de aquí: el proceso que se retira porque ya hay otro vigilante
// no debe pisar el estado del que sí está escuchando.
const kit = {
  arrancado: new Date(),
  telegram: 'conectando',      // conectando | conectado | sin-conexion | token-rechazado
  falloDesde: null,            // desde cuándo no hay conexión con Telegram
  ultimaOrden: null,           // { nombre, cuando, ok }
  ultimoError: null,           // { texto, cuando }
  ajenos: 0,                   // mensajes y botones de otros, rechazados
  terminal: null,              // { localOnly, startedAt } o null si está parado
  ocupado: false,
  sinDueño: false,
  alSalir: null,               // { estado, mensaje } si se sale por un motivo conocido
};
let ultimoContenido = '', ultimaEscritura = 0;
const LATIDO_MS = 2 * 60_000;
const SIN_CONEXION_AVISO_MS = 2 * 60_000;

const hora = fecha => {
  const d = new Date(fecha);
  const h = d.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' });
  return d.toDateString() === new Date().toDateString() ? h : `${d.toLocaleDateString('es-ES', { day: '2-digit', month: '2-digit' })} ${h}`;
};

// Lee state.json y comprueba el pid sin escribir nada: status() reescribe la
// lista de túneles y podría pisarse con un arranque en curso.
async function leerTerminal() {
  const state = await readState();
  return state && alive(state.serverPid) ? { localOnly: Boolean(state.localOnly), startedAt: state.startedAt } : null;
}

function calcularEstado() {
  const t = kit.terminal;
  const textoTerminal = t ? `En marcha${t.localOnly ? ' (solo local)' : ''} desde ${hora(t.startedAt)}` : 'Parado';
  const textoTelegram = {
    conectando: 'Conectando',
    conectado: 'Conectado',
    'sin-conexion': kit.falloDesde ? `Sin conexión desde ${hora(kit.falloDesde)}` : 'Sin conexión',
    'token-rechazado': 'Token rechazado',
  }[kit.telegram];

  let estado = 'ok', mensaje;
  if (kit.sinDueño) { estado = 'error'; mensaje = 'Vinculación antigua sin dueño verificado: no obedece órdenes hasta revincular con npm run telegram'; }
  else if (kit.telegram === 'token-rechazado') { estado = 'error'; mensaje = 'Telegram rechaza el token: vuelve a vincular con npm run telegram'; }
  else if (kit.telegram === 'sin-conexion' && kit.falloDesde && Date.now() - kit.falloDesde >= SIN_CONEXION_AVISO_MS) { estado = 'aviso'; mensaje = `Sin conexión con Telegram desde las ${hora(kit.falloDesde)}`; }
  else if (kit.ultimaOrden && !kit.ultimaOrden.ok) { estado = 'aviso'; mensaje = `Falló la última orden (${kit.ultimaOrden.nombre})${kit.ultimoError ? `: ${kit.ultimoError.texto}` : ''}`; }
  else if (kit.ocupado) mensaje = 'Arrancando Pocket Terminal…';
  else if (kit.telegram === 'conectando') mensaje = 'Conectando con Telegram';
  else if (kit.telegram === 'sin-conexion') mensaje = 'Reconectando con Telegram';
  else mensaje = t ? `Escuchando órdenes. Pocket Terminal en marcha desde las ${hora(t.startedAt)}` : 'Escuchando órdenes de Telegram';

  const indicadores = [
    { etiqueta: 'Telegram', valor: textoTelegram },
    { etiqueta: 'Pocket Terminal', valor: textoTerminal },
    { etiqueta: 'Última orden', valor: kit.ultimaOrden ? `${kit.ultimaOrden.nombre} a las ${hora(kit.ultimaOrden.cuando)}${kit.ultimaOrden.ok ? '' : ' (falló)'}` : 'Ninguna desde que arrancó' },
    { etiqueta: 'Último error', valor: kit.ultimoError ? `${hora(kit.ultimoError.cuando)} · ${kit.ultimoError.texto}` : 'Ninguno' },
    { etiqueta: 'Mensajes ajenos', valor: String(kit.ajenos) },
    { etiqueta: 'Bot en marcha desde', valor: hora(kit.arrancado) },
  ];
  return { estado, mensaje, indicadores };
}

// Escribe si algo ha cambiado o si toca el latido. Nunca lanza.
function informarKit({ forzar = false } = {}) {
  try {
    const datos = calcularEstado();
    const contenido = JSON.stringify(datos);
    if (!forzar && contenido === ultimoContenido && Date.now() - ultimaEscritura < LATIDO_MS) return;
    if (escribirEstadoKit(datos)) { ultimoContenido = contenido; ultimaEscritura = Date.now(); }
  } catch {}
}

function anotarError(texto) {
  kit.ultimoError = { texto: String(texto).split('\n')[0], cuando: new Date() };
}

// El panel y Pocket Terminal.cmd también lo arrancan y lo paran sin pasar por
// aquí, así que se mira cada medio minuto; informarKit decide si escribe.
async function vigilarTerminal() {
  try { kit.terminal = await leerTerminal(); } catch {}
  informarKit();
}
setInterval(vigilarTerminal, 30_000).unref();

process.on('exit', code => {
  const final = kit.alSalir ?? (code === 0
    ? { estado: 'parado', mensaje: 'Bot detenido' }
    : { estado: 'error', mensaje: `El bot se ha cerrado por un fallo (código ${code})${kit.ultimoError ? `: ${kit.ultimoError.texto}` : ''}` });
  try { escribirEstadoKit({ ...final, indicadores: calcularEstado().indicadores }); } catch {}
});

try { kit.terminal = await leerTerminal(); } catch {}
informarKit({ forzar: true });

// Anyone can message a Telegram bot; only the chat id saved by `npm run
// telegram` is obeyed. Everything else is dropped without a reply, so a
// stranger cannot even tell that something is listening.
let settings = await readTelegram();
if (!settings) {
  log('Telegram no está configurado. Ejecuta: npm run telegram');
  kit.alSalir = { estado: 'error', mensaje: 'Telegram no está configurado. Ejecuta: npm run telegram' };
  process.exit(1);
}
let dueño = ownerCheck(settings);
kit.sinDueño = Boolean(dueño.needsRebind);
informarKit();
if (dueño.needsRebind) {
  // Vinculada antes de que se guardara la identidad del dueño: no hay forma de
  // saber quién lo era, así que no se obedece a nadie hasta rehacerla.
  log('vinculación antigua sin dueño verificado: no obedeceré ninguna orden hasta revincular con npm run telegram');
  const aviso = 'Pocket Terminal ya no acepta órdenes por aquí.\n\nLa vinculación se hizo sin comprobar quién eras, así que cualquiera del chat podía mandar. Vuelve a vincular en el ordenador con: npm run telegram';
  try { await say(settings, aviso); } catch {}
}

const AYUDA = 'Órdenes que entiendo:\n\n/arrancar — abre el túnel y enciende Pocket Terminal\n/parar — cierra Pocket Terminal y el túnel\n/reiniciar — lo para y lo vuelve a abrir, con dirección y contraseña nuevas\n/estado — te digo si está en marcha\n/ayuda — esta lista';
const ayuda = () => say(settings, AYUDA, { reply_markup: BOTONERA });

let busy = false;
async function arrancar() {
  if (busy) return say(settings, 'Espera, estoy con la orden anterior.');
  busy = true;
  kit.ocupado = true; informarKit();
  try {
    await say(settings, 'Arrancando…');
    const result = await startService({ log });
    kit.terminal = await leerTerminal().catch(() => kit.terminal);
    informarKit();
    if (result.alreadyRunning) await say(settings, 'Ya estaba en marcha. Te repito los datos:');
    await announce(settings, result.url, result.password);
    log(`en marcha: ${result.url}`);
  } catch (error) {
    log(`fallo al arrancar: ${error.message}`);
    anotarError(`No se pudo arrancar: ${error.message}`);
    if (kit.ultimaOrden) kit.ultimaOrden.ok = false;
    await say(settings, `No se pudo arrancar.\n\n${error.message}`);
  } finally { busy = false; kit.ocupado = false; informarKit(); }
}

async function parar() {
  const estaba = await stopService();
  kit.terminal = null; informarKit();
  log(estaba ? 'detenido por orden de Telegram' : 'orden de parar sin nada en marcha');
  await say(settings, estaba ? 'Pocket Terminal detenido. Las terminales abiertas se han cerrado.' : 'No había nada en marcha.', { reply_markup: BOTONERA });
}

// Reiniciar en una sola orden: pararlo y arrancarlo eran dos mensajes, y es lo
// que se hace cuando el túnel deja de responder.
async function reiniciar() {
  if (busy) return say(settings, 'Espera, estoy con la orden anterior.');
  await stopService();
  await arrancar();
}

async function estado() {
  const now = await status();
  if (!now.server.running) return say(settings, 'Pocket Terminal está parado. Escribe /arrancar cuando lo necesites.');
  const desde = new Date(now.startedAt).toLocaleTimeString('es-ES');
  if (now.localOnly) return say(settings, `En marcha desde las ${desde}, pero solo dentro del ordenador. Escribe /parar y luego /arrancar para abrirlo a internet.`);
  await say(settings, `En marcha desde las ${desde}.`);
  await announce(settings, now.url, now.password);
}

const ordenes = { '/arrancar': arrancar, '/parar': parar, '/reiniciar': reiniciar, '/estado': estado, '/ayuda': ayuda, '/start': ayuda };

// Ejecuta una orden dejando constancia para el Kit: cuál fue, cuándo y si salió
// bien. arrancar marca ok = false por su cuenta cuando no consigue arrancar.
async function ejecutar(nombre, orden) {
  kit.ultimaOrden = { nombre, cuando: new Date(), ok: true };
  informarKit();
  try { await orden(); }
  catch (error) {
    kit.ultimaOrden.ok = false;
    anotarError(`${nombre}: ${error.message}`);
    throw error;
  } finally {
    try { kit.terminal = await leerTerminal(); } catch {}
    informarKit();
  }
}

let offset = 0, avisadoDeIntrusos = 0, ultimoFallo = '';

// Revocar el token en BotFather y volver a vincular deja a este proceso con el
// token viejo en memoria, y Telegram contesta Unauthorized para siempre. Releer
// el fichero recupera la vinculación nueva sin tener que reiniciar el bot.
async function recargarVinculacion() {
  const nuevo = await readTelegram();
  if (!nuevo?.botToken || nuevo.botToken === settings.botToken) return false;
  settings = nuevo;
  dueño = ownerCheck(nuevo);
  kit.sinDueño = Boolean(dueño.needsRebind);
  // Se descartan las órdenes que quedaron en cola mientras el token no valía,
  // para no ejecutar de golpe lo que se escribió hace rato.
  try {
    const pendientes = await telegramCall(nuevo.botToken, 'getUpdates?offset=-1&timeout=0');
    offset = pendientes.length ? pendientes.at(-1).update_id + 1 : 0;
  } catch { offset = 0; }
  log(`vinculación nueva cargada; solo obedezco a ${nuevo.ownerName ?? 'el dueño'} (id ${nuevo.ownerId ?? 'sin verificar'}) por privado`);
  return true;
}

async function escuchar() {
  for (;;) {
    try {
      const updates = await telegramCall(settings.botToken, `getUpdates?offset=${offset}&timeout=30`);
      for (const update of updates) {
        offset = update.update_id + 1;

        // Pulsación de uno de los botones del aviso.
        const pulsacion = update.callback_query;
        if (pulsacion) {
          const suyo = dueño.allowsCallback(pulsacion);
          // Contestar siempre, o el botón se queda dando vueltas en el móvil.
          try { await telegramCall(settings.botToken, 'answerCallbackQuery', { callback_query_id: pulsacion.id, text: suyo ? '' : 'No autorizado' }); } catch {}
          if (!suyo) { log(`botón rechazado: usuario ${pulsacion.from?.id} en chat ${pulsacion.message?.chat?.id ?? 'sin contexto'}`); kit.ajenos++; informarKit(); continue; }
          const orden = ordenes[`/${pulsacion.data}`];
          if (orden) { log(`botón pulsado: ${pulsacion.data}`); await ejecutar(`/${pulsacion.data}`, orden); }
          continue;
        }

        const message = update.message;
        if (!message?.text) continue;
        // Autoriza la persona vinculada por privado, no el chat: en un grupo,
        // cualquier miembro heredaba el permiso y podía pedir las credenciales.
        if (!dueño.allowsMessage(message)) {
          log(`mensaje rechazado: usuario ${message.from?.id} en chat ${message.chat?.id} (${message.chat?.type})`);
          kit.ajenos++; informarKit();
          // Warn at most once an hour so a stranger cannot flood the owner.
          if (Date.now() - avisadoDeIntrusos > 3600_000) {
            avisadoDeIntrusos = Date.now();
            try { await say(settings, 'Alguien ajeno ha escrito al bot. No le he respondido nada.'); } catch {}
          }
          continue;
        }
        const nombre = message.text.trim().split(/[\s@]/)[0].toLowerCase();
        const orden = ordenes[nombre];
        if (orden) { log(`orden recibida: ${message.text.trim()}`); await ejecutar(nombre, orden); }
        else await ayuda();
      }
      ultimoFallo = '';
      if (kit.telegram !== 'conectado') { kit.telegram = 'conectado'; kit.falloDesde = null; informarKit(); }
    } catch (error) {
      const tokenRechazado = /unauthorized/i.test(error.message);
      if (tokenRechazado && await recargarVinculacion()) { ultimoFallo = ''; kit.telegram = 'conectando'; kit.falloDesde = null; informarKit(); continue; }
      // El mismo fallo cada cinco segundos llenaba el registro de líneas
      // iguales, así que solo se escribe cuando cambia.
      const texto = tokenRechazado
        ? 'Telegram rechaza el token. Si lo has revocado en BotFather, vuelve a vincular en el ordenador con: npm run telegram'
        : `error hablando con Telegram: ${error.message}`;
      if (texto !== ultimoFallo) { log(texto); ultimoFallo = texto; anotarError(texto); }
      kit.telegram = tokenRechazado ? 'token-rechazado' : 'sin-conexion';
      kit.falloDesde ??= Date.now();
      informarKit();
      await delay(5000);
    }
  }
}

// Closing the bot must not close Pocket Terminal: the server and the tunnel run
// on their own and the panel can take over from here.
process.on('SIGINT', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));

log(`escuchando al bot; solo obedezco a ${settings.ownerName ?? 'el dueño'} (id ${settings.ownerId ?? 'sin verificar'}) por privado`);
await escuchar();
