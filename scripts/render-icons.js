#!/usr/bin/env node
/**
 * Render the toolbar and store icons from the SVG sources in icons/source.
 * Small sizes use a bolder glyph that stays legible at 16 px.
 *
 *   npm run icons
 */
const { readFileSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const { chromium } = require('@playwright/test');

const ICONS = join(__dirname, '..', 'icons');

const OUTPUTS = [
  { source: 'logo-small.svg', size: 16, file: 'icon-16.png' },
  { source: 'logo-small.svg', size: 32, file: 'icon-32.png' },
  { source: 'logo.svg', size: 48, file: 'icon-48.png' },
  { source: 'logo.svg', size: 128, file: 'icon-128.png' },
  { source: 'logo-small-off.svg', size: 16, file: 'icon-off-16.png' },
  { source: 'logo-small-off.svg', size: 32, file: 'icon-off-32.png' },
];

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ deviceScaleFactor: 1 });
  for (const { source, size, file } of OUTPUTS) {
    const svg = readFileSync(join(ICONS, 'source', source), 'utf8');
    await page.setViewportSize({ width: size, height: size });
    await page.setContent(
      `<!doctype html><style>html,body{margin:0;background:transparent}svg{display:block;width:${size}px;height:${size}px}</style>${svg}`,
    );
    writeFileSync(join(ICONS, file), await page.screenshot({ omitBackground: true }));
    console.log(`icons/${file}`);
  }
  await browser.close();
})();
