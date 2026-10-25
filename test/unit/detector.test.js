const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { loadScripts, assertApprox, solidFrame, sampleSignal } = require('./helpers');

const {
  linearize,
  relativeLuminance,
  luminanceOf,
  analyzeFrame,
  analyzeFlashWindow,
  parseColor,
  FlashAnalyzer,
  SENSITIVITY,
  WINDOW_MS,
} = loadScripts(['src/content/detector.js']).NeuroShieldDetector;

const approx = (actual, expected, tolerance, message) => assertApprox(assert, actual, expected, tolerance, message);

/** Square wave between two luminance levels. */
function squareWave(hz, low, high, extra = {}) {
  const half = 1000 / (hz * 2);
  return (t) => ({ luminance: Math.floor(t / half) % 2 === 0 ? low : high, redRatio: 0, ...extra });
}

/** Run every sample through a FlashAnalyzer and report the first flashing result. */
function stream(samples, sensitivity = 'medium') {
  const analyzer = new FlashAnalyzer(sensitivity);
  let last = null;
  for (const s of samples) {
    last = analyzer.push(s);
    if (last.isFlashing) return { ...last, at: s.timestamp };
  }
  return { ...last, at: null };
}

/** Frame samples for a video whose every pixel alternates between two colors. */
function videoFrames(fps, durationMs, colorAt) {
  return sampleSignal(fps, durationMs, (t, i) => analyzeFrame(solidFrame(...colorAt(t, i))));
}

describe('linearize (sRGB → linear)', () => {
  it('returns 0 for black', () => {
    assert.strictEqual(linearize(0), 0);
  });

  it('returns 1 for white', () => {
    approx(linearize(255), 1, 1e-10, 'white');
  });

  it('returns ~0.2158 for mid-gray (128)', () => {
    approx(linearize(128), 0.2158, 0.001, 'mid-gray');
  });

  it('uses the linear segment at and below 0.04045', () => {
    const c = Math.round(0.04045 * 255);
    approx(linearize(c), c / 255 / 12.92, 1e-10, 'below boundary');
    assert.ok(linearize(c + 1) > linearize(c));
  });

  it('uses the 2.4 gamma curve above the boundary', () => {
    const s = 200 / 255;
    approx(linearize(200), Math.pow((s + 0.055) / 1.055, 2.4), 1e-10, 'gamma segment');
  });

  it('is strictly increasing and stays within [0, 1]', () => {
    for (let c = 0; c < 255; c++) {
      assert.ok(linearize(c) < linearize(c + 1), `linearize(${c}) < linearize(${c + 1})`);
      assert.ok(linearize(c) >= 0 && linearize(c) <= 1);
    }
  });
});

describe('relativeLuminance (ITU-R BT.709)', () => {
  it('is 0 for black and 1 for white', () => {
    assert.strictEqual(relativeLuminance(0, 0, 0), 0);
    approx(relativeLuminance(1, 1, 1), 1, 1e-10, 'white');
  });

  it('uses the BT.709 coefficients', () => {
    approx(relativeLuminance(1, 0, 0), 0.2126, 1e-10, 'red');
    approx(relativeLuminance(0, 1, 0), 0.7152, 1e-10, 'green');
    approx(relativeLuminance(0, 0, 1), 0.0722, 1e-10, 'blue');
  });

  it('is linear across channels', () => {
    const sum = relativeLuminance(0.5, 0, 0) + relativeLuminance(0, 0.3, 0) + relativeLuminance(0, 0, 0.8);
    approx(relativeLuminance(0.5, 0.3, 0.8), sum, 1e-10, 'linearity');
  });

  it('luminanceOf applies sRGB linearization to byte colors', () => {
    approx(luminanceOf({ r: 255, g: 255, b: 255 }), 1, 1e-6, 'white');
    approx(luminanceOf({ r: 255, g: 0, b: 0 }), 0.2126, 1e-6, 'red');
  });
});

describe('analyzeFrame', () => {
  it('measures black and white frames', () => {
    approx(analyzeFrame(solidFrame(0, 0, 0)).luminance, 0, 1e-10, 'black');
    approx(analyzeFrame(solidFrame(255, 255, 255)).luminance, 1, 1e-3, 'white');
  });

  it('computes the red ratio R/(R+G+B) on linear values, as WCAG defines R, G and B', () => {
    approx(analyzeFrame(solidFrame(255, 0, 0)).redRatio, 1, 1e-10, 'pure red');
    approx(analyzeFrame(solidFrame(0, 255, 0)).redRatio, 0, 1e-10, 'pure green');
    const [r, g, b] = [200, 100, 50].map(linearize);
    approx(analyzeFrame(solidFrame(200, 100, 50, 255, 1)).redRatio, r / (r + g + b), 1e-6, 'mixed');
    assert.ok(analyzeFrame(solidFrame(160, 25, 25)).redRatio >= 0.8, 'a camera-type red is saturated');
  });

  it('a red area keeps its red ratio when part of the region is black', () => {
    const data = solidFrame(0, 0, 0);
    for (let y = 0; y < 8; y++) for (let x = 0; x < 4; x++) data[(y * 32 + x) * 4] = 200;
    approx(analyzeFrame(data).regions[0].redRatio, 1, 1e-10, 'half red, half black');
  });

  it('treats black as red ratio 0 without dividing by zero', () => {
    assert.strictEqual(analyzeFrame(solidFrame(0, 0, 0)).redRatio, 0);
  });

  it('computes the WCAG red level max(0, R - G - B) in linear light', () => {
    approx(analyzeFrame(solidFrame(255, 0, 0)).redLevel, 1, 1e-6, 'pure red');
    approx(analyzeFrame(solidFrame(255, 255, 255)).redLevel, 0, 1e-10, 'white has none');
    assert.ok(analyzeFrame(solidFrame(3, 0, 0)).redLevel < 0.01, 'near-black red is negligible');
  });

  it('ignores the alpha channel', () => {
    approx(
      analyzeFrame(solidFrame(200, 100, 50, 255, 10)).luminance,
      analyzeFrame(solidFrame(200, 100, 50, 0, 10)).luminance,
      1e-10,
      'alpha independence',
    );
  });

  it('averages a half-black, half-white frame in linear light', () => {
    const data = new Uint8ClampedArray(200 * 4);
    for (let i = 100 * 4; i < data.length; i++) data[i] = 255;
    approx(analyzeFrame(data).luminance, 0.5, 1e-3, 'mixed frame');
  });

  it('matches linearize() for a mid-gray pixel (Float32 lookup table)', () => {
    const l = linearize(128);
    approx(analyzeFrame(solidFrame(128, 128, 128, 255, 1)).luminance, relativeLuminance(l, l, l), 1e-5, 'mid-gray');
  });

  it('accepts linear-light input from the WebGL sampler', () => {
    // 0.25 linear gray = byte 64 when already linear, but byte 137 in sRGB.
    approx(analyzeFrame(solidFrame(64, 64, 64), true).luminance, 64 / 255, 1e-6, 'linear input');
    approx(analyzeFrame(solidFrame(137, 137, 137)).luminance, 0.25, 0.005, 'equivalent sRGB input');
    // The red ratio is still computed on sRGB values.
    approx(analyzeFrame(solidFrame(255, 0, 0), true).redRatio, 1, 1e-10, 'red ratio from linear input');
  });

  it('returns 16 regions in row-major order for a 32×32 frame', () => {
    const data = solidFrame(0, 0, 0);
    for (let y = 0; y < 8; y++) {
      for (let x = 24; x < 32; x++) data.fill(255, (y * 32 + x) * 4, (y * 32 + x) * 4 + 3);
    }
    const { regions } = analyzeFrame(data);
    assert.strictEqual(regions.length, 16);
    approx(regions[3].luminance, 1, 1e-3, 'top-right region is white');
    for (let r = 0; r < 16; r++) {
      if (r !== 3) approx(regions[r].luminance, 0, 1e-10, `region ${r} is black`);
    }
  });

  it('copies whole-frame values into regions for other frame sizes', () => {
    const { regions, luminance } = analyzeFrame(solidFrame(128, 128, 128, 255, 100));
    assert.strictEqual(regions.length, 16);
    for (const r of regions) assert.strictEqual(r.luminance, luminance);
  });
});

describe('SENSITIVITY presets', () => {
  it('defines low, medium, high and maximum as descending flash counts', () => {
    assert.deepStrictEqual(Object.keys(SENSITIVITY), ['low', 'medium', 'high', 'maximum']);
    assert.ok(SENSITIVITY.low > SENSITIVITY.medium && SENSITIVITY.medium > SENSITIVITY.high && SENSITIVITY.high > SENSITIVITY.maximum);
  });

  it('uses the WCAG 2.3.1 limit (3) for medium and 1 for maximum', () => {
    assert.strictEqual(SENSITIVITY.medium, 3);
    assert.strictEqual(SENSITIVITY.maximum, 1);
  });

  it('is frozen', () => {
    assert.ok(Object.isFrozen(SENSITIVITY));
  });
});

describe('analyzeFlashWindow — general flashes', () => {
  it('needs at least three samples', () => {
    const r = analyzeFlashWindow([{ timestamp: 0, luminance: 0, redRatio: 0 }, { timestamp: 50, luminance: 1, redRatio: 0 }], 'medium');
    assert.deepStrictEqual([r.isFlashing, r.flashCount, r.severity], [false, 0, 'safe']);
  });

  it('detects alternating bright and dark frames', () => {
    const r = analyzeFlashWindow(sampleSignal(20, 950, squareWave(10, 0, 0.9)), 'medium');
    assert.ok(r.isFlashing && r.flashCount >= 3, `got ${r.flashCount}`);
  });

  it('ignores constant and slowly changing luminance', () => {
    assert.strictEqual(analyzeFlashWindow(sampleSignal(20, 950, () => ({ luminance: 0.5, redRatio: 0 })), 'maximum').isFlashing, false);
    assert.strictEqual(analyzeFlashWindow(sampleSignal(20, 950, (t) => ({ luminance: t / 1250, redRatio: 0 })), 'maximum').isFlashing, false);
  });

  it('triggers medium at exactly three flash cycles', () => {
    const lum = [0, 0.9, 0, 0.9, 0, 0.9, 0, 0.9];
    const r = analyzeFlashWindow(lum.map((l, i) => ({ timestamp: i * 50, luminance: l, redRatio: 0 })), 'medium');
    assert.ok(r.isFlashing);
    assert.ok(r.flashCount >= 3);
  });

  it('three flashes pass medium (WCAG allows three) and trigger high', () => {
    const h = [0, 0.9, 0, 0.9, 0, 0.9, 0].map((l, i) => ({ timestamp: i * 100, luminance: l, redRatio: 0 }));
    assert.strictEqual(analyzeFlashWindow(h, 'medium').isFlashing, false);
    assert.strictEqual(analyzeFlashWindow(h, 'high').isFlashing, true);
    const more = [0, 0.9, 0, 0.9, 0, 0.9, 0, 0.9].map((l, i) => ({ timestamp: i * 100, luminance: l, redRatio: 0 }));
    assert.strictEqual(analyzeFlashWindow(more, 'medium').isFlashing, true, 'a fourth flash starting fails medium');
  });

  it('one complete cycle triggers maximum; a half cycle does not', () => {
    const full = [0.1, 0.8, 0.1].map((l, i) => ({ timestamp: i * 67, luminance: l, redRatio: 0 }));
    const half = [0.1, 0.1, 0.8].map((l, i) => ({ timestamp: i * 67, luminance: l, redRatio: 0 }));
    assert.strictEqual(analyzeFlashWindow(full, 'maximum').flashCount, 1);
    assert.strictEqual(analyzeFlashWindow(full, 'maximum').isFlashing, true);
    assert.strictEqual(analyzeFlashWindow(half, 'maximum').isFlashing, false);
  });

  it('ignores swings smaller than 0.1', () => {
    const r = analyzeFlashWindow(sampleSignal(20, 950, squareWave(10, 0.4, 0.45)), 'maximum');
    assert.deepStrictEqual([r.isFlashing, r.flashCount], [false, 0]);
  });

  it('ignores swings whose darker state is at or above 0.80', () => {
    assert.strictEqual(analyzeFlashWindow(sampleSignal(20, 950, squareWave(10, 0.85, 0.99)), 'maximum').isFlashing, false);
  });

  it('reports the largest swing as peakDelta', () => {
    const h = [0, 0.3, 0, 0.7].map((l, i) => ({ timestamp: i * 50, luminance: l, redRatio: 0 }));
    approx(analyzeFlashWindow(h, 'medium').peakDelta, 0.7, 1e-10, 'peak');
  });

  it('classifies ten or more flashes per second as danger', () => {
    const r = analyzeFlashWindow(sampleSignal(30, 1000, (t, i) => ({ luminance: i % 2 ? 0.9 : 0, redRatio: 0 })), 'medium');
    assert.ok(r.flashCount >= 10, `got ${r.flashCount}`);
    assert.strictEqual(r.severity, 'danger');
  });

  it('classifies moderate flashing as warning', () => {
    const r = analyzeFlashWindow(sampleSignal(20, 950, squareWave(4, 0, 0.9)), 'medium');
    assert.strictEqual(r.isFlashing, true);
    assert.strictEqual(r.severity, 'warning');
  });
});

describe('analyzeFlashWindow — peak-to-peak transitions', () => {
  it('detects a smooth sine flash that never changes 0.1 between two frames', () => {
    // 6 Hz sine between 0.05 and 0.65 sampled at 120 fps: every frame-to-frame step is under 0.1,
    // so a frame-to-frame counter sees nothing. Each half cycle still swings by 0.6.
    const samples = sampleSignal(120, 1000, (t) => ({ luminance: 0.35 + 0.3 * Math.sin((2 * Math.PI * 6 * t) / 1000), redRatio: 0 }));
    const maxStep = Math.max(...samples.slice(1).map((s, i) => Math.abs(s.luminance - samples[i].luminance)));
    assert.ok(maxStep < 0.1, `per-frame steps should stay under 0.1 (max ${maxStep.toFixed(3)})`);
    const r = analyzeFlashWindow(samples, 'medium');
    assert.strictEqual(r.isFlashing, true);
    assert.ok(r.flashCount >= 5, `got ${r.flashCount}`);
  });

  it('counts a ramp of small steps as one transition', () => {
    const lum = [0, 0.04, 0.08, 0.12, 0.16, 0.12, 0.08, 0.04, 0];
    const r = analyzeFlashWindow(lum.map((l, i) => ({ timestamp: i * 16, luminance: l, redRatio: 0 })), 'maximum');
    assert.strictEqual(r.flashCount, 1, 'up then down by 0.16 is one flash');
  });

  it('does not count jitter around a level', () => {
    const lum = [0.5, 0.54, 0.47, 0.53, 0.46, 0.54, 0.5, 0.46, 0.52];
    assert.strictEqual(analyzeFlashWindow(lum.map((l, i) => ({ timestamp: i * 16, luminance: l, redRatio: 0 })), 'maximum').flashCount, 0);
  });

  it('applies the darker-state rule to the swing, not to individual frames', () => {
    // Bright frames at 1.0 with dips to 0.75: each dip is a 0.25 swing whose darker state is 0.75.
    const lum = [1, 0.85, 0.75, 1, 0.85, 0.75, 1, 0.85, 0.75, 1, 0.85, 0.75];
    const r = analyzeFlashWindow(lum.map((l, i) => ({ timestamp: i * 30, luminance: l, redRatio: 0 })), 'medium');
    assert.strictEqual(r.isFlashing, true);
  });
});

describe('analyzeFlashWindow — red flashes (WCAG 2.3.1 red flash threshold)', () => {
  it('flags red when transitions involve a saturated red', () => {
    const r = analyzeFlashWindow(sampleSignal(20, 950, squareWave(10, 0, 0.5, { redRatio: 0.9 })), 'medium');
    assert.strictEqual(r.isRedFlash, true);
    assert.strictEqual(r.severity, 'danger');
  });

  it('does not flag red when the frames are not red', () => {
    assert.strictEqual(analyzeFlashWindow(sampleSignal(20, 950, squareWave(10, 0, 0.5, { redRatio: 0.3 })), 'medium').isRedFlash, false);
  });

  it('detects red ↔ black strobing as a red flash', () => {
    const frames = videoFrames(24, 1000, (t, i) => (i % 2 ? [255, 0, 0] : [0, 0, 0]));
    const r = analyzeFlashWindow(frames, 'medium');
    assert.strictEqual(r.isFlashing, true);
    assert.strictEqual(r.isRedFlash, true);
  });

  it('detects red ↔ blue strobing as a red flash', () => {
    const frames = videoFrames(24, 1000, (t, i) => (i % 2 ? [255, 0, 0] : [0, 0, 255]));
    const r = analyzeFlashWindow(frames, 'medium');
    assert.strictEqual(r.isFlashing, true);
    assert.strictEqual(r.isRedFlash, true);
  });

  it('detects equal-luminance red ↔ green strobing through the red level', () => {
    // Luminance of (255,0,0) ≈ 0.213 and of (0,140,0) ≈ 0.188: a 0.025 swing, far under 0.1.
    const frames = videoFrames(24, 1000, (t, i) => (i % 2 ? [255, 0, 0] : [0, 140, 0]));
    assert.ok(Math.abs(frames[0].luminance - frames[1].luminance) < 0.05);
    const r = analyzeFlashWindow(frames, 'medium');
    assert.strictEqual(r.isFlashing, true, 'red flash threshold applies');
    assert.strictEqual(r.isRedFlash, true);
  });

  it('does not call near-black reddish frames a red flash', () => {
    const frames = videoFrames(24, 1000, (t, i) => (i % 2 ? [255, 255, 255] : [3, 0, 0]));
    const r = analyzeFlashWindow(frames, 'medium');
    assert.strictEqual(r.isFlashing, true);
    assert.strictEqual(r.isRedFlash, false);
  });
});

describe('sampling-rate independence (the 12 Hz aliasing bug)', () => {
  // v1.0 sampled every ~83 ms (12 fps on a 60 Hz display). A 12 Hz flash
  // sampled at 12 fps hits the same phase every time and looks constant.
  it('a 12 Hz strobe sampled at 12 fps looks constant (why v1.0 missed it)', () => {
    const at12fps = sampleSignal(12, 1000, (t) => ({ luminance: Math.round((t * 24) / 1000) % 2 ? 0.9 : 0.05, redRatio: 0 }));
    assert.strictEqual(analyzeFlashWindow(at12fps, 'maximum').isFlashing, false);
  });

  it('a 12 Hz strobe in a 24 fps video is detected when every frame is analyzed', () => {
    const frames = videoFrames(24, 1000, (t, i) => (i % 2 ? [235, 235, 235] : [16, 16, 16]));
    const r = stream(frames, 'medium');
    assert.strictEqual(r.isFlashing, true);
    assert.ok(r.at <= 300, `should trigger within ~6 transitions, got ${r.at} ms`);
  });

  it('a 30 Hz strobe in a 60 fps video is detected and its rate estimated', () => {
    const r = stream(videoFrames(60, 1000, (t, i) => (i % 2 ? [255, 255, 255] : [0, 0, 0])), 'medium');
    assert.strictEqual(r.isFlashing, true);
    assert.ok(r.at <= 120, `detected at ${r.at} ms`);
    assert.ok(Math.abs(r.flashesPerSecond - 30) <= 1, `estimated ${r.flashesPerSecond}/s`);
    assert.strictEqual(r.severity, 'danger');
  });

  it('estimates the rate of a 4 Hz flash', () => {
    const r = analyzeFlashWindow(sampleSignal(30, WINDOW_MS, squareWave(4, 0.05, 0.85)), 'medium');
    assert.strictEqual(r.flashesPerSecond, 4);
  });
});

describe('realistic frame rates', () => {
  for (const fps of [15, 24, 30, 60]) {
    // Exactly 3 Hz is the boundary: one frame of timing error can fit a seventh transition in.
    it(`4 Hz triggers medium and 2.8 Hz does not, at ${fps} fps`, () => {
      assert.strictEqual(stream(sampleSignal(fps, 3000, squareWave(4, 0.05, 0.85)), 'medium').isFlashing, true);
      assert.strictEqual(stream(sampleSignal(fps, 3000, squareWave(2.8, 0.05, 0.85)), 'medium').isFlashing, false);
    });
  }

  it('1 Hz triggers maximum with exactly one flash', () => {
    const r = analyzeFlashWindow(sampleSignal(15, WINDOW_MS + 50, squareWave(1, 0.05, 0.85)), 'maximum');
    assert.strictEqual(r.isFlashing, true);
    assert.strictEqual(r.flashCount, 1);
  });

  it('6 Hz triggers low but 5 Hz does not', () => {
    assert.strictEqual(stream(sampleSignal(30, 3000, squareWave(6, 0.05, 0.85)), 'low').isFlashing, true);
    assert.strictEqual(stream(sampleSignal(30, 3000, squareWave(5, 0.05, 0.85)), 'low').isFlashing, false);
  });

  it('beat-synced light pulses at 128 BPM pass medium', () => {
    const period = 60000 / 128;
    const pulses = sampleSignal(60, 4000, (t) => ({ luminance: t % period < 100 ? 0.9 : 0.05, redRatio: 0 }));
    assert.strictEqual(stream(pulses, 'medium').isFlashing, false);
    assert.strictEqual(stream(pulses, 'high').isFlashing, true, '2.13 flashes a second is more than High allows');
  });
});

describe('spatial (region) analysis', () => {
  function regions(fn) {
    return Array.from({ length: 16 }, (_, r) => fn(r));
  }

  it('detects a flash confined to one region that the frame average hides', () => {
    const history = sampleSignal(20, 950, (t, i) => {
      const r0 = i % 2 ? 0.9 : 0;
      return { luminance: (r0 + 15 * 0.3) / 16, redRatio: 0, regions: regions((r) => ({ luminance: r === 0 ? r0 : 0.3, redRatio: 0 })) };
    });
    const r = analyzeFlashWindow(history, 'medium');
    assert.strictEqual(r.isFlashing, true);
    assert.strictEqual(r.region, 0);
  });

  it('reports the whole frame (region -1) for uniform flashing', () => {
    const history = sampleSignal(20, 950, (t, i) => {
      const l = i % 2 ? 0.9 : 0;
      return { luminance: l, redRatio: 0, regions: regions(() => ({ luminance: l, redRatio: 0 })) };
    });
    assert.strictEqual(analyzeFlashWindow(history, 'medium').region, -1);
  });

  it('does not trigger on a static bright region', () => {
    const history = sampleSignal(20, 950, () => ({ luminance: 0.15, redRatio: 0, regions: regions((r) => ({ luminance: r === 0 ? 0.9 : 0.1, redRatio: 0 })) }));
    assert.strictEqual(analyzeFlashWindow(history, 'medium').isFlashing, false);
  });

  it('finds a localized flash end to end from pixels', () => {
    const frames = sampleSignal(30, 1000, (t, i) => {
      const data = solidFrame(40, 40, 40);
      if (i % 2) {
        for (let y = 24; y < 32; y++) for (let x = 0; x < 8; x++) data.fill(255, (y * 32 + x) * 4, (y * 32 + x) * 4 + 3);
      }
      return analyzeFrame(data);
    });
    const r = analyzeFlashWindow(frames, 'medium');
    assert.strictEqual(r.isFlashing, true);
    assert.strictEqual(r.region, 25 + 6, 'the bottom-left quarter-frame block');
  });

  it('finds a fainter flash in one fine region', () => {
    // A 0.25 swing within one region is only a 0.06 swing for its quarter of the frame.
    const frames = sampleSignal(30, 1000, (t, i) => {
      const data = solidFrame(40, 40, 40);
      const level = i % 2 ? 140 : 40;
      for (let y = 24; y < 32; y++) for (let x = 0; x < 8; x++) data.fill(level, (y * 32 + x) * 4, (y * 32 + x) * 4 + 3);
      return analyzeFrame(data);
    });
    const r = analyzeFlashWindow(frames, 'medium');
    assert.strictEqual(r.isFlashing, true);
    assert.strictEqual(r.region, 12, 'bottom-left fine region');
  });

  it('finds a flash centred where four regions meet', () => {
    // 8×8 samples centred on the frame: each aligned region sees a quarter of it.
    const frames = sampleSignal(30, 1000, (t, i) => {
      const data = solidFrame(40, 40, 40);
      const level = i % 2 ? 110 : 40;
      for (let y = 12; y < 20; y++) for (let x = 12; x < 20; x++) data.fill(level, (y * 32 + x) * 4, (y * 32 + x) * 4 + 3);
      return analyzeFrame(data);
    });
    const r = analyzeFlashWindow(frames, 'medium');
    assert.strictEqual(r.isFlashing, true);
    assert.strictEqual(r.region, 16 + 4, 'the centre shifted region');
  });

  it('ignores content too small on screen to flash over the WCAG area', () => {
    const flashing = videoFrames(30, 1000, (t, i) => (i % 2 ? [255, 255, 255] : [0, 0, 0]));
    assert.strictEqual(analyzeFlashWindow(flashing, 'maximum', 140 * 140).isFlashing, false, 'a 140 × 140 thumbnail');
    assert.strictEqual(analyzeFlashWindow(flashing, 'maximum', 320 * 180).isFlashing, true, 'a 320 × 180 player');
  });

  it('skips regions too small on screen to hold a flash of the WCAG area', () => {
    const frames = sampleSignal(30, 1000, (t, i) => {
      const data = solidFrame(40, 40, 40);
      const level = i % 2 ? 140 : 40;
      for (let y = 24; y < 32; y++) for (let x = 0; x < 8; x++) data.fill(level, (y * 32 + x) * 4, (y * 32 + x) * 4 + 3);
      return analyzeFrame(data);
    });
    assert.strictEqual(analyzeFlashWindow(frames, 'medium', 640 * 360).isFlashing, false, 'one region of a 640 × 360 player is 160 × 90 px');
    assert.strictEqual(analyzeFlashWindow(frames, 'medium', 1920 * 1080).isFlashing, true, 'one region of a fullscreen video is 480 × 270 px');
  });
});

describe('FlashAnalyzer', () => {
  it('defaults to medium and ignores unknown levels', () => {
    const a = new FlashAnalyzer();
    assert.strictEqual(a.sensitivity, 'medium');
    a.setSensitivity('turbo');
    assert.strictEqual(a.sensitivity, 'medium');
    a.setSensitivity('high');
    assert.strictEqual(a.sensitivity, 'high');
    assert.strictEqual(new FlashAnalyzer('bogus').sensitivity, 'medium');
  });

  it('keeps only the last window of samples', () => {
    const a = new FlashAnalyzer('medium');
    for (let t = 0; t <= 3000; t += 33) a.push({ timestamp: t, luminance: 0.5, redRatio: 0 });
    const span = a.history[a.history.length - 1].timestamp - a.history[0].timestamp;
    assert.ok(span <= WINDOW_MS, `span ${span}`);
  });

  it('stops flashing once the flashes leave the window', () => {
    const a = new FlashAnalyzer('medium');
    let flashing = false;
    for (let i = 0; i < 30; i++) flashing = a.push({ timestamp: i * 33, luminance: i % 2 ? 0.9 : 0, redRatio: 0 }).isFlashing;
    assert.strictEqual(flashing, true);
    for (let i = 30; i < 80; i++) flashing = a.push({ timestamp: i * 33, luminance: 0.5, redRatio: 0 }).isFlashing;
    assert.strictEqual(flashing, false);
  });

  it('resets when time goes backwards', () => {
    const a = new FlashAnalyzer('medium');
    for (let i = 0; i < 10; i++) a.push({ timestamp: 1000 + i * 33, luminance: 0.5, redRatio: 0 });
    a.push({ timestamp: 10, luminance: 0.5, redRatio: 0 });
    assert.strictEqual(a.history.length, 1);
  });

  it('reset() clears the window', () => {
    const a = new FlashAnalyzer('medium');
    a.push({ timestamp: 0, luminance: 0.5, redRatio: 0 });
    a.reset();
    assert.strictEqual(a.history.length, 0);
  });

  it('applies a sensitivity change on the next sample', () => {
    const a = new FlashAnalyzer('medium');
    const samples = [0, 0.9, 0, 0.9, 0, 0.9].map((l, i) => ({ timestamp: i * 100, luminance: l, redRatio: 0 }));
    let r;
    for (const s of samples) r = a.push(s);
    assert.strictEqual(r.isFlashing, false);
    a.setSensitivity('high');
    assert.strictEqual(a.push({ timestamp: 600, luminance: 0, redRatio: 0 }).isFlashing, true);
  });
});

describe('end-to-end pixel pipeline', () => {
  it('black/white frames trigger with a large peak delta', () => {
    const r = analyzeFlashWindow(videoFrames(15, 1000, (t, i) => (i % 2 ? [255, 255, 255] : [0, 0, 0])), 'medium');
    assert.strictEqual(r.isFlashing, true);
    assert.ok(r.peakDelta > 0.9);
  });

  it('steady mid-gray frames never trigger', () => {
    assert.strictEqual(analyzeFlashWindow(videoFrames(30, 1000, () => [128, 128, 128]), 'maximum').isFlashing, false);
  });

  it('bright-red/dark-red frames are a red flash', () => {
    const r = analyzeFlashWindow(videoFrames(15, 1000, (t, i) => (i % 2 ? [255, 1, 1] : [40, 1, 1])), 'medium');
    assert.strictEqual(r.isFlashing, true);
    assert.strictEqual(r.isRedFlash, true);
  });
});

describe('parseColor', () => {
  it('parses rgb() and rgba() in comma and space syntax', () => {
    assert.deepStrictEqual({ ...parseColor('rgb(100, 200, 50)') }, { r: 100, g: 200, b: 50, a: 1 });
    assert.deepStrictEqual({ ...parseColor('rgba(255, 128, 0, 0.5)') }, { r: 255, g: 128, b: 0, a: 0.5 });
    assert.deepStrictEqual({ ...parseColor('rgb(255 128 0 / 25%)') }, { r: 255, g: 128, b: 0, a: 0.25 });
  });

  it('parses color(srgb …)', () => {
    assert.deepStrictEqual({ ...parseColor('color(srgb 1 0 0.5 / 0.4)') }, { r: 255, g: 0, b: 128, a: 0.4 });
  });

  it('returns null for transparent, invalid and non-string input', () => {
    assert.strictEqual(parseColor('transparent'), null);
    assert.strictEqual(parseColor('not-a-color'), null);
    assert.strictEqual(parseColor('oklch(0.7 0.1 200)'), null);
    assert.strictEqual(parseColor(null), null);
    assert.strictEqual(parseColor(undefined), null);
  });

  it('clamps out-of-range channels', () => {
    assert.strictEqual(parseColor('rgb(300, 0, 12.6)').r, 255);
    assert.strictEqual(parseColor('rgb(300, 0, 12.6)').b, 13);
  });
});
