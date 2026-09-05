import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const projectRoot = fileURLToPath(new URL('../', import.meta.url));
export const configPath = resolve(projectRoot, '.pocket-terminal/config.json');

export function validateConfig(input) {
  const port = input.port ?? 3210;
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Puerto inválido.');
  const origin = new URL(input.publicOrigin ?? `http://localhost:${port}`);
  if (origin.origin !== input.publicOrigin && input.publicOrigin !== undefined) throw new Error('publicOrigin debe ser un origen sin ruta ni barra final.');
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname);
  if (origin.protocol !== 'https:' && !(origin.protocol === 'http:' && local && origin.port === String(port))) {
    throw new Error('El acceso remoto requiere un origen HTTPS.');
  }
  if (!/^[a-f0-9]{32}$/.test(input.passwordSalt ?? '') || !/^[a-f0-9]{128}$/.test(input.passwordHash ?? '')) {
    throw new Error('Falta configurar la contraseña. Ejecuta npm run setup.');
  }
  if (input.shellArgs !== undefined && (!Array.isArray(input.shellArgs) || input.shellArgs.some(a => typeof a !== 'string'))) {
    throw new Error('shellArgs debe ser una lista de argumentos.');
  }
  return {
    port, host: '127.0.0.1', publicOrigin: origin.origin,
    passwordSalt: input.passwordSalt, passwordHash: input.passwordHash,
    shell: input.shell || (process.platform === 'win32' ? 'powershell.exe' : process.env.SHELL || '/bin/bash'),
    shellArgs: input.shellArgs ?? (process.platform === 'win32' ? ['-NoLogo'] : ['-l']),
    defaultCwd: input.defaultCwd || homedir(),
    maxSessions: 8,
    scrollback: 3000,
    // Reattaching happens every time the phone returns to the foreground, so the
    // first snapshot carries the screen plus a short tail. The client asks for
    // the rest only when the user scrolls past it.
    snapshotScrollback: 500,
    authLifetimeMs: 12 * 60 * 60 * 1000,
    distPath: resolve(projectRoot, 'dist'),
  };
}

export async function loadConfig() {
  try { return validateConfig(JSON.parse(await readFile(configPath, 'utf8'))); }
  catch (error) {
    if (error.code === 'ENOENT') throw new Error('Ejecuta primero npm run setup para configurar Pocket Terminal.');
    throw error;
  }
}
