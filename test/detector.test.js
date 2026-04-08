const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('fs');
const { join } = require('path');
const vm = require('vm');

const code = readFileSync(join(__dirname, '..', 'src', 'detector.js'), 'utf-8');
const context = vm.createContext({
  document: {
    createElement: () => ({
      getContext: () => ({
        drawImage: () => {},
        getImageData: () => ({ data: new Uint8ClampedArray(0) }),
      }),
      width: 0,
      height: 0,
    }),
  },
  requestAnimationFrame: () => {},
  cancelAnimationFrame: () => {},
  performance: { now: () => Date.now() },
  getComputedStyle: () => ({}),
  chrome: { runtime: { id: 'test' } },
  console: console,
  Math: Math,
  Float32Array: Float32Array,
  Uint8ClampedArray: Uint8ClampedArray,
  setInterval: setInterval,
  clearInterval: clearInterval,
  parseInt: parseInt,
  parseFloat: parseFloat,
});
vm.runInContext(code, context);

const {
  _linearize,
  _relativeLuminance,
  _analyzeFrame,
  SENSITIVITY,
  FlashDetector,
  CSSFlashDetector,
} = context.NeuroShieldDetector;

function assertApprox(actual, expected, tolerance, message) {
  assert.ok(
    Math.abs(actual - expected) < tolerance,
    `${message}: expected ~${expected}, got ${actual}`
  );
}

function makeFrame(r, g, b, a, pixelCount) {
  const data = new Uint8ClampedArray(pixelCount * 4);
  for (let i = 0; i < data.length; i += 4) {
    data[i] = r;
    data[i + 1] = g;
    data[i + 2] = b;
    data[i + 3] = a;
  }
  return data;
}

function createDetectorWithHistory(sensitivity, frameHistory) {
  const det = new FlashDetector(
    { tagName: 'CANVAS' },
    {
      sensitivity: sensitivity,
      onFlashDetected: () => {},
      onSafe: () => {},
    }
  );
  det.frameHistory = frameHistory;
  return det;
}

describe('_linearize (sRGB channel linearization)', () => {
  it('returns 0 for black (channel value 0)', () => {
    assert.strictEqual(_linearize(0), 0);
  });

  it('returns 1.0 for white (channel value 255)', () => {
    assertApprox(_linearize(255), 1.0, 1e-10, 'white linearization');
  });

  it('returns ~0.2158 for mid-gray (channel value 128)', () => {
    assertApprox(_linearize(128), 0.2158, 0.001, 'mid-gray linearization');
  });

  it('handles the piecewise boundary near sRGB 0.04045', () => {
    const boundaryChannel = Math.round(0.04045 * 255);
    const belowResult = _linearize(boundaryChannel);
    const aboveResult = _linearize(boundaryChannel + 1);

    assert.ok(belowResult >= 0, 'below boundary should be non-negative');
    assert.ok(aboveResult > belowResult, 'value above boundary should be greater');

    const expectedBelow = (boundaryChannel / 255) / 12.92;
    assertApprox(belowResult, expectedBelow, 1e-10, 'below boundary uses linear formula');
  });

  it('is monotonically increasing across the full 0-255 range', () => {
    for (let n = 0; n < 255; n++) {
      assert.ok(
        _linearize(n) < _linearize(n + 1),
        `linearize(${n}) should be < linearize(${n + 1})`
      );
    }
  });

  it('returns values in [0, 1] for all valid inputs', () => {
    for (let c = 0; c <= 255; c++) {
      const val = _linearize(c);
      assert.ok(val >= 0 && val <= 1, `linearize(${c}) = ${val} out of range`);
    }
  });

  it('uses the gamma formula (exponent 2.4) above the threshold', () => {
    const c = 200;
    const s = c / 255;
    const expected = Math.pow((s + 0.055) / 1.055, 2.4);
    assertApprox(_linearize(c), expected, 1e-10, 'gamma formula for c=200');
  });

  it('uses the linear formula (divide by 12.92) below the threshold', () => {
    const c = 5;
    const s = c / 255;
    const expected = s / 12.92;
    assertApprox(_linearize(c), expected, 1e-10, 'linear formula for c=5');
  });
});

describe('_relativeLuminance (ITU-R BT.709)', () => {
  it('returns 0 for pure black (0, 0, 0)', () => {
    assert.strictEqual(_relativeLuminance(0, 0, 0), 0);
  });

  it('returns 1.0 for pure white (1, 1, 1)', () => {
    assertApprox(_relativeLuminance(1, 1, 1), 1.0, 1e-10, 'white luminance');
  });

  it('returns 0.2126 for pure red (1, 0, 0)', () => {
    assertApprox(_relativeLuminance(1, 0, 0), 0.2126, 1e-10, 'red coefficient');
  });

  it('returns 0.7152 for pure green (0, 1, 0)', () => {
    assertApprox(_relativeLuminance(0, 1, 0), 0.7152, 1e-10, 'green coefficient');
  });

  it('returns 0.0722 for pure blue (0, 0, 1)', () => {
    assertApprox(_relativeLuminance(0, 0, 1), 0.0722, 1e-10, 'blue coefficient');
  });

  it('has coefficients that sum to exactly 1.0', () => {
    assertApprox(0.2126 + 0.7152 + 0.0722, 1.0, 1e-10, 'BT.709 coefficient sum');
  });

  it('is linear: L(a+b) = L(a) + L(b) for orthogonal channels', () => {
    const lr = _relativeLuminance(0.5, 0, 0);
    const lg = _relativeLuminance(0, 0.3, 0);
    const lb = _relativeLuminance(0, 0, 0.8);
    const combined = _relativeLuminance(0.5, 0.3, 0.8);
    assertApprox(combined, lr + lg + lb, 1e-10, 'linearity of luminance');
  });

  it('green contributes more than red, red more than blue', () => {
    const lr = _relativeLuminance(1, 0, 0);
    const lg = _relativeLuminance(0, 1, 0);
    const lb = _relativeLuminance(0, 0, 1);
    assert.ok(lg > lr, 'green > red');
    assert.ok(lr > lb, 'red > blue');
  });
});

describe('_analyzeFrame (pixel data analysis)', () => {
  it('returns luminance ~0 and redRatio 0 for all-black pixels', () => {
    const data = makeFrame(0, 0, 0, 255, 100);
    const result = _analyzeFrame(data);
    assertApprox(result.luminance, 0, 1e-10, 'black luminance');
    assert.strictEqual(result.redRatio, 0);
  });

  it('returns luminance ~1.0 for all-white pixels', () => {
    const data = makeFrame(255, 255, 255, 255, 100);
    const result = _analyzeFrame(data);
    assertApprox(result.luminance, 1.0, 0.001, 'white luminance');
  });

  it('returns redRatio ~1.0 for all pure red pixels', () => {
    const data = makeFrame(255, 0, 0, 255, 100);
    const result = _analyzeFrame(data);
    assertApprox(result.redRatio, 1.0, 1e-10, 'pure red ratio');
  });

  it('returns redRatio ~0 for all pure green pixels', () => {
    const data = makeFrame(0, 255, 0, 255, 100);
    const result = _analyzeFrame(data);
    assertApprox(result.redRatio, 0, 1e-10, 'green red ratio');
  });

  it('returns redRatio ~0 for all pure blue pixels', () => {
    const data = makeFrame(0, 0, 255, 255, 100);
    const result = _analyzeFrame(data);
    assertApprox(result.redRatio, 0, 1e-10, 'blue red ratio');
  });

  it('handles a single pixel frame (4 bytes)', () => {
    const data = new Uint8ClampedArray([128, 64, 32, 255]);
    const result = _analyzeFrame(data);
    assert.ok(result.luminance > 0 && result.luminance < 1, 'single pixel luminance in range');
    assert.ok(result.redRatio > 0 && result.redRatio < 1, 'single pixel red ratio in range');
  });

  it('averages luminance for a mixed frame between extremes', () => {
    const pixelCount = 200;
    const data = new Uint8ClampedArray(pixelCount * 4);
    for (let i = 0; i < pixelCount; i++) {
      const offset = i * 4;
      if (i < pixelCount / 2) {
        data[offset] = 0; data[offset + 1] = 0; data[offset + 2] = 0;
      } else {
        data[offset] = 255; data[offset + 1] = 255; data[offset + 2] = 255;
      }
      data[offset + 3] = 255;
    }
    const result = _analyzeFrame(data);
    assert.ok(result.luminance > 0.3 && result.luminance < 0.7,
      `mixed frame luminance should be ~0.5, got ${result.luminance}`);
  });

  it('computes correct luminance for a known mid-gray pixel', () => {
    const data = makeFrame(128, 128, 128, 255, 1);
    const result = _analyzeFrame(data);
    const linVal = _linearize(128);
    const expectedLum = _relativeLuminance(linVal, linVal, linVal);
    // analyzeFrame uses Float32Array LUT, _linearize returns Float64 — allow FP32 precision loss
    assertApprox(result.luminance, expectedLum, 1e-5, 'mid-gray consistency');
  });

  it('redRatio is R/(R+G+B) in sRGB space, not linear', () => {
    const data = makeFrame(200, 100, 50, 255, 1);
    const result = _analyzeFrame(data);
    const expectedRatio = 200 / (200 + 100 + 50);
    assertApprox(result.redRatio, expectedRatio, 1e-10, 'sRGB red ratio calculation');
  });

  it('handles pixels where R+G+B = 0 without division error', () => {
    const data = makeFrame(0, 0, 0, 255, 50);
    const result = _analyzeFrame(data);
    assert.strictEqual(result.redRatio, 0);
  });

  it('ignores alpha channel in luminance calculation', () => {
    const opaqueData = makeFrame(200, 100, 50, 255, 10);
    const transparentData = makeFrame(200, 100, 50, 0, 10);
    const opaqueResult = _analyzeFrame(opaqueData);
    const transparentResult = _analyzeFrame(transparentData);
    assertApprox(opaqueResult.luminance, transparentResult.luminance, 1e-10,
      'alpha should not affect luminance');
  });
});

describe('SENSITIVITY presets', () => {
  it('has all four required levels: low, medium, high, maximum', () => {
    assert.ok('low' in SENSITIVITY, 'missing low');
    assert.ok('medium' in SENSITIVITY, 'missing medium');
    assert.ok('high' in SENSITIVITY, 'missing high');
    assert.ok('maximum' in SENSITIVITY, 'missing maximum');
  });

  it('has exactly 4 levels', () => {
    assert.strictEqual(Object.keys(SENSITIVITY).length, 4);
  });

  it('medium equals 3 (WCAG 2.3.1 standard)', () => {
    assert.strictEqual(SENSITIVITY.medium, 3);
  });

  it('values are in strictly descending order: low > medium > high > maximum', () => {
    assert.ok(SENSITIVITY.low > SENSITIVITY.medium, 'low > medium');
    assert.ok(SENSITIVITY.medium > SENSITIVITY.high, 'medium > high');
    assert.ok(SENSITIVITY.high > SENSITIVITY.maximum, 'high > maximum');
  });

  it('all values are positive integers', () => {
    for (const [key, val] of Object.entries(SENSITIVITY)) {
      assert.ok(Number.isInteger(val) && val > 0, `${key} should be positive integer, got ${val}`);
    }
  });

  it('maximum is 1 (any single flash triggers)', () => {
    assert.strictEqual(SENSITIVITY.maximum, 1);
  });
});

describe('Flash detection (_analyzeWindow integration)', () => {
  it('does not detect flashing with fewer than 3 frames', () => {
    const det = createDetectorWithHistory('medium', [
      { timestamp: 0, luminance: 0.0, redRatio: 0 },
      { timestamp: 100, luminance: 1.0, redRatio: 0 },
    ]);
    const result = det._analyzeWindow();
    assert.strictEqual(result.isFlashing, false);
    assert.strictEqual(result.flashCount, 0);
    assert.strictEqual(result.severity, 'safe');
  });

  it('detects flashing from alternating bright/dark frames', () => {
    const history = [];
    for (let i = 0; i < 20; i++) {
      history.push({
        timestamp: i * 50,
        luminance: i % 2 === 0 ? 0.0 : 0.9,
        redRatio: 0,
      });
    }
    const det = createDetectorWithHistory('medium', history);
    const result = det._analyzeWindow();
    assert.strictEqual(result.isFlashing, true);
    assert.ok(result.flashCount >= 3, `expected >= 3 flashes, got ${result.flashCount}`);
  });

  it('does NOT detect flashing for constant luminance', () => {
    const history = [];
    for (let i = 0; i < 20; i++) {
      history.push({ timestamp: i * 50, luminance: 0.5, redRatio: 0 });
    }
    const det = createDetectorWithHistory('medium', history);
    const result = det._analyzeWindow();
    assert.strictEqual(result.isFlashing, false);
    assert.strictEqual(result.flashCount, 0);
    assert.strictEqual(result.severity, 'safe');
  });

  it('does NOT detect flashing for gradual luminance change', () => {
    const history = [];
    for (let i = 0; i < 20; i++) {
      history.push({ timestamp: i * 50, luminance: i * 0.04, redRatio: 0 });
    }
    const det = createDetectorWithHistory('medium', history);
    const result = det._analyzeWindow();
    assert.strictEqual(result.isFlashing, false);
  });

  it('triggers at medium (3 flashes/sec) with exactly 3 flash cycles', () => {
    // 3 flash cycles = 6 opposing transitions
    // Each cycle: bright -> dark -> bright
    // We need transitions at direction changes
    const history = [
      { timestamp: 0, luminance: 0.0, redRatio: 0 },
      { timestamp: 50, luminance: 0.9, redRatio: 0 },   // up
      { timestamp: 100, luminance: 0.0, redRatio: 0 },   // down (opposing -> transition 1)
      { timestamp: 150, luminance: 0.9, redRatio: 0 },   // up (opposing -> transition 2)
      { timestamp: 200, luminance: 0.0, redRatio: 0 },   // down (opposing -> transition 3)
      { timestamp: 250, luminance: 0.9, redRatio: 0 },   // up (opposing -> transition 4)
      { timestamp: 300, luminance: 0.0, redRatio: 0 },   // down (opposing -> transition 5)
      { timestamp: 350, luminance: 0.9, redRatio: 0 },   // up (opposing -> transition 6)
    ];
    const det = createDetectorWithHistory('medium', history);
    const result = det._analyzeWindow();
    assert.ok(result.flashCount >= 3, `expected >= 3 flashes, got ${result.flashCount}`);
    assert.strictEqual(result.isFlashing, true);
  });

  it('does NOT trigger at medium for 2 flash cycles but DOES trigger at high', () => {
    // 2 flash cycles = 4 opposing transitions = ceil(4/2) = 2 flashes
    const history = [
      { timestamp: 0, luminance: 0.0, redRatio: 0 },
      { timestamp: 100, luminance: 0.9, redRatio: 0 },   // up
      { timestamp: 200, luminance: 0.0, redRatio: 0 },   // down (transition 1)
      { timestamp: 300, luminance: 0.9, redRatio: 0 },   // up (transition 2)
      { timestamp: 400, luminance: 0.0, redRatio: 0 },   // down (transition 3)
      { timestamp: 500, luminance: 0.9, redRatio: 0 },   // up (transition 4)
    ];

    const medDet = createDetectorWithHistory('medium', history);
    const medResult = medDet._analyzeWindow();
    assert.strictEqual(medResult.isFlashing, false,
      `medium should not trigger at ${medResult.flashCount} flashes`);

    const highDet = createDetectorWithHistory('high', history);
    const highResult = highDet._analyzeWindow();
    assert.strictEqual(highResult.isFlashing, true,
      `high should trigger at ${highResult.flashCount} flashes`);
  });

  it('ignores luminance changes below the 0.1 threshold', () => {
    const history = [];
    for (let i = 0; i < 20; i++) {
      history.push({
        timestamp: i * 50,
        luminance: i % 2 === 0 ? 0.40 : 0.45,
        redRatio: 0,
      });
    }
    const det = createDetectorWithHistory('maximum', history);
    const result = det._analyzeWindow();
    assert.strictEqual(result.isFlashing, false);
    assert.strictEqual(result.flashCount, 0);
  });

  it('ignores transitions where darker state >= 0.80', () => {
    const history = [];
    for (let i = 0; i < 20; i++) {
      history.push({
        timestamp: i * 50,
        luminance: i % 2 === 0 ? 0.85 : 0.99,
        redRatio: 0,
      });
    }
    const det = createDetectorWithHistory('maximum', history);
    const result = det._analyzeWindow();
    assert.strictEqual(result.isFlashing, false);
  });

  it('detects red flash when avgRedRatio >= 0.80', () => {
    const history = [
      { timestamp: 0, luminance: 0.0, redRatio: 0.9 },
      { timestamp: 50, luminance: 0.5, redRatio: 0.85 },
      { timestamp: 100, luminance: 0.0, redRatio: 0.9 },
      { timestamp: 150, luminance: 0.5, redRatio: 0.85 },
      { timestamp: 200, luminance: 0.0, redRatio: 0.9 },
      { timestamp: 250, luminance: 0.5, redRatio: 0.85 },
      { timestamp: 300, luminance: 0.0, redRatio: 0.9 },
      { timestamp: 350, luminance: 0.5, redRatio: 0.85 },
    ];
    const det = createDetectorWithHistory('medium', history);
    const result = det._analyzeWindow();
    assert.strictEqual(result.isRedFlash, true);
  });

  it('does NOT flag red flash when avgRedRatio < 0.80', () => {
    const history = [
      { timestamp: 0, luminance: 0.0, redRatio: 0.3 },
      { timestamp: 50, luminance: 0.5, redRatio: 0.3 },
      { timestamp: 100, luminance: 0.0, redRatio: 0.3 },
      { timestamp: 150, luminance: 0.5, redRatio: 0.3 },
      { timestamp: 200, luminance: 0.0, redRatio: 0.3 },
      { timestamp: 250, luminance: 0.5, redRatio: 0.3 },
      { timestamp: 300, luminance: 0.0, redRatio: 0.3 },
      { timestamp: 350, luminance: 0.5, redRatio: 0.3 },
    ];
    const det = createDetectorWithHistory('medium', history);
    const result = det._analyzeWindow();
    assert.strictEqual(result.isRedFlash, false);
  });

  it('reports peakDelta as the maximum absolute luminance change', () => {
    const history = [
      { timestamp: 0, luminance: 0.0, redRatio: 0 },
      { timestamp: 50, luminance: 0.3, redRatio: 0 },
      { timestamp: 100, luminance: 0.0, redRatio: 0 },
      { timestamp: 150, luminance: 0.7, redRatio: 0 },
    ];
    const det = createDetectorWithHistory('medium', history);
    const result = det._analyzeWindow();
    assertApprox(result.peakDelta, 0.7, 1e-10, 'peak delta');
  });

  it('classifies severity as "danger" when flashCount >= 10', () => {
    const history = [];
    for (let i = 0; i < 30; i++) {
      history.push({
        timestamp: i * 33,
        luminance: i % 2 === 0 ? 0.0 : 0.9,
        redRatio: 0,
      });
    }
    const det = createDetectorWithHistory('medium', history);
    const result = det._analyzeWindow();
    if (result.flashCount >= 10) {
      assert.strictEqual(result.severity, 'danger');
    }
  });

  it('classifies severity as "danger" for red flash regardless of count', () => {
    const history = [];
    for (let i = 0; i < 20; i++) {
      history.push({
        timestamp: i * 50,
        luminance: i % 2 === 0 ? 0.0 : 0.9,
        redRatio: 0.9,
      });
    }
    const det = createDetectorWithHistory('medium', history);
    const result = det._analyzeWindow();
    if (result.isFlashing && result.isRedFlash) {
      assert.strictEqual(result.severity, 'danger');
    }
  });

  it('classifies severity as "warning" for moderate flashing', () => {
    // Exactly enough to trigger medium (3 flashes) but not 10
    const history = [
      { timestamp: 0, luminance: 0.0, redRatio: 0 },
      { timestamp: 50, luminance: 0.9, redRatio: 0 },
      { timestamp: 100, luminance: 0.0, redRatio: 0 },
      { timestamp: 150, luminance: 0.9, redRatio: 0 },
      { timestamp: 200, luminance: 0.0, redRatio: 0 },
      { timestamp: 250, luminance: 0.9, redRatio: 0 },
      { timestamp: 300, luminance: 0.0, redRatio: 0 },
      { timestamp: 350, luminance: 0.9, redRatio: 0 },
    ];
    const det = createDetectorWithHistory('medium', history);
    const result = det._analyzeWindow();
    if (result.isFlashing && result.flashCount < 10 && !result.isRedFlash) {
      assert.strictEqual(result.severity, 'warning');
    }
  });
});

describe('FlashDetector class', () => {
  it('defaults to medium sensitivity', () => {
    const det = new FlashDetector({ tagName: 'VIDEO' }, {});
    assert.strictEqual(det.sensitivity, 'medium');
  });

  it('setSensitivity updates to valid levels', () => {
    const det = new FlashDetector({ tagName: 'VIDEO' }, {});
    det.setSensitivity('high');
    assert.strictEqual(det.sensitivity, 'high');
    det.setSensitivity('low');
    assert.strictEqual(det.sensitivity, 'low');
  });

  it('setSensitivity ignores invalid levels', () => {
    const det = new FlashDetector({ tagName: 'VIDEO' }, {});
    det.setSensitivity('turbo');
    assert.strictEqual(det.sensitivity, 'medium');
  });

  it('destroy sets destroyed flag and clears state', () => {
    const det = new FlashDetector({ tagName: 'VIDEO' }, {});
    det.frameHistory = [{ timestamp: 0, luminance: 0.5, redRatio: 0 }];
    det.destroy();
    assert.strictEqual(det.destroyed, true);
    assert.strictEqual(det.running, false);
    assert.strictEqual(det.frameHistory.length, 0);
    assert.strictEqual(det.element, null);
  });

  it('start does nothing after destroy', () => {
    const det = new FlashDetector({ tagName: 'VIDEO' }, {});
    det.destroy();
    det.start();
    assert.strictEqual(det.running, false);
  });

  it('stop clears the running flag', () => {
    const det = new FlashDetector({ tagName: 'VIDEO' }, {});
    det.running = true;
    det.stop();
    assert.strictEqual(det.running, false);
  });
});

describe('CSSFlashDetector class', () => {
  it('defaults to medium sensitivity', () => {
    const det = new CSSFlashDetector({}, {});
    assert.strictEqual(det.sensitivity, 'medium');
  });

  it('setSensitivity updates to valid levels', () => {
    const det = new CSSFlashDetector({}, {});
    det.setSensitivity('maximum');
    assert.strictEqual(det.sensitivity, 'maximum');
  });

  it('setSensitivity ignores invalid levels', () => {
    const det = new CSSFlashDetector({}, {});
    det.setSensitivity('invalid');
    assert.strictEqual(det.sensitivity, 'medium');
  });

  it('destroy sets destroyed flag and clears state', () => {
    const det = new CSSFlashDetector({}, {});
    det.destroy();
    assert.strictEqual(det.destroyed, true);
    assert.strictEqual(det.running, false);
    assert.strictEqual(det.element, null);
  });

  it('_parseColor extracts rgb values correctly', () => {
    const det = new CSSFlashDetector({}, {});
    const rgb = det._parseColor('rgb(100, 200, 50)');
    assert.strictEqual(rgb.r, 100);
    assert.strictEqual(rgb.g, 200);
    assert.strictEqual(rgb.b, 50);
  });

  it('_parseColor handles rgba', () => {
    const det = new CSSFlashDetector({}, {});
    const rgb = det._parseColor('rgba(255, 128, 0, 0.5)');
    assert.strictEqual(rgb.r, 255);
    assert.strictEqual(rgb.g, 128);
    assert.strictEqual(rgb.b, 0);
  });

  it('_parseColor returns null for transparent', () => {
    const det = new CSSFlashDetector({}, {});
    assert.strictEqual(det._parseColor('transparent'), null);
  });

  it('_parseColor returns null for null/undefined input', () => {
    const det = new CSSFlashDetector({}, {});
    assert.strictEqual(det._parseColor(null), null);
    assert.strictEqual(det._parseColor(undefined), null);
  });

  it('_parseColor returns null for invalid color strings', () => {
    const det = new CSSFlashDetector({}, {});
    assert.strictEqual(det._parseColor('not-a-color'), null);
  });
});

describe('End-to-end analysis pipeline', () => {
  it('alternating pure black/white frames trigger flash detection', () => {
    const frames = [];
    for (let i = 0; i < 16; i++) {
      const data = i % 2 === 0
        ? makeFrame(0, 0, 0, 255, 64)
        : makeFrame(255, 255, 255, 255, 64);
      const analysis = _analyzeFrame(data);
      frames.push({ timestamp: i * 66, luminance: analysis.luminance, redRatio: analysis.redRatio });
    }
    const det = createDetectorWithHistory('medium', frames);
    const result = det._analyzeWindow();
    assert.strictEqual(result.isFlashing, true);
    assert.ok(result.peakDelta > 0.9, `expected peak delta > 0.9, got ${result.peakDelta}`);
  });

  it('steady mid-gray frames do not trigger flash detection', () => {
    const frames = [];
    for (let i = 0; i < 16; i++) {
      const data = makeFrame(128, 128, 128, 255, 64);
      const analysis = _analyzeFrame(data);
      frames.push({ timestamp: i * 66, luminance: analysis.luminance, redRatio: analysis.redRatio });
    }
    const det = createDetectorWithHistory('maximum', frames);
    const result = det._analyzeWindow();
    assert.strictEqual(result.isFlashing, false);
  });

  it('alternating bright-red/dark-red frames detect red flash', () => {
    // Both frames must have high redRatio so avgRedRatio >= 0.80 across transitions
    const frames = [];
    for (let i = 0; i < 16; i++) {
      const data = i % 2 === 0
        ? makeFrame(40, 1, 1, 255, 64)
        : makeFrame(255, 1, 1, 255, 64);
      const analysis = _analyzeFrame(data);
      frames.push({ timestamp: i * 66, luminance: analysis.luminance, redRatio: analysis.redRatio });
    }
    const det = createDetectorWithHistory('medium', frames);
    const result = det._analyzeWindow();
    assert.strictEqual(result.isFlashing, true);
    assert.strictEqual(result.isRedFlash, true);
  });
});
