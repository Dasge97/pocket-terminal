import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { projectRoot } from '../server/config.mjs';
import { botLockPort, configPort, portBusy, readControlToken } from './runtime.mjs';

const TASK = 'PocketTerminalBot';

function run(command, args) {
  return new Promise(done => {
    const child = spawn(command, args, { cwd: projectRoot, windowsHide: true, stdio: 'ignore' });
    child.on('error', () => done(1));
    child.on('exit', code => done(code ?? 1));
  });
}

async function esperarPanel(port, ms) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await portBusy(port)) return true;
    await delay(300);
  }
  return false;
}

try {
  const port = botLockPort(await configPort());

  if (!await portBusy(port)) {
    console.log('Arrancando el bot, que es quien sirve el panel…');
    // La tarea programada es la vía preferida: deja el proceso fuera de esta
    // ventana, así que el panel sigue vivo al cerrarla.
    const conTarea = process.platform === 'win32' && await run('schtasks', ['/Run', '/TN', TASK]) === 0;
    if (!conTarea) {
      const child = spawn(process.execPath, [resolve(projectRoot, 'scripts/bot.mjs')], { cwd: projectRoot, detached: true, windowsHide: true, stdio: 'ignore' });
      child.unref();
    }
    if (!await esperarPanel(port, 20_000)) {
      throw new Error('El bot no ha arrancado.\n\nMira .pocket-terminal\\bot.log, o abre el panel de consola con: npm run panel');
    }
  }

  const token = await readControlToken();
  if (!token) throw new Error('No encuentro la clave del panel. Reinicia el bot y vuelve a intentarlo.');
  const url = `http://127.0.0.1:${port}/?k=${token}`;

  console.log(`\n  Panel de control: ${url}\n`);
  if (process.platform === 'win32') await run('cmd', ['/c', 'start', '', url]);
  else await run('xdg-open', [url]);
  console.log('  Se ha abierto en tu navegador. Puedes cerrar esta ventana.\n');
} catch (error) {
  console.error(`\n${error.message}\n`);
  process.exitCode = 1;
}
