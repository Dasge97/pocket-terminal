import { spawn } from 'node:child_process';
import { readFile, stat } from 'node:fs/promises';
import { createInterface } from 'node:readline/promises';
import { resolve } from 'node:path';
import { projectRoot } from '../server/config.mjs';
import {
  announce, botLogPath, hasCloudflared, stopProcess,
  readTelegram, startService, status, stopService,
} from './runtime.mjs';

const TASK = 'PocketTerminalBot';
const rl = createInterface({ input: process.stdin, output: process.stdout });
// Con la entrada redirigida o la consola cerrada, readline emite `close` y ya
// no puede preguntar. Sin esta bandera el bucle seguiría llamándola y fallaría.
let cerrado = false;
rl.on('close', () => { cerrado = true; });
const preguntar = async texto => (cerrado ? '0' : rl.question(texto).catch(() => '0'));
const pausa = () => (cerrado ? Promise.resolve() : preguntar('\n  Pulsa Intro para volver al panel… '));

function run(command, args, { quiet = false } = {}) {
  return new Promise(done => {
    const child = spawn(command, args, { cwd: projectRoot, windowsHide: true, stdio: quiet ? 'ignore' : 'inherit' });
    child.on('error', () => done(1));
    child.on('exit', code => done(code ?? 1));
  });
}
function capture(command, args) {
  return new Promise(done => {
    const child = spawn(command, args, { cwd: projectRoot, windowsHide: true });
    let out = '';
    child.stdout?.on('data', d => { out += d; });
    child.stderr?.on('data', d => { out += d; });
    child.on('error', () => done({ code: 1, out }));
    child.on('exit', code => done({ code: code ?? 1, out }));
  });
}

// schtasks is localised, so only its exit code is trusted; the Spanish and
// English words for a disabled task both appear in the same field.
async function taskState() {
  if (process.platform !== 'win32') return 'sin soporte';
  const { code, out } = await capture('schtasks', ['/Query', '/TN', TASK, '/FO', 'LIST']);
  if (code !== 0) return 'sin registrar';
  return /Deshabilitado|Disabled/i.test(out) ? 'registrada pero deshabilitada' : 'registrada';
}

const marca = ok => (ok ? '  [ok] ' : '  [--] ');

async function panel() {
  const now = await status();
  const telegram = await readTelegram();
  const tarea = await taskState();
  const web = await stat(resolve(projectRoot, 'dist/index.html')).then(() => true, () => false);
  const cloudflared = await hasCloudflared();

  console.clear();
  console.log('\n  =========================================================');
  console.log('    POCKET TERMINAL  ·  panel de control');
  console.log('  =========================================================\n');

  console.log(marca(now.server.running) + (now.server.running
    ? `Pocket Terminal en marcha (proceso ${now.server.pid})`
    : 'Pocket Terminal parado'));
  if (now.server.running) {
    console.log(`         Dirección:  ${now.url}`);
    console.log(`         Contraseña: ${now.password}`);
    console.log(`         Desde:      ${new Date(now.startedAt).toLocaleString('es-ES')}`);
  }
  if (now.orphan) console.log(`  [!!] El puerto ${now.port} lo ocupa el proceso ${now.orphan}, que no he arrancado yo.\n         Usa la opción 1 para dejarlo libre.`);
  if (now.strayTunnels.length) console.log(`  [!!] Hay ${now.strayTunnels.length} túnel(es) abiertos que no controlo: ${now.strayTunnels.join(', ')}.\n         Mantienen una dirección pública viva. La opción 12 los cierra.`);
  console.log(marca(now.tunnel.running) + (now.tunnel.running
    ? `Túnel abierto, accesible desde internet (proceso ${now.tunnel.pid})`
    : now.server.running ? 'Sin túnel: solo se llega desde este ordenador' : 'Sin túnel'));
  console.log(marca(now.bot.running) + (now.bot.running ? `Bot de Telegram escuchando (proceso ${now.bot.pid ?? '?'})` : 'Bot de Telegram parado'));
  console.log(marca(tarea === 'registrada') + `Arranque automático del bot: ${tarea}`);
  console.log(marca(cloudflared) + (cloudflared ? 'cloudflared instalado' : 'cloudflared NO instalado'));
  console.log(marca(Boolean(telegram)) + (telegram ? `Telegram configurado (chat ${telegram.chatId})` : 'Telegram sin configurar'));
  console.log(marca(web) + (web ? 'Web compilada' : 'Web SIN compilar'));
  console.log(`  [--] Node ${process.version}   ·   puerto ${now.port}\n`);

  console.log('  ---------------------------------------------------------');
  console.log(now.server.running ? '   1. Parar Pocket Terminal'
    : now.orphan ? `   1. Liberar el puerto ${now.port} (matar el proceso ${now.orphan})`
    : '   1. Arrancar con túnel (accesible desde internet)');
  console.log(now.server.running ? '   2. Reiniciar con contraseña nueva' : '   2. Arrancar solo en este ordenador');
  console.log('   3. Reenviar dirección y contraseña por Telegram');
  console.log(now.bot.running ? '   4. Reiniciar el bot de Telegram' : '   4. Arrancar el bot de Telegram');
  console.log('   5. Parar el bot de Telegram');
  console.log('   6. Instalar o reparar el arranque automático');
  console.log('   7. Quitar el arranque automático');
  console.log('   8. Configurar Telegram con otro token');
  console.log('   9. Recompilar la web');
  console.log('  10. Ver el registro del bot');
  console.log('  11. Abrir Pocket Terminal en el navegador');
  console.log('  12. Cerrar túneles sueltos');
  console.log('   0. Salir del panel (no para nada)');
  console.log('  ---------------------------------------------------------');

  const opcion = (await preguntar('\n  Elige una opción: ')).trim();
  return { opcion, now, telegram };
}

async function arrancar(localOnly) {
  console.log('');
  try {
    const result = await startService({ localOnly, log: m => console.log(`  ${m}`) });
    console.log(`\n  Dirección:  ${result.url}`);
    console.log(`  Contraseña: ${result.password}`);
    const telegram = await readTelegram();
    if (!telegram) console.log('\n  Telegram no configurado, no he avisado por ahí.');
    else {
      try { await announce(telegram, result.url, result.password); console.log('\n  Enviado por Telegram.'); }
      catch (error) { console.log(`\n  No se pudo enviar por Telegram: ${error.message}`); }
    }
  } catch (error) { console.log(`\n  ${error.message}`); }
}

async function pararBot() {
  const now = await status();
  if (!now.bot.running) { console.log('\n  El bot no estaba en marcha.'); return; }
  if (now.bot.pid) stopProcess(now.bot.pid);
  else await run('powershell', ['-NoProfile', '-Command', "Get-CimInstance Win32_Process -Filter \"Name = 'node.exe'\" | Where-Object { $_.CommandLine -like '*scripts\\bot.mjs*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }"], { quiet: true });
  console.log('\n  Bot detenido. Pocket Terminal sigue como estaba.');
}

async function arrancarBot() {
  await pararBot();
  const tarea = await taskState();
  if (tarea === 'registrada') { await run('schtasks', ['/Run', '/TN', TASK], { quiet: true }); console.log('  Bot arrancado desde la tarea programada.'); }
  else {
    const child = spawn(process.execPath, [resolve(projectRoot, 'scripts/bot.mjs')], { cwd: projectRoot, detached: true, windowsHide: true, stdio: 'ignore' });
    child.unref();
    console.log('  Bot arrancado. Sin tarea programada, no volverá solo tras reiniciar Windows.');
  }
}

try {
  for (;;) {
    const { opcion, now, telegram } = await panel();
    if (opcion === '0') break;
    switch (opcion) {
      case '1':
        if (now.server.running || now.orphan) {
          await stopService();
          const tras = await status();
          console.log(tras.server.running || tras.orphan
            ? `\n  No he podido parar el proceso ${tras.server.pid ?? tras.orphan}. Ciérralo desde el Administrador de tareas.`
            : '\n  Pocket Terminal detenido. Las terminales abiertas se han cerrado.');
        } else await arrancar(false);
        break;
      case '2':
        if (now.server.running) { await stopService(); await arrancar(now.localOnly ?? false); }
        else await arrancar(true);
        break;
      case '3':
        if (!now.server.running) console.log('\n  No hay nada en marcha que anunciar.');
        else if (!telegram) console.log('\n  Telegram no está configurado.');
        else {
          try { await announce(telegram, now.url, now.password); console.log('\n  Enviado por Telegram.'); }
          catch (error) { console.log(`\n  No se pudo enviar: ${error.message}`); }
        }
        break;
      case '4': console.log(''); await arrancarBot(); break;
      case '5': await pararBot(); break;
      case '6':
        console.log('');
        await run('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', resolve(projectRoot, 'scripts/Enable-BotAutostart.ps1')]);
        break;
      case '7':
        console.log('');
        await run('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', resolve(projectRoot, 'scripts/Disable-BotAutostart.ps1')]);
        break;
      case '8': {
        const token = (await preguntar('\n  Pega el token de BotFather: ')).trim();
        if (!token) { console.log('  Sin token, no cambio nada.'); break; }
        console.log('');
        await run(process.execPath, [resolve(projectRoot, 'scripts/set-telegram.mjs'), token]);
        break;
      }
      case '9':
        console.log('');
        // Vite directamente, no `npm.cmd`: en Windows, lanzar un .cmd sin shell
        // falla con EINVAL, y con shell arrastra un aviso de obsolescencia.
        await run(process.execPath, [resolve(projectRoot, 'node_modules/vite/bin/vite.js'), 'build']);
        break;
      case '10': {
        const log = await readFile(botLogPath, 'utf8').catch(() => '');
        console.log(`\n${log.split('\n').slice(-25).join('\n') || '  El registro está vacío.'}`);
        break;
      }
      case '11':
        if (!now.server.running) console.log('\n  Arráncalo primero.');
        else { await run('cmd', ['/c', 'start', '', now.url], { quiet: true }); console.log('\n  Abriendo el navegador…'); }
        break;
      case '12': {
        if (!now.strayTunnels.length) { console.log('\n  No hay túneles sueltos.'); break; }
        for (const pid of now.strayTunnels) stopProcess(pid);
        const quedan = (await status()).strayTunnels;
        console.log(quedan.length ? `\n  Siguen abiertos: ${quedan.join(', ')}.` : '\n  Túneles sueltos cerrados.');
        break;
      }
      default: continue;
    }
    // La orden ya se ha ejecutado; si la entrada se agotó, salir sin preguntar.
    if (cerrado) break;
    await pausa();
  }
} finally {
  rl.close();
  const final = await status();
  if (final.server.running) console.log(`\n  Pocket Terminal sigue en marcha en ${final.url}\n`);
  else console.log('\n  Pocket Terminal está parado.\n');
}
