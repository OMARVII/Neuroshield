const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const vm = require('node:vm');

const ROOT = join(__dirname, '..', '..');

/**
 * Run extension scripts (classic scripts that declare a global with `var`)
 * in a fresh VM context and return that context.
 * @param {string[]} files paths relative to the repo root
 * @param {object} [globals] extra globals for the context
 */
function loadScripts(files, globals = {}) {
  const context = vm.createContext({ console, ...globals });
  for (const file of files) {
    vm.runInContext(readFileSync(join(ROOT, file), 'utf8'), context, { filename: file });
  }
  return context;
}

function assertApprox(assert, actual, expected, tolerance, message) {
  assert.ok(Math.abs(actual - expected) < tolerance, `${message}: expected ~${expected}, got ${actual}`);
}

/** RGBA frame where every pixel has the same color. */
function solidFrame(r, g, b, a = 255, pixelCount = 32 * 32) {
  const data = new Uint8ClampedArray(pixelCount * 4);
  for (let i = 0; i < data.length; i += 4) {
    data[i] = r;
    data[i + 1] = g;
    data[i + 2] = b;
    data[i + 3] = a;
  }
  return data;
}

/**
 * Simulate sampling a periodic signal: returns samples taken every
 * `1000 / fps` ms over `durationMs`, where `signal(t)` gives the sample at
 * time t (ms).
 */
function sampleSignal(fps, durationMs, signal) {
  const samples = [];
  const interval = 1000 / fps;
  for (let i = 0; i * interval <= durationMs; i++) {
    const t = i * interval;
    samples.push({ timestamp: t, ...signal(t, i) });
  }
  return samples;
}

module.exports = { ROOT, loadScripts, assertApprox, solidFrame, sampleSignal };
