const { test, waitForState } = require('./fixtures');

// Web-component players (Reddit, Mux, media-chrome…) keep their <video> in a
// shadow root, where v1.0 never looked.
test.describe('videos inside shadow DOM', () => {
  test('open shadow root', async ({ page, servers }) => {
    await page.goto(`${servers.a}/shadow-open?src=flash12hz.webm`);
    await waitForState(page, null, 'hidden');
  });

  test('closed shadow root', async ({ page, servers }) => {
    await page.goto(`${servers.a}/shadow-closed?src=flash12hz.webm`);
    await waitForState(page, null, 'hidden');
  });

  test('declarative shadow root (server-rendered)', async ({ page, servers }) => {
    await page.goto(`${servers.a}/shadow-declarative?src=flash12hz.webm`);
    await page.waitForFunction(() => {
      const v = document.getElementById('host').shadowRoot.getElementById('v');
      return v.getAttribute('data-neuroshield') === 'hidden';
    }, null, { timeout: 4000 });
  });

  test('custom element defined after the page loaded', async ({ page, servers }) => {
    await page.goto(`${servers.a}/shadow-late?src=flash12hz.webm`);
    await page.waitForFunction(() => window.__video, null, { timeout: 4000 });
    await waitForState(page, null, 'hidden', 5000);
  });
});
