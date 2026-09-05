import { readFile, writeFile } from 'node:fs/promises';
import { configPath, validateConfig } from '../server/config.mjs';

// A temporary tunnel hands out a different URL every time it starts, so the
// interactive setup wizard is too slow a way to keep publicOrigin in step.
try {
  const input = process.argv[2];
  if (!input) throw new Error('Uso: npm run origin -- https://tu-tunel.trycloudflare.com');
  let origin;
  try { origin = new URL(input).origin; }
  catch { throw new Error(`No es una URL válida: ${input}`); }
  const config = JSON.parse(await readFile(configPath, 'utf8'));
  const previous = config.publicOrigin;
  config.publicOrigin = origin;
  validateConfig(config);
  await writeFile(configPath, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });
  console.log(`URL de acceso anterior: ${previous}`);
  console.log(`URL de acceso nueva:    ${origin}`);
  console.log('\nReinicia Pocket Terminal para aplicarla. Entra solo por esa URL: las demás quedan rechazadas.');
} catch (error) {
  console.error(error.code === 'ENOENT' ? 'Ejecuta primero npm run setup.' : error.message);
  process.exitCode = 1;
}
