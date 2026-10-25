const { test, expect, stateOf, waitForState, expectNoProtection, layers, overlayText } = require('./fixtures');

/** Wait for the video's first presented frame; resolves with its timestamp. */
function firstFrame(page, selector = '#v') {
  return page.evaluate((s) => new Promise((resolve) => {
    const v = document.querySelector(s);
    v.requestVideoFrameCallback((now) => resolve(now));
  }), selector);
}

/** Milliseconds from `since` until the element is hidden, or null after `timeout`. */
function msUntilHidden(page, since, timeout = 4000, selector = '#v') {
  return page.evaluate(([s, t0, limit]) => new Promise((resolve) => {
    const v = document.querySelector(s);
    const tick = () => {
      if (v.getAttribute('data-neuroshield') === 'hidden') return resolve(performance.now() - t0);
      if (performance.now() - t0 > limit) return resolve(null);
      requestAnimationFrame(tick);
    };
    tick();
  }), [selector, since, timeout]);
}

test.describe('flash detection in videos', () => {
  const cases = [
    // [fixture, what, budget in ms from the first frame]
    ['flash4hz.webm', '3.75 Hz black/white', 1300],
    ['flash12hz.webm', '12 Hz strobe, one flash per frame', 700],
    ['flash15hz.webm', '15 Hz strobe', 700],
    ['redblue12hz.webm', '12 Hz red/blue', 700],
    ['sine6hz60.webm', 'smooth 6 Hz at 60 fps', 1000],
  ];

  for (const [file, what, budget] of cases) {
    test(`hides a ${what} video within ${budget} ms`, async ({ page, servers }) => {
      await page.goto(`${servers.a}/video?src=${file}`);
      const start = await firstFrame(page);
      const ms = await msUntilHidden(page, start);
      expect(ms, 'time to hide').not.toBeNull();
      expect(ms).toBeLessThan(budget);
      expect(await layers(page)).toEqual(['block']);
      expect(await page.evaluate(() => document.getElementById('v').paused), 'paused while hidden').toBe(true);
      expect(page.noise, 'console noise').toEqual([]);
    });
  }

  test('says so when the flashes are red', async ({ page, servers }) => {
    await page.goto(`${servers.a}/video?src=redblue12hz.webm`);
    await waitForState(page, '#v', 'hidden');
    expect(await overlayText(page)).toContain('rapid red flashes');
  });

  test('leaves a steady video alone, even at maximum sensitivity', async ({ page, servers, extension }) => {
    await extension.setSettings({ sensitivity: 'maximum' });
    await page.goto(`${servers.a}/video?src=steady.webm`);
    await firstFrame(page);
    await expectNoProtection(page, '#v', 3000);
    expect(await layers(page)).toEqual([]);
    expect(page.noise).toEqual([]);
  });

  test('2.5 Hz flashing passes Medium (WCAG allows up to 3) but not High', async ({ page, servers, extension }) => {
    await page.goto(`${servers.a}/video?src=flash2-5hz.webm`);
    await firstFrame(page);
    await expectNoProtection(page, '#v', 2500);
    await extension.setSettings({ sensitivity: 'high' });
    await waitForState(page, '#v', 'hidden', 3000);
  });

  test('1.9 Hz flashing passes High but not Maximum', async ({ page, servers, extension }) => {
    await extension.setSettings({ sensitivity: 'high' });
    await page.goto(`${servers.a}/video?src=flash2hz.webm`);
    await firstFrame(page);
    await expectNoProtection(page, '#v', 2500);
    await extension.setSettings({ sensitivity: 'maximum' });
    await waitForState(page, '#v', 'hidden', 3000);
  });

  test('keeps playing when pausing is turned off', async ({ page, servers, extension }) => {
    await extension.setSettings({ pauseOnDetect: false });
    await page.goto(`${servers.a}/video?src=flash12hz.webm`);
    await waitForState(page, '#v', 'hidden');
    expect(await page.evaluate(() => document.getElementById('v').paused)).toBe(false);
  });

  test('protects a video added after the page loaded', async ({ page, servers }) => {
    await page.goto(`${servers.a}/video-later?src=flash12hz.webm`);
    await waitForState(page, '#v', 'hidden');
  });

  test('hides only the flashing one of two videos', async ({ page, servers }) => {
    await page.goto(`${servers.a}/two-videos?a=steady.webm&b=flash12hz.webm`);
    await waitForState(page, '#b', 'hidden');
    expect(await stateOf(page, '#a')).toBeNull();
  });

  test('protects a video inside a cross-origin iframe', async ({ page, servers }) => {
    await page.goto(`${servers.a}/iframe?src=flash12hz.webm`);
    const frame = page.frames().find((f) => f.url().startsWith(servers.b));
    await frame.waitForFunction(() => document.getElementById('v')?.getAttribute('data-neuroshield') === 'hidden', null, { timeout: 5000 });
  });
});
