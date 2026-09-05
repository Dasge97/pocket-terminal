import { announce, readTelegram, startService } from './runtime.mjs';

// Arranque directo, sin menú. El panel (scripts/panel.mjs) es lo que abre el
// icono; esto queda para lanzarlo desde una consola en un solo paso.
const localOnly = process.argv.includes('--local');

try {
  const result = await startService({ localOnly, log: message => console.log(message) });
  console.log([
    '',
    result.alreadyRunning ? '  Ya estaba en marcha.' : '  Pocket Terminal arrancado.',
    '',
    `  Direccion:  ${result.url}`,
    `  Contrasena: ${result.password}`,
    '',
    localOnly ? '  Solo accesible desde este ordenador.' : '  Accesible desde internet.',
    '  Sigue en marcha aunque cierres esta ventana. Para pararlo, abre el panel.',
    '',
  ].join('\n'));

  const telegram = await readTelegram();
  if (telegram && !result.alreadyRunning) {
    try { await announce(telegram, result.url, result.password); console.log('  Enviado por Telegram.\n'); }
    catch (error) { console.log(`  No se pudo enviar por Telegram: ${error.message}\n`); }
  }
} catch (error) {
  console.error(`\n${error.message}\n`);
  process.exitCode = 1;
}
