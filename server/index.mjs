import { createApp } from './app.mjs';
import { loadConfig } from './config.mjs';

try {
  const config = await loadConfig();
  const app = createApp(config);
  app.server.on('error', error => {
    console.error(error.code === 'EADDRINUSE' ? 'Pocket Terminal ya está abierto o el puerto está ocupado.' : error.message);
    app.close().finally(() => process.exit(1));
  });
  app.server.listen(config.port, config.host, () => {
    console.log(`\nPocket Terminal\nAbre: ${config.publicOrigin}\nTerminal: ${config.shell}\nMantén este proceso abierto. Ctrl+C para detenerlo.\n`);
  });
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    const timer = setTimeout(() => process.exit(1), 5000);
    timer.unref();
    await app.close(); process.exit(0);
  };
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
} catch (error) { console.error(error.message); process.exitCode = 1; }
