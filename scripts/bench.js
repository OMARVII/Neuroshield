#!/usr/bin/env node
/**
 * Measure NeuroShield's main-thread cost while a 1080p60 video plays.
 *
 *   npm run bench                       # this checkout vs. no extension
 *   npm run bench -- --compare <dir>    # also an unpacked build in <dir>
 *
 * Reports main-thread script time per second of playback (Chrome's
 * ScriptDuration metric; the test page runs no scripts of its own, so it is
 * the extension's) and long tasks. Needs ffmpeg for the test clip.
 */
const { execFileSync } = require('node:child_process');
const { existsSync, mkdirSync } = require('node:fs');
const { join, resolve } = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { createReadStream, statSync } = require('node:fs');
const { chromium } = require('@playwright/test');

const ROOT = join(__dirname, '..');
const SECONDS = 6;

function clip() {
  const dir = join(os.tmpdir(), 'neuroshield-bench');
  const file = join(dir, 'hd1080p60.mp4');
  if (!existsSync(file)) {
    mkdirSync(dir, { recursive: true });
    console.log('Generating a 1080p60 test clip with ffmpeg…');
    execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=s=1920x1080:r=60:d=12',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-b:v', '6M', file]);
  }
  return file;
}

function serve(file) {
  const server = http.createServer((req, res) => {
    if (req.url === '/') {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<!doctype html><body style="margin:0;background:#000"><video src="/clip.mp4" muted autoplay loop playsinline style="width:100vw;height:100vh"></video>');
      return;
    }
    if (req.url === '/clip.mp4') {
      res.writeHead(200, { 'content-type': 'video/mp4', 'content-length': statSync(file).size });
      createReadStream(file).pipe(res);
      return;
    }
    res.writeHead(404);
    res.end();
  });
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r(server)));
}

async function measure(label, extensionDir, url) {
  const args = ['--autoplay-policy=no-user-gesture-required'];
  if (extensionDir) args.push(`--disable-extensions-except=${extensionDir}`, `--load-extension=${extensionDir}`);
  const context = await chromium.launchPersistentContext('', { channel: 'chromium', headless: true, viewport: { width: 1280, height: 720 }, args });
  await new Promise((r) => setTimeout(r, 1500));
  for (const p of context.pages()) if (p.url().startsWith('chrome-extension://')) await p.close();
  const page = await context.newPage();
  await page.goto(url);
  await page.waitForFunction(() => document.querySelector('video').currentTime > 1);
  await page.evaluate(() => {
    window.__long = [];
    new PerformanceObserver((list) => window.__long.push(...list.getEntries().map((e) => e.duration))).observe({ type: 'longtask' });
  });
  const cdp = await context.newCDPSession(page);
  await cdp.send('Performance.enable');
  const metric = async () => Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map((m) => [m.name, m.value]));
  const before = await metric();
  await page.waitForTimeout(SECONDS * 1000);
  const after = await metric();
  const longTasks = await page.evaluate(() => window.__long);
  const dropped = await page.evaluate(() => document.querySelector('video').getVideoPlaybackQuality().droppedVideoFrames);
  await context.close();
  return {
    build: label,
    'script ms/s': +(((after.ScriptDuration - before.ScriptDuration) * 1000) / SECONDS).toFixed(1),
    'busy ms/s': +(((after.TaskDuration - before.TaskDuration) * 1000) / SECONDS).toFixed(1),
    'long tasks': longTasks.length,
    'dropped frames': dropped,
  };
}

(async () => {
  const server = await serve(clip());
  const url = `http://127.0.0.1:${server.address().port}/`;
  const compareIndex = process.argv.indexOf('--compare');
  const runs = [['no extension', null], ['this checkout', ROOT]];
  if (compareIndex > 0) runs.push([`compare (${process.argv[compareIndex + 1]})`, resolve(process.argv[compareIndex + 1])]);
  const rows = [];
  for (const [label, dir] of runs) rows.push(await measure(label, dir, url));
  console.table(rows);
  server.close();
})();
