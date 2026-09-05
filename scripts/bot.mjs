import { appendFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { announce, botLockPort, botLogPath, configPort, readTelegram, say, startService, status, stopService, telegramCall, writeBotPid } from './runtime.mjs';

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
// its own. Holding a local port is the lock that keeps the retries from piling
// up extra copies, and it disappears by itself if the process dies.
const port = await configPort();
const lock = createServer();
const locked = await new Promise(done => {
  lock.once('error', () => done(false));
  lock.once('listening', () => done(true));
  lock.listen(botLockPort(port), '127.0.0.1');
});
if (!locked) {
  log('ya hay otro vigilante escuchando; me retiro');
  process.exit(0);
}
lock.unref();
await writeBotPid();

// Anyone can message a Telegram bot; only the chat id saved by `npm run
// telegram` is obeyed. Everything else is dropped without a reply, so a
// stranger cannot even tell that something is listening.
const settings = await readTelegram();
if (!settings) {
  log('Telegram no está configurado. Ejecuta: npm run telegram -- <token del bot>');
  process.exit(1);
}

const AYUDA = 'Órdenes que entiendo:\n\n/arrancar — abre el túnel y enciende Pocket Terminal\n/parar — cierra Pocket Terminal y el túnel\n/estado — te digo si está en marcha\n/ayuda — esta lista';

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
  await say(settings, estaba ? 'Pocket Terminal detenido. Las terminales abiertas se han cerrado.' : 'No había nada en marcha.');
}

async function estado() {
  const now = await status();
  if (!now.server.running) return say(settings, 'Pocket Terminal está parado. Escribe /arrancar cuando lo necesites.');
  const desde = new Date(now.startedAt).toLocaleTimeString('es-ES');
  if (now.localOnly) return say(settings, `En marcha desde las ${desde}, pero solo dentro del ordenador. Escribe /parar y luego /arrancar para abrirlo a internet.`);
  await say(settings, `En marcha desde las ${desde}.`);
  await announce(settings, now.url, now.password);
}

const ordenes = { '/arrancar': arrancar, '/parar': parar, '/estado': estado, '/ayuda': () => say(settings, AYUDA), '/start': () => say(settings, AYUDA) };

let offset = 0, avisadoDeIntrusos = 0;
async function escuchar() {
  for (;;) {
    try {
      const updates = await telegramCall(settings.botToken, `getUpdates?offset=${offset}&timeout=30`);
      for (const update of updates) {
        offset = update.update_id + 1;
        const message = update.message;
        if (!message?.text) continue;
        if (String(message.chat.id) !== String(settings.chatId)) {
          log(`mensaje ignorado de un chat ajeno (${message.chat.id})`);
          // Warn at most once an hour so a stranger cannot flood the owner.
          if (Date.now() - avisadoDeIntrusos > 3600_000) {
            avisadoDeIntrusos = Date.now();
            try { await say(settings, 'Alguien ajeno ha escrito al bot. No le he respondido nada.'); } catch {}
          }
          continue;
        }
        const orden = ordenes[message.text.trim().split(/[\s@]/)[0].toLowerCase()];
        if (orden) { log(`orden recibida: ${message.text.trim()}`); await orden(); }
        else await say(settings, AYUDA);
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

log(`escuchando al bot; solo obedezco al chat ${settings.chatId}`);
await escuchar();
