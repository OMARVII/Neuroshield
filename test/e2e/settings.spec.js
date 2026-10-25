const { test, expect, stateOf, waitForState, expectNoProtection, layers } = require('./fixtures');

const playSource = (page, src) => page.evaluate((s) => {
  const v = document.getElementById('v');
  v.src = s;
  return v.play();
}, src);

// v1.0 only applied settings after a reload: the popup broadcast to tabs
// skipped every tab because tab.url is undefined without the "tabs" permission.
test.describe('settings apply to open tabs immediately', () => {
  test('turning protection off reveals hidden content and stops watching', async ({ page, servers, extension }) => {
    await page.goto(`${servers.a}/video?src=flash12hz.webm`);
    await waitForState(page, '#v', 'hidden');
    await extension.setSettings({ enabled: false });
    await expect.poll(() => stateOf(page, '#v')).toBeNull();
    expect(await layers(page)).toEqual([]);
    await page.evaluate(() => document.getElementById('v').play());
    await expectNoProtection(page, '#v', 2000);
  });

  test('turning protection back on protects the same tab again', async ({ page, servers, extension }) => {
    await extension.setSettings({ enabled: false });
    await page.goto(`${servers.a}/video?src=steady.webm`);
    await extension.setSettings({ enabled: true });
    await playSource(page, 'flash12hz.webm');
    await waitForState(page, '#v', 'hidden');
  });

  test('pausing a site stops protection there, resuming restores it', async ({ page, servers, extension }) => {
    await extension.setSettings({ disabledSites: ['127.0.0.1'] });
    await page.goto(`${servers.a}/video?src=flash12hz.webm`);
    await expectNoProtection(page, '#v', 2000);
    await extension.setSettings({ disabledSites: [] });
    await playSource(page, 'flash15hz.webm');
    await waitForState(page, '#v', 'hidden');
  });

  test('a paused site also covers its cross-origin frames', async ({ page, servers, extension }) => {
    await extension.setSettings({ disabledSites: ['127.0.0.1'] });
    await page.goto(`${servers.a}/iframe?src=flash12hz.webm`);
    const frame = page.frames().find((f) => f.url().startsWith(servers.b));
    await frame.waitForFunction(() => document.getElementById('v')?.currentTime > 2, null, { timeout: 6000 });
    expect(await frame.evaluate(() => document.getElementById('v').getAttribute('data-neuroshield'))).toBeNull();
  });
});

test.describe('videos that cannot be scanned', () => {
  test('cross-origin video gets a small notice, not a cover', async ({ page, servers }) => {
    await page.goto(`${servers.a}/xorigin?src=steady.webm`);
    await expect.poll(() => layers(page)).toEqual(['notice']);
    expect(await stateOf(page, '#v')).toBeNull();
  });

  test('"Dim them automatically" dims cross-origin video', async ({ page, servers, extension }) => {
    await extension.setSettings({ unscannable: 'dim' });
    await page.goto(`${servers.a}/xorigin?src=steady.webm`);
    await waitForState(page, '#v', 'dimmed');
  });

  test('"Do nothing" leaves cross-origin video alone', async ({ page, servers, extension }) => {
    await extension.setSettings({ unscannable: 'off' });
    await page.goto(`${servers.a}/xorigin?src=steady.webm`);
    await page.waitForTimeout(1500);
    expect(await layers(page)).toEqual([]);
    expect(await stateOf(page, '#v')).toBeNull();
  });

  test('changing the setting applies to videos already on the page', async ({ page, servers, extension }) => {
    await page.goto(`${servers.a}/xorigin?src=steady.webm`);
    await expect.poll(() => layers(page)).toEqual(['notice']);
    await extension.setSettings({ unscannable: 'dim' });
    await waitForState(page, '#v', 'dimmed');
  });
});
