const { test, expect, stateOf, waitForState, layers, pressButton, overlayText } = require('./fixtures');

const isPaused = (page) => page.evaluate(() => document.getElementById('v').paused);

test.describe('hidden content controls', () => {
  test('card explains what happened', async ({ page, servers }) => {
    await page.goto(`${servers.a}/video?src=flash12hz.webm`);
    await waitForState(page, '#v', 'hidden');
    const text = await overlayText(page);
    expect(text).toContain('Flashing content hidden');
    expect(text).toMatch(/flashes about \d+ times per second/);
    expect(text).toContain('Medium sensitivity');
  });

  test('"Show dimmed" dims the video and resumes it', async ({ page, servers }) => {
    await page.goto(`${servers.a}/video?src=flash12hz.webm`);
    await waitForState(page, '#v', 'hidden');
    expect(await isPaused(page)).toBe(true);
    await pressButton(page, 'Show dimmed');
    await waitForState(page, '#v', 'dimmed');
    expect(await layers(page)).toEqual(['dimmed']);
    await expect.poll(() => isPaused(page)).toBe(false);
    const filter = await page.evaluate(() => getComputedStyle(document.getElementById('v')).filter);
    expect(filter).toContain('contrast(0.3)');
  });

  test('"Show original" on the dimmed chip removes the dimming', async ({ page, servers }) => {
    await page.goto(`${servers.a}/video?src=flash12hz.webm`);
    await waitForState(page, '#v', 'hidden');
    await pressButton(page, 'Show dimmed');
    await waitForState(page, '#v', 'dimmed');
    await pressButton(page, 'Show original');
    await expect.poll(() => stateOf(page, '#v')).toBeNull();
    expect(await layers(page)).toEqual([]);
  });

  test('"Show anyway" reveals the video, and a new source is checked again', async ({ page, servers }) => {
    await page.goto(`${servers.a}/video?src=flash12hz.webm`);
    await waitForState(page, '#v', 'hidden');
    await pressButton(page, 'Show anyway');
    await expect.poll(() => stateOf(page, '#v')).toBeNull();
    await expect.poll(() => isPaused(page)).toBe(false);
    expect(await layers(page)).toEqual([]);

    await page.evaluate(() => {
      const v = document.getElementById('v');
      v.src = 'flash15hz.webm';
      v.play();
    });
    await waitForState(page, '#v', 'hidden');
  });

  test('"Show anyway" watches again after 10 seconds', async ({ page, servers }) => {
    test.slow();
    await page.goto(`${servers.a}/video?src=flash12hz.webm`);
    await waitForState(page, '#v', 'hidden');
    await pressButton(page, 'Show anyway');
    await expect.poll(() => stateOf(page, '#v')).toBeNull();
    await page.waitForTimeout(8000);
    expect(await stateOf(page, '#v'), 'still revealed during the grace period').toBeNull();
    await waitForState(page, '#v', 'hidden', 5000);
  });

  test('the page cannot press the buttons for the user', async ({ page, servers }) => {
    await page.goto(`${servers.a}/video?src=flash12hz.webm`);
    await waitForState(page, '#v', 'hidden');
    await page.evaluate(() => {
      const host = document.querySelector('[data-neuroshield-overlay]');
      host.click();
      host.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      host.remove();
    });
    await page.waitForTimeout(400);
    expect(await stateOf(page, '#v')).toBe('hidden');
    expect(await layers(page), 'the card comes back if the page removes it').toEqual(['block']);
  });

  test('keeps the video hidden when the page rewrites its style', async ({ page, servers }) => {
    await page.goto(`${servers.a}/video?src=flash12hz.webm`);
    await waitForState(page, '#v', 'hidden');
    await page.evaluate(() => document.getElementById('v').setAttribute('style', 'filter: none; width: 640px'));
    await expect.poll(() => page.evaluate(() => getComputedStyle(document.getElementById('v')).filter)).toBe('brightness(0)');
  });

  test('shows above a fullscreen player and works there', async ({ page, servers }) => {
    await page.goto(`${servers.a}/fullscreen?src=steady.webm`);
    await page.click('#fs');
    await page.waitForFunction(() => !!document.fullscreenElement);
    await page.evaluate(() => {
      const v = document.getElementById('v');
      v.src = 'flash12hz.webm';
      v.play();
    });
    await waitForState(page, '#v', 'hidden');
    await pressButton(page, 'Show dimmed');
    await waitForState(page, '#v', 'dimmed');
    expect(await page.evaluate(() => !!document.fullscreenElement), 'still fullscreen').toBe(true);
  });

  test('leaves native video fullscreen so the card can be used', async ({ page, servers }) => {
    await page.goto(`${servers.a}/fullscreen?src=steady.webm&target=video`);
    await page.click('#fs');
    await page.waitForFunction(() => document.fullscreenElement?.id === 'v');
    await page.evaluate(() => {
      const v = document.getElementById('v');
      v.src = 'flash12hz.webm';
      v.play();
    });
    await waitForState(page, '#v', 'hidden');
    await expect.poll(() => page.evaluate(() => !!document.fullscreenElement)).toBe(false);
    await pressButton(page, 'Show dimmed');
    await waitForState(page, '#v', 'dimmed');
  });

  test('renders on pages with a strict Content-Security-Policy', async ({ page, servers, extension }) => {
    await page.goto(`${servers.a}/csp?src=flash12hz.webm`);
    await waitForState(page, '#v', 'hidden');
    await page.waitForTimeout(300);
    // The teal "Show dimmed" button only exists if the shadow-root stylesheet applied.
    const shot = await page.screenshot({ clip: await page.locator('#v').boundingBox() });
    expect(await extension.countColor(shot, [94, 234, 212])).toBeGreaterThan(300);
  });
});
