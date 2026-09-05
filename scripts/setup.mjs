import { createInterface, emitKeypressEvents } from 'node:readline';
import { mkdir, readFile, writeFile, stat } from 'node:fs/promises';
import { dirname, isAbsolute } from 'node:path';
import { homedir } from 'node:os';
import { hashPassword } from '../server/auth.mjs';
import { configPath, validateConfig } from '../server/config.mjs';

function question(text) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => rl.question(text, answer => { rl.close(); resolve(answer.trim()); }));
}
function secret(text) {
  if (!process.stdin.isTTY) throw new Error('Ejecuta la configuración en una terminal interactiva.');
  process.stdout.write(text); emitKeypressEvents(process.stdin); process.stdin.setRawMode(true); process.stdin.resume();
  return new Promise((resolve, reject) => {
    let value = '';
    const done = error => {
      process.stdin.off('keypress', onKey); process.stdin.setRawMode(false); process.stdin.pause(); process.stdout.write('\n');
      if (error) reject(error); else resolve(value);
    };
    const onKey = (text, key = {}) => {
      if (key.ctrl && key.name === 'c') return done(new Error('Configuración cancelada.'));
      if (key.name === 'return' || key.name === 'enter') return done();
      if (key.name === 'backspace') { value = [...value].slice(0, -1).join(''); return; }
      if (!key.ctrl && !key.meta && text && !/[\x00-\x1f\x7f]/.test(text)) value += text;
    };
    process.stdin.on('keypress', onKey);
  });
}

try {
  console.log('\nPocket Terminal · Configuración\nLa contraseña no se mostrará mientras escribes.\n');
  let previous = {};
  try { previous = JSON.parse(await readFile(configPath, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const defaultCwd = await question(`Carpeta inicial [${previous.defaultCwd || homedir()}]: `) || previous.defaultCwd || homedir();
  if (!isAbsolute(defaultCwd) || !(await stat(defaultCwd)).isDirectory()) throw new Error('La carpeta debe existir y tener una ruta absoluta.');
  const publicOrigin = await question(`URL de acceso [${previous.publicOrigin || 'http://localhost:3210'}]: `) || previous.publicOrigin || 'http://localhost:3210';
  const password = await secret(previous.passwordHash ? 'Nueva contraseña (vacío para conservarla): ' : 'Contraseña (mínimo 12 caracteres): ');
  let credentials = { passwordHash: previous.passwordHash, passwordSalt: previous.passwordSalt };
  if (password || !previous.passwordHash) {
    if (password.length < 12 || password.length > 1024) throw new Error('Usa entre 12 y 1024 caracteres.');
    if (password !== await secret('Repite la contraseña: ')) throw new Error('Las contraseñas no coinciden.');
    credentials = await hashPassword(password);
  }
  const config = { port: previous.port ?? 3210, publicOrigin, defaultCwd, shell: previous.shell || (process.platform === 'win32' ? 'powershell.exe' : process.env.SHELL || '/bin/bash'), shellArgs: previous.shellArgs ?? (process.platform === 'win32' ? ['-NoLogo'] : ['-l']), ...credentials };
  validateConfig(config);
  await mkdir(dirname(configPath), { recursive: true, mode: 0o700 });
  await writeFile(configPath, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });
  console.log('\nConfiguración guardada. Ejecuta npm start (o scripts/Start.ps1).\nSi el servidor estaba abierto, reinícialo para aplicar los cambios.');
} catch (error) { console.error(error.message); process.exitCode = 1; }
