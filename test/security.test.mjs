// Pruebas de los fallos que encontró la auditoría del 6 de septiembre de 2026.
// Cada una falla si se deshace la corrección correspondiente.
//
// Telegram está simulado con un servidor local: no se envía ni un mensaje real,
// y el token es inventado.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Auth, hashPassword } from '../server/auth.mjs';
import { validateConfig } from '../server/config.mjs';
import { ownerCheck } from '../scripts/runtime.mjs';
import { dropPending, newCode, waitForOwner } from '../scripts/set-telegram.mjs';

const TOKEN_FALSO = '1234567890:AAdeMentiraParaLasPruebasNoEsRealNi';
const DUEÑO = { id: 111, first_name: 'Dueño' };
const AJENO = { id: 222, first_name: 'Ajeno' };

// Telegram de mentira: guarda las actualizaciones en cola y respeta el offset,
// que es lo que hace falta para probar el descarte de mensajes previos.
async function fakeTelegram(t, updates = []) {
  const enviados = [];
  let siguiente = 1;
  const cola = updates.map(u => ({ update_id: siguiente++, ...u }));
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    const metodo = url.pathname.split('/').at(-1);
    const responder = result => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: true, result })); };
    if (metodo === 'getMe') return responder({ id: 1, username: 'bot_de_prueba' });
    if (metodo === 'getUpdates') {
      const offset = Number(url.searchParams.get('offset') ?? 0);
      if (offset) for (const u of [...cola]) if (u.update_id < offset) cola.splice(cola.indexOf(u), 1);
      return responder(cola.filter(u => u.update_id >= offset));
    }
    if (metodo === 'sendMessage') {
      let cuerpo = '';
      req.on('data', d => { cuerpo += d; });
      req.on('end', () => { enviados.push(JSON.parse(cuerpo || '{}')); responder({ message_id: enviados.length }); });
      return;
    }
    responder({});
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const antes = process.env.POCKET_TELEGRAM_API;
  process.env.POCKET_TELEGRAM_API = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    if (antes === undefined) delete process.env.POCKET_TELEGRAM_API; else process.env.POCKET_TELEGRAM_API = antes;
    await new Promise(r => server.close(r));
  });
  return { enviados, empujar: u => cola.push({ update_id: siguiente++, ...u }) };
}
const mensaje = (from, texto, chat = { id: from.id, type: 'private' }) => ({ message: { from, chat, text: texto } });

test('la vinculación solo acepta un mensaje privado que traiga el código', async t => {
  const api = await fakeTelegram(t, [
    // Un mensaje del dueño anterior a generar el código: no debe servir.
    mensaje(DUEÑO, 'hola'),
  ]);
  const code = newCode();
  assert.match(code, /^[A-Z2-9]{8}$/, 'el código tiene que ser aleatorio y legible');

  const offset = await dropPending(TOKEN_FALSO);
  const deadline = Date.now() + 4000;

  // Un tercero escribe primero, sin el código: antes se quedaba con la vinculación.
  api.empujar(mensaje(AJENO, 'quiero entrar'));
  // El código llega por un grupo: tampoco vale.
  api.empujar(mensaje(DUEÑO, code, { id: -900, type: 'group' }));
  // Y por fin el dueño por privado, con el código.
  api.empujar(mensaje(DUEÑO, `mi codigo es ${code}`));

  const dueño = await waitForOwner(TOKEN_FALSO, code, { offset, deadline });
  assert.ok(dueño, 'no se completó la vinculación');
  assert.equal(dueño.ownerId, String(DUEÑO.id), 'se vinculó a la persona equivocada');
  assert.equal(dueño.chatId, String(DUEÑO.id));
});

test('la vinculación caduca sin vincular a nadie si el código no llega', async t => {
  const api = await fakeTelegram(t);
  const code = newCode();
  api.empujar(mensaje(AJENO, 'hola, soy otro'));
  api.empujar(mensaje(DUEÑO, 'hola, sin el código'));
  const dueño = await waitForOwner(TOKEN_FALSO, code, { offset: 0, deadline: Date.now() + 1200 });
  assert.equal(dueño, null, 'vinculó a alguien sin haber recibido el código');
});

test('el bot obedece a la persona vinculada y a nadie más', async () => {
  const dueño = ownerCheck({ chatId: '111', ownerId: '111' });
  assert.equal(dueño.needsRebind, false);

  assert.ok(dueño.allowsMessage(mensaje(DUEÑO, '/estado').message), 'no acepta al dueño por privado');

  // Otro usuario dentro del chat autorizado: el caso del grupo compartido.
  assert.ok(!dueño.allowsMessage({ from: AJENO, chat: { id: 111, type: 'private' }, text: '/estado' }),
    'acepta a otra persona dentro del chat vinculado');
  // Un grupo, aunque el que escribe sea el dueño.
  assert.ok(!dueño.allowsMessage({ from: DUEÑO, chat: { id: -900, type: 'group' }, text: '/estado' }),
    'acepta órdenes por un grupo');
  // Mensaje privado de un desconocido.
  assert.ok(!dueño.allowsMessage({ from: AJENO, chat: { id: 222, type: 'private' }, text: '/estado' }),
    'acepta el privado de un desconocido');

  // Botones: hace falta chat verificable y que el remitente sea el dueño.
  assert.ok(dueño.allowsCallback({ from: DUEÑO, message: { chat: { id: 111, type: 'private' } }, data: 'estado' }));
  assert.ok(!dueño.allowsCallback({ from: AJENO, message: { chat: { id: 111, type: 'private' } }, data: 'estado' }),
    'acepta el botón de otra persona en el chat vinculado');
  assert.ok(!dueño.allowsCallback({ from: DUEÑO, data: 'estado' }),
    'acepta un botón sin chat, cayendo en el identificador del remitente');
});

test('una vinculación antigua sin dueño no obedece a nadie', () => {
  const viejo = ownerCheck({ chatId: '111' });
  assert.equal(viejo.needsRebind, true, 'no detecta que falta la identidad del dueño');
  assert.ok(!viejo.allowsMessage(mensaje(DUEÑO, '/estado').message), 'obedece pese a no saber de quién es');
  assert.ok(!viejo.allowsCallback({ from: DUEÑO, message: { chat: { id: 111, type: 'private' } } }));
});

test('las peticiones sin contraseña no gastan el cupo de intentos', async () => {
  const config = validateConfig({ publicOrigin: 'https://host.example', ...await hashPassword('la-buena-de-verdad') });
  const auth = new Auth(config);
  // Diez peticiones malformadas seguidas: antes dejaban al dueño fuera un minuto.
  for (let i = 0; i < 10; i++) assert.equal((await auth.login('')).status, 400);
  for (let i = 0; i < 5; i++) assert.equal((await auth.login(undefined)).status, 400);
  const bueno = await auth.login('la-buena-de-verdad');
  assert.equal(bueno.status, 200, 'la contraseña correcta quedó bloqueada por peticiones vacías');

  // El límite sigue frenando la fuerza bruta de verdad.
  const otra = new Auth(config);
  for (let i = 0; i < 10; i++) assert.equal((await otra.login('probando')).status, 401);
  assert.equal((await otra.login('probando')).status, 429, 'el límite ya no frena los intentos reales');
});

test('un segundo panel que no arranca no toca la clave del que ya funciona', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'pocket-control-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const { startControlServer } = await import('../scripts/control.mjs');
  const { readControlToken } = await import('../scripts/runtime.mjs');

  // Puerto concreto: el panel construye la lista de Host permitidos con el
  // puerto que se le pasa, así que con 0 no aceptaría ni sus propias peticiones.
  const { createServer: netServer } = await import('node:net');
  const sonda = netServer(); sonda.listen(0, '127.0.0.1'); await once(sonda, 'listening');
  const puerto = sonda.address().port;
  await new Promise(r => sonda.close(r));

  const primero = await startControlServer(puerto);
  assert.ok(primero, 'el primer panel no arrancó');
  t.after(() => new Promise(r => primero.server.close(r)));
  const claveBuena = await readControlToken();
  assert.equal(claveBuena, primero.token, 'la clave publicada no es la del panel en marcha');

  // Segundo arranque sobre el mismo puerto: tiene que fracasar sin efectos.
  const segundo = await startControlServer(puerto);
  assert.equal(segundo, null, 'arrancaron dos paneles en el mismo puerto');
  assert.equal(await readControlToken(), claveBuena, 'el arranque fallido pisó la clave del panel activo');

  // Y la clave publicada sigue siendo la que acepta el panel vivo.
  const ok = await fetch(`http://127.0.0.1:${puerto}/api/status`, { headers: { 'X-Control-Token': claveBuena } });
  assert.equal(ok.status, 200, 'la clave guardada dejó de servir');
});

test('la clave del panel no acaba escrita en el registro del bot', async () => {
  const fuente = await readFile('scripts/bot.mjs', 'utf8');
  assert.ok(!/log\(`[^`]*control\.url/.test(fuente), 'el registro vuelve a incluir la URL con la clave');
  assert.ok(!fuente.includes('${control.url}'), 'la URL con la clave se registra en algún sitio');
});

test('el vinculador no recibe el token como argumento obligatorio', async () => {
  const fuente = await readFile('scripts/set-telegram.mjs', 'utf8');
  assert.ok(fuente.includes('secret('), 'ya no se pide el token con entrada oculta');
  assert.ok(/ownerId/.test(fuente), 'la vinculación no guarda la identidad del dueño');
});

test('los ficheros de datos se protegen con ACL en Windows', { skip: process.platform !== 'win32' }, async t => {
  const { ensureDataDir, protectPath } = await import('../scripts/runtime.mjs');
  const dir = await mkdtemp(join(tmpdir(), 'pocket-acl-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const fichero = join(dir, 'secreto.json');
  await writeFile(fichero, '{}');
  const r = protectPath(fichero);
  assert.equal(r.ok, true, `icacls falló: ${r.error}`);

  // Comprobar que la herencia quedó cortada y solo está el usuario actual.
  const { spawnSync } = await import('node:child_process');
  // La ruta del fichero contiene "C:\Users", así que se quita antes de mirar:
  // lo que interesa son los permisos, no dónde está el archivo.
  const salida = spawnSync('icacls', [fichero], { encoding: 'utf8' }).stdout;
  const permisos = salida.split('\n').map(l => l.replace(fichero, '')).join('\n');
  // Lo que se comprueba es que ninguna otra cuenta del equipo pueda leerlo.
  // Administradores y SYSTEM no se miran: en Windows pueden tomar posesión de
  // cualquier fichero, así que su ausencia no demostraría nada.
  assert.ok(!/Everyone|Todos|Authenticated Users|Usuarios autenticados|BUILTIN\\(Users|Usuarios)/i.test(permisos),
    `otras cuentas del equipo siguen teniendo acceso:\n${salida}`);
  assert.match(permisos, /:\(F\)/, `el dueño no tiene control total:\n${salida}`);
  assert.equal((await ensureDataDir()).ok, true, 'no se pudo proteger la carpeta de datos');
});
