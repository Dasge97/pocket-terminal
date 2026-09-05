import { createRequire } from 'node:module';
import { once } from 'node:events';
import { createApp } from './server/app.mjs';
import { hashPassword } from './server/auth.mjs';
import { validateConfig } from './server/config.mjs';
const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const PORT = 3398, BASE = `http://localhost:${PORT}`, CLAVE = 'clave-de-prueba-larga';
const app = createApp(validateConfig({ port: PORT, publicOrigin: BASE, defaultCwd: 'C:\\AreaDeTrabajo', ...await hashPassword(CLAVE) }));
app.server.listen(PORT, '127.0.0.1'); await once(app.server, 'listening');

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({
  viewport: { width: 390, height: 664 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true,
  userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
});
const page = await context.newPage();
page.on('pageerror', e => console.log('  [error]', e.message.slice(0, 160)));
await page.goto(BASE, { waitUntil: 'networkidle' });
await page.waitForSelector('#login-view:not([hidden])');
await page.screenshot({ path: 'v-login.png' });

await page.fill('#password', CLAVE);
await page.click('#login-button');
await page.waitForSelector('#workspace:not([hidden])', { timeout: 15000 });
await page.click('#first-terminal');
await page.waitForSelector('#new-dialog[open]');
await page.fill('#session-cwd', 'C:/AreaDeTrabajo/pocket-terminal');
await page.waitForTimeout(400);
await page.screenshot({ path: 'v-nueva.png' });
await page.click('#browse-button');
await page.waitForSelector('#browse-dialog[open]');
await page.waitForTimeout(2500);
await page.screenshot({ path: 'v-explorador.png' });
await page.click('#browse-pick');
await page.waitForTimeout(300);
await page.click('#create-button');
await page.waitForSelector('#terminal:not([hidden])', { timeout: 20000 });
await page.waitForTimeout(6000);
await page.click('#terminal .xterm-screen');
await page.keyboard.type('ls', { delay: 20 });
await page.keyboard.press('Enter');
await page.waitForTimeout(3000);
await page.screenshot({ path: 'v-terminal.png' });
if (await page.evaluate(() => document.getElementById('tools').hidden)) { await page.click('#tools-tab'); await page.waitForTimeout(700); }
await page.screenshot({ path: 'v-panel.png' });
await page.click('#settings-button');
await page.waitForTimeout(600);
await page.screenshot({ path: 'v-ajustes.png' });
await browser.close();
await app.close();
console.log('capturas hechas');
process.exit(0);
