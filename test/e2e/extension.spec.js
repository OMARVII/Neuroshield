const { test, expect, waitForState, layers } = require('./fixtures');

/** Open the popup as a page, pointed at `tabId`. */
async function openPopup(extension, tabId) {
  const popup = await extension.context.newPage();
  await popup.goto(extension.url(`src/popup/popup.html?tab=${tabId}`));
  return popup;
}

test.describe('toolbar popup', () => {
  test('reports what is happening on the page', async ({ page, servers, extension }) => {
    await page.goto(`${servers.a}/video?src=flash12hz.webm`);
    await waitForState(page, '#v', 'hidden');
    const tabId = await extension.tabIdOf(page);
    const popup = await openPopup(extension, tabId);
    await expect(popup.locator('#heroTitle')).toHaveText('Protected');
    await expect(popup.locator('#heroDetail')).toHaveText('Watching 1 video');
    await expect(popup.locator('#pageCount')).toHaveText('1');
    await expect(popup.locator('#totalCount')).toHaveText('1');
    await expect(popup.locator('#siteHost')).toHaveText('127.0.0.1');
    expect(await extension.run((id) => chrome.action.getBadgeText({ tabId: id }), tabId)).toBe('1');
  });

  test('switches sensitivity and pauses the site', async ({ page, servers, extension }) => {
    await page.goto(`${servers.a}/blank`);
    const popup = await openPopup(extension, await extension.tabIdOf(page));
    await expect(popup.locator('#heroDetail')).toHaveText('Nothing is playing right now');
    await popup.click('#sensitivity [data-value="high"]');
    await expect(popup.locator('#sensitivity [data-value="high"]')).toHaveAttribute('aria-checked', 'true');
    await expect(popup.locator('#sensitivityHint')).toContainText('more than 2');
    await popup.locator('#siteEnabled').uncheck();
    await expect(popup.locator('#heroTitle')).toHaveText('Paused on 127.0.0.1');
    const stored = await extension.run(() => chrome.storage.local.get(['sensitivity', 'disabledSites']));
    expect(stored).toEqual({ sensitivity: 'high', disabledSites: ['127.0.0.1'] });
  });

  test('shows when protection is off', async ({ page, servers, extension }) => {
    await page.goto(`${servers.a}/blank`);
    const popup = await openPopup(extension, await extension.tabIdOf(page));
    await popup.locator('#enabled').uncheck();
    await expect(popup.locator('#heroTitle')).toHaveText('Protection is off');
    await expect(popup.locator('#sensitivity [data-value="medium"]')).toBeDisabled();
  });
});

test.describe('hide everything on this page', () => {
  test('covers the page and pauses media, then restores it', async ({ page, servers, extension }) => {
    await page.goto(`${servers.a}/video?src=steady.webm`);
    await page.waitForFunction(() => document.getElementById('v').currentTime > 0.2);
    const tabId = await extension.tabIdOf(page);
    await extension.run((id) => chrome.runtime.sendMessage({ type: 'hide-page', tabId: id }), tabId);
    await expect.poll(() => layers(page)).toEqual(['page']);
    expect(await page.evaluate(() => document.getElementById('v').paused)).toBe(true);
    await extension.run((id) => chrome.runtime.sendMessage({ type: 'show-page', tabId: id }), tabId);
    await expect.poll(() => layers(page)).toEqual([]);
    await expect.poll(() => page.evaluate(() => document.getElementById('v').paused)).toBe(false);
  });
});

test.describe('installation into open tabs', () => {
  test('injecting again does not double up protection', async ({ page, servers, extension }) => {
    await page.goto(`${servers.a}/video?src=steady.webm`);
    const tabId = await extension.tabIdOf(page);
    const ok = await extension.run((id) => chrome.runtime.sendMessage({ type: 'protect-tab', tabId: id }), tabId);
    expect(ok).toBe(true);
    await page.evaluate(() => {
      const v = document.getElementById('v');
      v.src = 'flash12hz.webm';
      v.play();
    });
    await waitForState(page, '#v', 'hidden');
    await page.waitForTimeout(300);
    expect(await layers(page)).toEqual(['block']);
  });

  // After an update Chrome injects the new copy next to the old one. The
  // handover must never leave hidden flashing content playing in the open.
  test('a new copy takes over without exposing hidden video', async ({ page, servers, extension }) => {
    await extension.setSettings({ pauseOnDetect: false });
    await page.goto(`${servers.a}/video?src=flash12hz.webm`);
    await waitForState(page, '#v', 'hidden');
    expect(await page.evaluate(() => document.getElementById('v').paused)).toBe(false);

    const tabId = await extension.tabIdOf(page);
    await extension.run((id) => chrome.runtime.sendMessage({ type: 'protect-tab', tabId: id }), tabId);
    await expect.poll(() => page.evaluate(() => document.getElementById('v').paused), { message: 'paused during handover' }).toBe(true);

    await page.evaluate(() => document.getElementById('v').play());
    await waitForState(page, '#v', 'hidden');
    await page.waitForTimeout(300);
    expect(await layers(page)).toEqual(['block']);
  });
});

test.describe('test protection (options page)', () => {
  test('catches the off-screen strobe and shows the real card', async ({ page, extension }) => {
    await page.goto(extension.url('src/options/options.html#test'));
    await page.click('#runTest');
    await expect(page.locator('#testStage')).toHaveAttribute('data-state', 'caught', { timeout: 5000 });
    await expect(page.locator('#testResult')).toContainText(/Working\. Caught the strobe in \d\.\d\d s\./);
    expect(await layers(page)).toEqual(['block']);
    // Nothing was ever drawn to the page: the strobe canvas is never attached.
    expect(await page.evaluate(() => document.querySelectorAll('canvas').length)).toBe(0);
    await page.click('#runTest');
    await expect(page.locator('#testStage')).toHaveAttribute('data-state', 'caught', { timeout: 5000 });
    expect(await layers(page), 'one card at a time').toEqual(['block']);
    expect(page.noise).toEqual([]);
  });

  test('says so when protection is off', async ({ page, extension }) => {
    await extension.setSettings({ enabled: false });
    await page.goto(extension.url('src/options/options.html'));
    await page.click('#runTest');
    await expect(page.locator('#testResult')).toContainText('Protection is turned off right now');
  });
});

test.describe('pages NeuroShield can\'t run on', () => {
  test('the popup drops the previous page\'s numbers on an error page', async ({ page, servers, extension }) => {
    await page.goto(`${servers.a}/video?src=flash12hz.webm`);
    await waitForState(page, '#v', 'hidden');
    const tabId = await extension.tabIdOf(page);
    expect(await extension.run((id) => chrome.action.getBadgeText({ tabId: id }), tabId)).toBe('1');
    await page.goto('http://127.0.0.1:9/').catch(() => {});
    await expect.poll(() => extension.run((id) => chrome.action.getBadgeText({ tabId: id }), tabId)).toBe('');
    const popup = await openPopup(extension, tabId);
    await expect(popup.locator('#heroTitle')).toHaveText('Not running on this page');
    await expect(popup.locator('#pageCount')).toHaveText('0');
  });

  test('"Hide everything" isn\'t recorded where it couldn\'t run', async ({ page, servers, extension }) => {
    await page.goto(`${servers.a}/blank`);
    const tabId = await extension.tabIdOf(page);
    await page.goto('chrome://version');
    await extension.run((id) => chrome.runtime.sendMessage({ type: 'hide-page', tabId: id }), tabId);
    await page.waitForTimeout(500);
    const stored = await extension.run((id) => chrome.storage.session.get('tab:' + id), tabId);
    expect(stored['tab:' + tabId]?.hidden ?? false).toBe(false);
  });

  test('"Hide everything" starts NeuroShield in a tab where it wasn\'t running', async ({ page, servers, extension }) => {
    await extension.setSettings({ enabled: false });
    await page.goto(`${servers.a}/video?src=steady.webm`);
    await page.waitForFunction(() => document.getElementById('v').currentTime > 0.2);
    // Simulate a tab opened before install: remove the content script's listener by retiring it.
    const tabId = await extension.tabIdOf(page);
    await extension.run((id) => chrome.scripting.executeScript({ target: { tabId: id }, func: () => globalThis.NeuroShieldContent.retire() }), tabId);
    await extension.run((id) => chrome.runtime.sendMessage({ type: 'hide-page', tabId: id }), tabId);
    await expect.poll(() => layers(page)).toEqual(['page']);
  });
});

test.describe('hidden pages through a handover', () => {
  test('a page hidden with "Hide everything" stays hidden when a new copy takes over', async ({ page, servers, extension }) => {
    await page.goto(`${servers.a}/video?src=steady.webm`);
    await page.waitForFunction(() => document.getElementById('v').currentTime > 0.2);
    const tabId = await extension.tabIdOf(page);
    await extension.run((id) => chrome.runtime.sendMessage({ type: 'hide-page', tabId: id }), tabId);
    await expect.poll(() => layers(page)).toEqual(['page']);
    await extension.run((id) => chrome.runtime.sendMessage({ type: 'protect-tab', tabId: id }), tabId);
    await page.waitForTimeout(300);
    expect(await layers(page)).toEqual(['page']);
    expect(await page.evaluate(() => document.getElementById('v').paused)).toBe(true);
    await expect.poll(() => extension.run(async (id) => (await chrome.storage.session.get('tab:' + id))['tab:' + id]?.hidden, tabId)).toBe(true);
    await extension.run((id) => chrome.runtime.sendMessage({ type: 'show-page', tabId: id }), tabId);
    await expect.poll(() => layers(page)).toEqual([]);
    await expect.poll(() => page.evaluate(() => document.getElementById('v').paused), { message: 'the new copy resumes what the old one paused' }).toBe(false);
  });
});

test.describe('toolbar popup: partial protection', () => {
  test('says a video can\'t be checked instead of "Protected"', async ({ page, servers, extension }) => {
    await page.goto(`${servers.a}/xorigin?src=steady.webm`);
    await page.waitForFunction(() => document.getElementById('v').currentTime > 0.3);
    const popup = await openPopup(extension, await extension.tabIdOf(page));
    await expect(popup.locator('#heroTitle')).toHaveText('Partly protected');
    await expect(popup.locator('#heroDetail')).toHaveText('1 video can\'t be checked');
  });
});
