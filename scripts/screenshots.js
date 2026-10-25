#!/usr/bin/env node
/**
 * Regenerate the README screenshots from the real extension.
 *
 *   npm run screenshots              → screenshots/ (README)
 *   npm run screenshots -- --store   → also store-assets/ (Chrome Web Store, not committed)
 */
const { readFileSync, mkdirSync } = require('node:fs');
const { join } = require('node:path');
const { chromium } = require('@playwright/test');
const { startServers } = require('../test/e2e/server');

const ROOT = join(__dirname, '..');
const OUT = join(ROOT, 'screenshots');

(async () => {
  const servers = await startServers();
  const context = await chromium.launchPersistentContext('', {
    channel: 'chromium',
    headless: true,
    deviceScaleFactor: 2,
    viewport: { width: 1000, height: 700 },
    args: [`--disable-extensions-except=${ROOT}`, `--load-extension=${ROOT}`, '--autoplay-policy=no-user-gesture-required'],
  });
  let [worker] = context.serviceWorkers();
  if (!worker) worker = await context.waitForEvent('serviceworker');
  const id = new URL(worker.url()).host;
  const welcome = context.pages().find((p) => p.url().includes('#welcome'))
    || (await context.waitForEvent('page', { predicate: (p) => p.url().includes('#welcome') }));
  await welcome.close();

  // Overlay over a flashing video
  const demo = await context.newPage();
  await demo.goto(`${servers.a}/demo?src=flash12hz.webm`);
  await demo.waitForFunction(() => document.getElementById('v').getAttribute('data-neuroshield') === 'hidden');
  await demo.waitForTimeout(400);
  await demo.screenshot({ path: join(OUT, 'overlay.png'), clip: { x: 100, y: 12, width: 800, height: 620 } });
  console.log('screenshots/overlay.png');

  // Popup, light and dark, for the demo tab
  const tabId = await worker.evaluate(async (url) => (await chrome.tabs.query({})).find((t) => t.url === url).id, demo.url());
  for (const scheme of ['light', 'dark']) {
    const popup = await context.newPage();
    await popup.emulateMedia({ colorScheme: scheme });
    await popup.setViewportSize({ width: 340, height: 600 });
    await popup.goto(`chrome-extension://${id}/src/popup/popup.html?tab=${tabId}`);
    await popup.waitForTimeout(500);
    const height = await popup.evaluate(() => Math.ceil(document.querySelector('.popup').getBoundingClientRect().height));
    await popup.screenshot({ path: join(OUT, `popup-${scheme}.png`), clip: { x: 0, y: 0, width: 340, height } });
    console.log(`screenshots/popup-${scheme}.png`);
    await popup.close();
  }

  // Options page (top part)
  const options = await context.newPage();
  await options.setViewportSize({ width: 820, height: 980 });
  await options.goto(`chrome-extension://${id}/src/options/options.html`);
  await options.waitForTimeout(300);
  await options.screenshot({ path: join(OUT, 'options.png') });
  console.log('screenshots/options.png');

  if (process.argv.includes('--store')) await storeAssets(context, id, servers);

  await context.close();
  await servers.close();
})();

/** 1280×800 screenshots and the 440×280 promo tile for the Chrome Web Store. */
async function storeAssets(context, id, servers) {
  const STORE = join(ROOT, 'store-assets');
  mkdirSync(STORE, { recursive: true });
  const dataUrl = (file) => 'data:image/png;base64,' + readFileSync(file).toString('base64');
  // Single quotes: this goes inside style="…" attributes.
  const font = "ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif";

  // 1. The card over a flashing video, full size.
  const demo = await context.newPage();
  await demo.setViewportSize({ width: 1280, height: 800 });
  await demo.goto(`${servers.a}/demo?src=flash12hz.webm`);
  await demo.waitForFunction(() => document.getElementById('v').getAttribute('data-neuroshield') === 'hidden');
  await demo.waitForTimeout(400);
  await demo.screenshot({ path: join(STORE, '1-hidden.png'), scale: 'css' });

  // 2–3. Popup and settings, with a headline.
  const page = await context.newPage();
  const shot = (name) => dataUrl(join(OUT, name));
  for (const [file, title, body, image, width] of [
    ['2-popup.png', 'See what it\'s doing on every page', 'Pause it per site, change sensitivity, or hide everything on the page with one click.', shot('popup-light.png'), 340],
    ['3-settings.png', 'Settings that make sense', 'Four sensitivity levels, from the WCAG standard to maximum caution. Everything stays on your device.', shot('options.png'), 520],
  ]) {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.setContent(`<!doctype html><body style="margin:0;width:1280px;height:800px;display:grid;grid-template-columns:1fr auto;align-items:center;gap:56px;padding:0 80px;box-sizing:border-box;background:linear-gradient(135deg,#ecfdf9,#f4f5f7 55%);font-family:${font};color:#111827">
      <div><img src="${dataUrl(join(ROOT, 'icons/icon-128.png'))}" width="56" height="56"><h1 style="font-size:44px;line-height:1.1;letter-spacing:-.02em;margin:22px 0 14px">${title}</h1><p style="font-size:20px;line-height:1.5;color:#4b5563;margin:0;max-width:520px">${body}</p></div>
      <img src="${image}" style="width:${width}px;max-height:700px;object-fit:cover;object-position:top;border-radius:16px;box-shadow:0 30px 60px rgba(15,23,42,.18),0 0 0 1px rgba(15,23,42,.06)"></body>`);
    await page.screenshot({ path: join(STORE, file), scale: 'css' });
  }

  // 4. "Hide everything on this page", triggered through the extension like the shortcut does.
  const busy = await context.newPage();
  await busy.setViewportSize({ width: 1280, height: 800 });
  await busy.goto(`${servers.a}/demo?src=steady.webm`);
  await busy.waitForFunction(() => document.getElementById('v').currentTime > 0.3);
  const options = context.pages().find((p) => p.url().startsWith(`chrome-extension://${id}/`)) || (await context.newPage());
  if (!options.url().startsWith('chrome-extension://')) await options.goto(`chrome-extension://${id}/src/options/options.html`);
  await options.evaluate(async (url) => {
    const tab = (await chrome.tabs.query({})).find((t) => t.url === url);
    await chrome.runtime.sendMessage({ type: 'hide-page', tabId: tab.id });
  }, busy.url());
  await busy.waitForFunction(() => document.querySelector('[data-neuroshield-overlay="page"]'));
  await busy.waitForTimeout(400);
  await busy.screenshot({ path: join(STORE, '4-page-hidden.png'), scale: 'css' });

  // Promo tile
  await page.setViewportSize({ width: 440, height: 280 });
  await page.setContent(`<!doctype html><body style="margin:0;width:440px;height:280px;display:grid;place-items:center;background:linear-gradient(135deg,#0f766e,#134e4a);font-family:${font};color:#fff">
    <div style="text-align:center"><img src="${dataUrl(join(ROOT, 'icons/icon-128.png'))}" width="72" height="72"><div style="font-size:30px;font-weight:700;letter-spacing:-.02em;margin-top:10px">NeuroShield</div><div style="font-size:15px;opacity:.85;margin-top:4px">Hides flashing content on every site</div></div></body>`);
  await page.screenshot({ path: join(STORE, 'promo-440x280.png'), scale: 'css' });
  console.log('store-assets/: 1-hidden.png 2-popup.png 3-settings.png 4-page-hidden.png promo-440x280.png');
}
