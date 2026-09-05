import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { projectRoot } from '../server/config.mjs';

const telegramPath = resolve(projectRoot, '.pocket-terminal/telegram.json');

async function call(botToken, method) {
  const response = await fetch(`https://api.telegram.org/bot${botToken}/${method}`);
  const body = await response.json();
  if (!body.ok) throw new Error(`Telegram rechazó la petición: ${body.description}`);
  return body.result;
}

// The chat id is never shown in Telegram's interface, so it has to be read from
// a message the user sends to their own bot. Wait for one instead of failing.
async function waitForChat(botToken, seconds) {
  const deadline = Date.now() + seconds * 1000;
  while (Date.now() < deadline) {
    const updates = await call(botToken, 'getUpdates');
    const chats = updates.map(u => u.message?.chat ?? u.channel_post?.chat).filter(Boolean);
    if (chats.length) return chats.at(-1);
    await delay(2000);
  }
  return null;
}

try {
  const botToken = process.argv[2];
  if (!botToken) throw new Error('Uso: npm run telegram -- <token del bot>\n\nPara conseguir el token: abre Telegram, habla con @BotFather, envía /newbot y sigue los pasos.');
  if (!/^\d+:[\w-]{30,}$/.test(botToken)) throw new Error('Un token de BotFather tiene la forma 1234567890:AAxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx');

  const bot = await call(botToken, 'getMe');
  console.log(`\nBot encontrado: @${bot.username}`);
  console.log(`\nAbre Telegram, busca @${bot.username}, pulsa Iniciar y escríbele cualquier cosa.`);
  console.log('Esperando tu mensaje (90 segundos)…\n');

  const chat = await waitForChat(botToken, 90);
  if (!chat) throw new Error('No llegó ningún mensaje. Escribe al bot y vuelve a ejecutar el comando.');
  const nombre = chat.title || [chat.first_name, chat.last_name].filter(Boolean).join(' ') || chat.username || 'tu chat';

  await mkdir(dirname(telegramPath), { recursive: true, mode: 0o700 });
  await writeFile(telegramPath, JSON.stringify({ botToken, chatId: String(chat.id) }, null, 2) + '\n', { mode: 0o600 });

  const prueba = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chat.id, text: 'Pocket Terminal ya puede avisarte por aquí.' }),
  });
  const resultado = await prueba.json();
  console.log(`Telegram configurado para ${nombre}.`);
  console.log(resultado.ok ? 'Mensaje de prueba enviado. Míralo en Telegram.' : `No se pudo enviar el mensaje de prueba: ${resultado.description}`);
} catch (error) { console.error(`\n${error.message}\n`); process.exitCode = 1; }
