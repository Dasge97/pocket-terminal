import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { randomInt } from 'node:crypto';
import { createInterface, emitKeypressEvents } from 'node:readline';
import { dirname } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { protectPath, telegramApi, telegramPath } from './runtime.mjs';

const VIGENCIA_MS = 5 * 60 * 1000;
const ALFABETO = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

async function call(botToken, method, params = {}) {
  const url = new URL(`${telegramApi()}/bot${botToken}/${method}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
  const response = await fetch(url);
  const body = await response.json();
  if (!body.ok) throw new Error(`Telegram rechazó la petición: ${body.description}`);
  return body.result;
}

function question(text) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => rl.question(text, answer => { rl.close(); resolve(answer.trim()); }));
}

// El token no puede ir como argumento: queda en el historial de la consola y en
// la lista de procesos, donde lo ve cualquier programa del equipo.
function secret(text) {
  if (!process.stdin.isTTY) throw new Error('Ejecuta la vinculación en una terminal interactiva.');
  process.stdout.write(text); emitKeypressEvents(process.stdin); process.stdin.setRawMode(true); process.stdin.resume();
  return new Promise((resolve, reject) => {
    let value = '';
    const done = error => {
      process.stdin.off('keypress', onKey); process.stdin.setRawMode(false); process.stdin.pause(); process.stdout.write('\n');
      if (error) reject(error); else resolve(value.trim());
    };
    const onKey = (text, key = {}) => {
      if (key.ctrl && key.name === 'c') return done(new Error('Vinculación cancelada.'));
      if (key.name === 'return' || key.name === 'enter') return done();
      if (key.name === 'backspace') { value = [...value].slice(0, -1).join(''); return; }
      if (!key.ctrl && !key.meta && text && !/[\x00-\x1f\x7f]/.test(text)) value += text;
    };
    process.stdin.on('keypress', onKey);
  });
}

// Cualquiera que conozca el nombre del bot puede escribirle mientras se
// vincula. Sin un código que solo está en esta pantalla, el instalador se
// quedaba con el último mensaje llegado, viniera de quien viniera.
export function newCode() {
  return Array.from({ length: 8 }, () => ALFABETO[randomInt(ALFABETO.length)]).join('');
}

// Las actualizaciones que ya estaban en cola son de antes de generar el código,
// así que se confirman y se tiran antes de empezar a escuchar.
export async function dropPending(botToken) {
  const updates = await call(botToken, 'getUpdates', { timeout: 0 });
  if (!updates.length) return 0;
  const next = updates.at(-1).update_id + 1;
  await call(botToken, 'getUpdates', { offset: next, timeout: 0 });
  return next;
}

// Solo vale un mensaje privado que traiga el código. Un grupo, un canal o un
// mensaje de otra persona no vinculan nada.
export async function waitForOwner(botToken, code, { offset = 0, deadline, onWait } = {}) {
  let next = offset;
  while (Date.now() < deadline) {
    const updates = await call(botToken, 'getUpdates', { offset: next, timeout: 0 });
    for (const update of updates) {
      next = update.update_id + 1;
      const message = update.message;
      if (!message?.text || !message.text.toUpperCase().includes(code)) continue;
      if (message.chat?.type !== 'private') { onWait?.('El código llegó por un grupo o canal. Escríbeme por privado.'); continue; }
      if (!message.from?.id) continue;
      return { chatId: String(message.chat.id), ownerId: String(message.from.id), from: message.from };
    }
    await delay(1500);
  }
  return null;
}

async function main() {
  const anterior = await readFile(telegramPath, 'utf8').then(t => JSON.parse(t), () => null);
  if (anterior?.ownerId) {
    console.log('\nYa hay una vinculación activa.');
    console.log(`Bot en el chat ${anterior.chatId}, a nombre de ${anterior.ownerName ?? 'un usuario'} (id ${anterior.ownerId}).`);
    const respuesta = await question('Escribe SUSTITUIR para reemplazarla, o Intro para dejarla como está: ');
    if (respuesta !== 'SUSTITUIR') { console.log('No se ha cambiado nada.'); return; }
  }

  const botToken = process.argv[2] || await secret('\nPega el token de BotFather (no se verá al escribirlo): ');
  if (!botToken) throw new Error('Sin token no puedo vincular nada.');
  if (!/^\d+:[\w-]{30,}$/.test(botToken)) throw new Error('Un token de BotFather tiene la forma 1234567890:AAxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx');
  if (process.argv[2]) console.log('\nAviso: pasar el token como argumento lo deja en el historial de la consola. Mejor ejecuta `npm run telegram` sin argumentos.');

  const bot = await call(botToken, 'getMe');
  const code = newCode();
  const offset = await dropPending(botToken);

  console.log(`\nBot encontrado: @${bot.username}`);
  console.log('\n  ┌──────────────────────────────┐');
  console.log(`  │   Código de vinculación:  ${code}  │`);
  console.log('  └──────────────────────────────┘');
  console.log(`\nAbre Telegram, escribe por privado a @${bot.username} y mándale ese código.`);
  console.log('Caduca en 5 minutos y solo sirve una vez.\n');

  const dueño = await waitForOwner(botToken, code, {
    offset, deadline: Date.now() + VIGENCIA_MS,
    onWait: aviso => console.log(`  ${aviso}`),
  });
  if (!dueño) throw new Error('El código ha caducado sin recibirse. Vuelve a ejecutar la vinculación.');

  const nombre = [dueño.from.first_name, dueño.from.last_name].filter(Boolean).join(' ') || dueño.from.username || 'tu cuenta';
  await mkdir(dirname(telegramPath), { recursive: true, mode: 0o700 });
  await writeFile(telegramPath, JSON.stringify({
    botToken, chatId: dueño.chatId, ownerId: dueño.ownerId, ownerName: nombre, boundAt: new Date().toISOString(),
  }, null, 2) + '\n', { mode: 0o600 });
  await protectPath(telegramPath);

  const prueba = await fetch(`${telegramApi()}/bot${botToken}/sendMessage`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: dueño.chatId, text: 'Pocket Terminal queda vinculado a esta cuenta. Solo obedecerá a tus mensajes privados.' }),
  });
  const resultado = await prueba.json();
  console.log(`\nVinculado con ${nombre} (id ${dueño.ownerId}).`);
  console.log(resultado.ok ? 'Mensaje de confirmación enviado.' : `No se pudo enviar la confirmación: ${resultado.description}`);
  console.log('Reinicia el bot para que tome la vinculación nueva.');
}

// Importado desde las pruebas: solo se ejecuta al llamarlo como programa.
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').at(-1))) {
  try { await main(); } catch (error) { console.error(`\n${error.message}\n`); process.exitCode = 1; }
}
