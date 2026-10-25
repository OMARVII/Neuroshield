/**
 * Playwright fixtures: a Chromium profile with NeuroShield loaded (one per
 * worker), the test servers, and helpers for reaching into the extension.
 */
const path = require('node:path');
const { test: base, expect, chromium } = require('@playwright/test');
const { startServers } = require('./server');

const EXTENSION_DIR = path.join(__dirname, '..', '..');

const DEFAULT_SETTINGS = {
  enabled: true,
  sensitivity: 'medium',
  pauseOnDetect: true,
  unscannable: 'notice',
  disabledSites: [],
};

const test = base.extend({
  servers: [
    async ({}, use) => {
      const servers = await startServers();
      await use(servers);
      await servers.close();
    },
    { scope: 'worker' },
  ],

  extension: [
    async ({}, use, workerInfo) => {
      const context = await chromium.launchPersistentContext('', {
        channel: 'chromium',
        headless: true,
        viewport: { width: 1100, height: 760 },
        args: [
          `--disable-extensions-except=${EXTENSION_DIR}`,
          `--load-extension=${EXTENSION_DIR}`,
          '--autoplay-policy=no-user-gesture-required',
          ...(workerInfo.project.metadata.chromiumArgs || []),
        ],
      });
      let [worker] = context.serviceWorkers();
      if (!worker) worker = await context.waitForEvent('serviceworker');
      const id = new URL(worker.url()).host;

      // The welcome tab opens on install. Wait for it before tests start: if it
      // opens mid-test it takes focus (and Chrome exits fullscreen).
      const isWelcome = (p) => p.url().includes('options.html#welcome');
      const welcome = context.pages().find(isWelcome) || (await context.waitForEvent('page', { predicate: isWelcome, timeout: 10_000 }));
      await welcome.close();
      const api = await context.newPage();
      await api.goto(`chrome-extension://${id}/src/options/options.html`);
      for (const p of context.pages()) if (p !== api) await p.close();

      await use({
        context,
        id,
        api,
        url: (file) => `chrome-extension://${id}/${file}`,
        /** Run a function with the chrome.* APIs (in an extension page). */
        run: (fn, arg) => api.evaluate(fn, arg),
        setSettings: (patch) => api.evaluate((p) => chrome.storage.local.set(p), patch),
        /** Count pixels near an RGB color in a PNG (decoded in the extension page, which allows data: URLs). */
        countColor: (png, rgb, tolerance = 12) => api.evaluate(async ([b64, [r, g, b], tol]) => {
          const img = new Image();
          img.src = 'data:image/png;base64,' + b64;
          await img.decode();
          const c = new OffscreenCanvas(img.width, img.height);
          const x = c.getContext('2d');
          x.drawImage(img, 0, 0);
          const d = x.getImageData(0, 0, img.width, img.height).data;
          let n = 0;
          for (let i = 0; i < d.length; i += 4) {
            if (Math.abs(d[i] - r) < tol && Math.abs(d[i + 1] - g) < tol && Math.abs(d[i + 2] - b) < tol) n++;
          }
          return n;
        }, [png.toString('base64'), rgb, tolerance]),
        tabIdOf: async (page) => {
          const url = page.url();
          return api.evaluate(async (u) => (await chrome.tabs.query({})).find((t) => t.url === u).id, url);
        },
      });
      await context.close();
    },
    { scope: 'worker' },
  ],

  page: async ({ extension }, use) => {
    await extension.run(async (defaults) => {
      await chrome.storage.local.set(Object.assign({}, defaults, { stats: { totalDetections: 0 } }));
    }, DEFAULT_SETTINGS);
    const page = await extension.context.newPage();
    const noise = [];
    page.on('console', (m) => {
      if (m.type() === 'error' || m.type() === 'warning') noise.push(m.text());
    });
    page.on('pageerror', (e) => noise.push(e.message));
    page.noise = noise;
    await use(page);
    for (const p of extension.context.pages()) if (p !== extension.api) await p.close();
  },
});

// ─── Helpers ───────────────────────────────────────────────────────────

/** Protection state NeuroShield put on an element: 'hidden', 'transparent', 'dimmed' or null. */
function stateOf(page, selector) {
  return page.evaluate((s) => {
    const el = typeof s === 'string' ? document.querySelector(s) : window.__video;
    return el ? el.getAttribute('data-neuroshield') : 'missing';
  }, selector);
}

async function waitForState(page, selector, expected, timeout = 4000) {
  await page.waitForFunction(
    ([s, want]) => {
      const el = typeof s === 'string' ? document.querySelector(s) : window.__video;
      return !!el && el.getAttribute('data-neuroshield') === want;
    },
    [selector, expected],
    { timeout },
  );
}

/** Assert an element stays unprotected for `ms`. */
async function expectNoProtection(page, selector, ms = 2500) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    expect(await stateOf(page, selector)).toBeNull();
    await page.waitForTimeout(100);
  }
}

/** Kinds of NeuroShield UI layers on the page ('block', 'dimmed', 'notice', 'page'). */
function layers(page) {
  return page.evaluate(() => [...document.querySelectorAll('[data-neuroshield-overlay]')].map((h) => h.getAttribute('data-neuroshield-overlay')));
}

/**
 * Click a button inside NeuroShield's closed shadow root by its accessible
 * name. Uses the accessibility tree (which sees closed roots) and a real mouse
 * click, the same way a user would.
 */
async function pressButton(page, name) {
  const cdp = await page.context().newCDPSession(page);
  try {
    await cdp.send('Accessibility.enable');
    const deadline = Date.now() + 3000;
    let node;
    while (!node && Date.now() < deadline) {
      const { root } = await cdp.send('DOM.getDocument', { depth: 0 });
      const { nodes } = await cdp.send('Accessibility.queryAXTree', { nodeId: root.nodeId, accessibleName: name, role: 'button' });
      node = nodes.find((n) => n.backendDOMNodeId);
      if (!node) await page.waitForTimeout(100);
    }
    if (!node) throw new Error(`No button named "${name}"`);
    const { model } = await cdp.send('DOM.getBoxModel', { backendNodeId: node.backendDOMNodeId });
    const [x1, y1, , , x3, y3] = model.border;
    await page.mouse.click((x1 + x3) / 2, (y1 + y3) / 2);
  } finally {
    await cdp.detach();
  }
}

/** Text NeuroShield's UI exposes to assistive technology. */
async function overlayText(page) {
  const cdp = await page.context().newCDPSession(page);
  try {
    await cdp.send('Accessibility.enable');
    const { nodes } = await cdp.send('Accessibility.getFullAXTree');
    return nodes.map((n) => n.name && n.name.value).filter(Boolean).join(' | ');
  } finally {
    await cdp.detach();
  }
}

module.exports = { test, expect, DEFAULT_SETTINGS, stateOf, waitForState, expectNoProtection, layers, pressButton, overlayText };
