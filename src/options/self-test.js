/**
 * NeuroShield — "Test protection" on the options page.
 *
 * Runs the real frame sampler and detector on a strobe drawn into a canvas
 * that is never put on the page, so nothing flashes on screen. When the
 * strobe is caught, the test screen goes black and shows the same card
 * NeuroShield puts over a flashing video.
 */
(() => {
  'use strict';

  const { FlashAnalyzer, analyzeFrame } = NeuroShieldDetector;
  const Sampler = NeuroShieldSampler;
  const Overlay = NeuroShieldOverlay;
  const Settings = NeuroShieldSettings;

  /** Black ↔ white at 10 flashes a second: over the limit at every sensitivity. */
  const FLASHES_PER_SECOND = 10;
  const HALF_PERIOD_MS = 1000 / FLASHES_PER_SECOND / 2;
  const GIVE_UP_MS = 4000;
  const LEVEL_NAMES = { low: 'Low', medium: 'Medium', high: 'High', maximum: 'Maximum' };
  const ISSUES_URL = 'https://github.com/OMARVII/Neuroshield/issues/new?template=bug.yml';

  const $ = (id) => document.getElementById(id);
  const stage = $('testStage');
  const runButton = $('runTest');
  const result = $('testResult');

  let current = null;
  let card = null;

  function setState(state) {
    stage.dataset.state = state;
    runButton.disabled = state === 'running';
    runButton.textContent = state === 'idle' && !result.textContent ? 'Run test' : 'Run again';
  }

  function say(...parts) {
    result.replaceChildren(...parts);
  }

  function link(text, href) {
    const a = document.createElement('a');
    a.href = href;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    a.textContent = text;
    return a;
  }

  function closeCard() {
    if (card) card.remove();
    card = null;
  }

  /** Stop the strobe and free the sampler. */
  function end(test) {
    if (test.done) return;
    test.done = true;
    cancelAnimationFrame(test.frame);
    test.reader.dispose();
    if (current === test) current = null;
  }

  function caught(test, verdict) {
    const seconds = (performance.now() - test.startedAt) / 1000;
    const path = test.reader.kind === 'webgl' ? 'graphics card' : 'processor';
    end(test);
    setState('caught');
    card = Overlay.block(
      stage,
      {
        kind: 'video',
        flashesPerSecond: verdict.flashesPerSecond,
        isRedFlash: false,
        sensitivity: test.sensitivity,
        paused: test.pauseOnDetect,
      },
      { dimmed: dismiss, anyway: dismiss },
    );
    const strong = document.createElement('strong');
    strong.textContent = `Working. Caught the strobe in ${seconds.toFixed(2)} s.`;
    const parts = [strong, ` Checked on this device with your ${path}, at ${LEVEL_NAMES[test.sensitivity]} sensitivity. This card is what you'll see over flashing content.`];
    if (!test.enabled) parts.push(' Protection is turned off right now, so websites aren\'t being checked.');
    say(...parts);
  }

  function missed(test) {
    end(test);
    setState('missed');
    say('NeuroShield didn\'t catch the test strobe. ', link('Please report this', ISSUES_URL), ' so it can be fixed.');
  }

  function dismiss() {
    closeCard();
    setState('idle');
  }

  async function start() {
    if (current) return;
    closeCard();
    say('');
    const settings = await Settings.load();
    const canvas = document.createElement('canvas');
    canvas.width = 160;
    canvas.height = 90;
    const ctx = canvas.getContext('2d');
    const analyzer = new FlashAnalyzer(settings.sensitivity);
    const test = {
      reader: Sampler.createReader(),
      sensitivity: analyzer.sensitivity,
      pauseOnDetect: settings.pauseOnDetect,
      enabled: settings.enabled,
      startedAt: 0,
      frame: 0,
      done: false,
    };
    current = test;
    setState('running');

    const sink = (pixels, timestamp, linear) => {
      if (test.done) return;
      const sample = analyzeFrame(pixels, linear);
      sample.timestamp = timestamp;
      const verdict = analyzer.push(sample);
      if (verdict.isFlashing) caught(test, verdict);
    };
    const tick = (now) => {
      if (test.done) return;
      if (!test.startedAt) test.startedAt = now;
      const elapsed = now - test.startedAt;
      if (elapsed > GIVE_UP_MS) {
        missed(test);
        return;
      }
      ctx.fillStyle = Math.floor(elapsed / HALF_PERIOD_MS) % 2 ? '#fff' : '#000';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      try {
        test.reader.capture(canvas, now, sink);
      } catch (_) {
        missed(test);
        return;
      }
      if (!test.done) test.frame = requestAnimationFrame(tick);
    };
    test.frame = requestAnimationFrame(tick);
  }

  runButton.addEventListener('click', start);

  // Frames stop in a background tab, which would read as a missed strobe.
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden || !current) return;
    end(current);
    setState('idle');
    say('The test stopped because the tab was in the background. Run it again.');
  });

  setState('idle');
})();
