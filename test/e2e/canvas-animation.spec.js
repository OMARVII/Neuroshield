const { test, expect, waitForState, expectNoProtection, layers } = require('./fixtures');

test.describe('canvas', () => {
  test('hides a flashing 2D canvas', async ({ page, servers }) => {
    await page.goto(`${servers.a}/canvas?hz=6`);
    await waitForState(page, '#c', 'transparent', 5000);
    expect(await layers(page)).toEqual(['block']);
  });

  test('hides a flashing WebGL canvas', async ({ page, servers }) => {
    await page.goto(`${servers.a}/canvas?hz=6&ctx=webgl`);
    await waitForState(page, '#c', 'transparent', 5000);
  });

  test('sees a transparent canvas flashing against the page behind it', async ({ page, servers }) => {
    // clearRect ↔ black fill on a white page: transparent pixels must count as page white, not black.
    await page.goto(`${servers.a}/canvas?hz=6&mode=clear`);
    await waitForState(page, '#c', 'transparent', 5000);
  });

  test('leaves a still 2D canvas alone', async ({ page, servers, extension }) => {
    await extension.setSettings({ sensitivity: 'maximum' });
    await page.goto(`${servers.a}/canvas?hz=0`);
    await expectNoProtection(page, '#c', 3000);
  });

  test('a WebGL canvas read between frames is not mistaken for flashing', async ({ page, servers, extension }) => {
    await extension.setSettings({ sensitivity: 'maximum' });
    await page.goto(`${servers.a}/canvas?hz=0&ctx=webgl`);
    await expectNoProtection(page, '#c', 3000);
  });
});

test.describe('CSS animations', () => {
  const animationState = (page) => page.evaluate(() => document.getElementById('box').getAnimations()[0]?.playState);

  test('pauses a flashing CSS animation', async ({ page, servers }) => {
    await page.goto(`${servers.a}/css?kind=flash`);
    await expect.poll(() => animationState(page), { timeout: 5000 }).toBe('paused');
    expect(await layers(page)).toEqual(['block']);
  });

  test('pauses a transparent element blinking its content', async ({ page, servers }) => {
    await page.goto(`${servers.a}/css?kind=blink`);
    await expect.poll(() => animationState(page), { timeout: 5000 }).toBe('paused');
  });

  test('catches a flashing animation that was off screen at first', async ({ page, servers }) => {
    await page.goto(`${servers.a}/css?kind=flash&below=1`);
    await page.waitForTimeout(2500);
    expect(await animationState(page), 'not judged while off screen').toBe('running');
    await page.evaluate(() => document.getElementById('box').scrollIntoView());
    await expect.poll(() => animationState(page), { timeout: 5000 }).toBe('paused');
  });

  test('keeps a restarted animation paused while it is blocked', async ({ page, servers }) => {
    await page.goto(`${servers.a}/css?kind=flash`);
    await expect.poll(() => animationState(page), { timeout: 5000 }).toBe('paused');
    await page.evaluate(() => {
      const box = document.getElementById('box');
      box.style.animation = 'none';
      void box.offsetWidth;
      box.style.animation = '';
    });
    await page.waitForTimeout(400);
    expect(await animationState(page)).toBe('paused');
  });

  for (const kind of ['spinner', 'pulse']) {
    test(`leaves a ${kind} animation running`, async ({ page, servers, extension }) => {
      await extension.setSettings({ sensitivity: 'maximum' });
      await page.goto(`${servers.a}/css?kind=${kind}`);
      await page.waitForTimeout(2500);
      expect(await animationState(page)).toBe('running');
      expect(await layers(page)).toEqual([]);
    });
  }
});
