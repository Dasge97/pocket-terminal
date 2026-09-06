import { appendFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { startControlServer } from './control.mjs';
import { announce, BOTONERA, botLockPort, botLogPath, configPort, ownerCheck, readTelegram, say, startService, status, stopService, telegramCall, writeBotPid } from './runtime.mjs';

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

// Anyone can message a Telegram bot; only the chat id saved by `npm run
// telegram` is obeyed. Everything else is dropped without a reply, so a
// stranger cannot even tell that something is listening.
const settings = await readTelegram();
if (!settings) {
  log('Telegram no está configurado. Ejecuta: npm run telegram');
  process.exit(1);
}
const dueño = ownerCheck(settings);
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
  try {
    await say(settings, 'Arrancando…');
    const result = await startService({ log });
    if (result.alreadyRunning) await say(settings, 'Ya estaba en marcha. Te repito los datos:');
    await announce(settings, result.url, result.password);
    log(`en marcha: ${result.url}`);
  } catch (error) {
    log(`fallo al arrancar: ${error.message}`);
    await say(settings, `No se pudo arrancar.\n\n${error.message}`);
  } finally { busy = false; }
}

async function parar() {
  const estaba = await stopService();
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

let offset = 0, avisadoDeIntrusos = 0;
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
          if (!suyo) { log(`botón rechazado: usuario ${pulsacion.from?.id} en chat ${pulsacion.message?.chat?.id ?? 'sin contexto'}`); continue; }
          const orden = ordenes[`/${pulsacion.data}`];
          if (orden) { log(`botón pulsado: ${pulsacion.data}`); await orden(); }
          continue;
        }

        const message = update.message;
        if (!message?.text) continue;
        // Autoriza la persona vinculada por privado, no el chat: en un grupo,
        // cualquier miembro heredaba el permiso y podía pedir las credenciales.
        if (!dueño.allowsMessage(message)) {
          log(`mensaje rechazado: usuario ${message.from?.id} en chat ${message.chat?.id} (${message.chat?.type})`);
          // Warn at most once an hour so a stranger cannot flood the owner.
          if (Date.now() - avisadoDeIntrusos > 3600_000) {
            avisadoDeIntrusos = Date.now();
            try { await say(settings, 'Alguien ajeno ha escrito al bot. No le he respondido nada.'); } catch {}
          }
          continue;
        }
        const orden = ordenes[message.text.trim().split(/[\s@]/)[0].toLowerCase()];
        if (orden) { log(`orden recibida: ${message.text.trim()}`); await orden(); }
        else await ayuda();
      }
    } catch (error) {
      log(`error hablando con Telegram: ${error.message}`);
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
