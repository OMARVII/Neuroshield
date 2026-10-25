const { test, expect, waitForState, layers, pressButton } = require('./fixtures');

const animationState = (page, selector = '#box') => page.evaluate((s) => document.querySelector(s)?.getAnimations()[0]?.playState, selector);

/** Longest gap between animation frames over `ms`, in the page. */
const longestFrameGap = (page, ms) => page.evaluate((duration) => new Promise((resolve) => {
  let last = performance.now();
  let worst = 0;
  const end = last + duration;
  function tick(now) {
    worst = Math.max(worst, now - last);
    last = now;
    if (now < end) requestAnimationFrame(tick);
    else resolve(worst);
  }
  requestAnimationFrame(tick);
}), ms);

test.describe('busy pages', () => {
  // 1.1.0 asked each animating element for its animations on every
  // animationstart, which costs time for every animation on the page: a page
  // with a few thousand spinners froze.
  test('thousands of animations don\'t freeze the page, and a flashing one is still caught', async ({ page, servers, extension }) => {
    // Compared with the same page unprotected: CI machines are slow at rendering it either way.
    await extension.setSettings({ enabled: false });
    await page.goto(`${servers.a}/many-animations?n=2000`);
    const unprotected = await longestFrameGap(page, 900);
    // Maximum: on a slow machine this page renders a few frames a second, too
    // few to show (or see) more than three flashes a second.
    await extension.setSettings({ enabled: true, sensitivity: 'maximum' });
    await page.reload();
    const gap = await longestFrameGap(page, 900);
    expect(gap, `longest frame gap (ms), unprotected ${Math.round(unprotected)} ms`).toBeLessThan(unprotected + 150);
    await expect.poll(() => animationState(page), { timeout: 8000 }).toBe('paused');
  });
});

test.describe('animations that change after a verdict', () => {
  test('a Web Animation the page restarts stays paused while blocked', async ({ page, servers }) => {
    await page.goto(`${servers.a}/waapi`);
    await expect.poll(() => page.evaluate(() => window.anim.playState), { timeout: 6000 }).toBe('paused');
    await page.evaluate(() => window.anim.play());
    await expect.poll(() => page.evaluate(() => window.anim.playState), { timeout: 1000 }).toBe('paused');
    expect(await layers(page)).toEqual(['block']);
  });

  test('a strobe written as one long cycle of quick steps is caught', async ({ page, servers }) => {
    await page.goto(`${servers.a}/long-cycle`);
    await expect.poll(() => animationState(page), { timeout: 6000 }).toBe('paused');
  });

  test('an animation judged safe is checked again when the page speeds it up', async ({ page, servers }) => {
    await page.goto(`${servers.a}/css?kind=flash`);
    await page.evaluate(() => { document.getElementById('box').style.animationDuration = '4s'; });
    // Watched for two 4 s cycles at most, then cleared.
    await page.waitForTimeout(9000);
    expect(await animationState(page)).toBe('running');
    await page.evaluate(() => { document.getElementById('box').style.animationDuration = '200ms'; });
    await expect.poll(() => animationState(page), { timeout: 6000 }).toBe('paused');
  });

  test('a small element\'s full-screen ::after strobe is caught', async ({ page, servers }) => {
    await page.goto(`${servers.a}/pseudo`);
    await expect.poll(() => page.evaluate(() => document.getAnimations()[0]?.playState), { timeout: 6000 }).toBe('paused');
  });
});

test.describe('dimmed canvases', () => {
  test('"Show dimmed" on a transparent canvas puts the page color behind it', async ({ page, servers }) => {
    await page.goto(`${servers.a}/canvas?hz=6&mode=clear`);
    await waitForState(page, '#c', 'transparent', 5000);
    await pressButton(page, 'Show dimmed');
    await waitForState(page, '#c', 'dimmed');
    const style = await page.evaluate(() => {
      const c = document.getElementById('c');
      return { background: getComputedStyle(c).backgroundColor, filter: getComputedStyle(c).filter };
    });
    expect(style.background).toBe('rgb(255, 255, 255)');
    expect(style.filter).toContain('contrast(0.3)');
    await pressButton(page, 'Show original');
    await expect.poll(() => page.evaluate(() => document.getElementById('c').style.backgroundColor)).toBe('');
  });
});

test.describe('discovery', () => {
  test('finds a player whose shadow root is attached a second after it appears', async ({ page, servers }) => {
    await page.goto(`${servers.a}/shadow-late-attach?src=flash12hz.webm`);
    await waitForState(page, null, 'hidden', 6000);
  });
});

test.describe('the card in difficult layouts', () => {
  test('can be clicked over a video in a modal dialog', async ({ page, servers }) => {
    await page.goto(`${servers.a}/dialog?src=flash12hz.webm`);
    await waitForState(page, '#v', 'hidden');
    await pressButton(page, 'Show dimmed');
    await waitForState(page, '#v', 'dimmed');
  });

  test('comes back when the page closes every popover', async ({ page, servers }) => {
    await page.goto(`${servers.a}/video?src=flash12hz.webm`);
    await waitForState(page, '#v', 'hidden');
    await page.evaluate(() => {
      for (const p of document.querySelectorAll('[popover]')) p.hidePopover();
    });
    await expect.poll(() => page.evaluate(() => document.querySelector('[data-neuroshield-overlay]').matches(':popover-open'))).toBe(true);
  });

  test('is clipped by an inner scrolling pane', async ({ page, servers }) => {
    await page.goto(`${servers.a}/scroller?src=flash12hz.webm`);
    await waitForState(page, '#v', 'hidden');
    await page.evaluate(() => { document.getElementById('pane').scrollTop = 600; });
    await expect.poll(() => page.evaluate(() => document.querySelector('[data-neuroshield-overlay]').getBoundingClientRect().height)).toBe(0);
    await page.evaluate(() => { document.getElementById('pane').scrollTop = 200; });
    await expect.poll(() => page.evaluate(() => {
      const card = document.querySelector('[data-neuroshield-overlay]').getBoundingClientRect();
      const pane = document.getElementById('pane').getBoundingClientRect();
      return Math.round(card.top) === Math.round(pane.top) && card.height > 100;
    })).toBe(true);
  });

  test('lines up with the video on a page with CSS zoom', async ({ page, servers }) => {
    await page.goto(`${servers.a}/zoomed?src=flash12hz.webm`);
    await waitForState(page, '#v', 'hidden');
    await expect.poll(() => page.evaluate(() => {
      const card = document.querySelector('[data-neuroshield-overlay]').getBoundingClientRect();
      const video = document.getElementById('v').getBoundingClientRect();
      return [card.left, card.top, card.width, card.height].map((v, i) => Math.abs(v - [video.left, video.top, video.width, video.height][i]) <= 2);
    })).toEqual([true, true, true, true]);
  });
});
