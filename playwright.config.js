const { defineConfig } = require('@playwright/test');

/**
 * End-to-end tests load the unpacked extension into Chromium and play real
 * videos. The "no-gpu" project repeats the detection tests with the 2D-canvas
 * fallback sampler (what users without GPU acceleration get).
 */
module.exports = defineConfig({
  testDir: 'test/e2e',
  timeout: 30_000,
  expect: { timeout: 5_000 },
  fullyParallel: false,
  workers: process.env.CI ? 2 : 3,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['github'], ['list']] : [['list']],
  projects: [
    { name: 'gpu', metadata: { chromiumArgs: [] } },
    {
      name: 'no-gpu',
      metadata: { chromiumArgs: ['--disable-gpu'] },
      testMatch: ['detection.spec.js', 'canvas-animation.spec.js'],
    },
  ],
});
