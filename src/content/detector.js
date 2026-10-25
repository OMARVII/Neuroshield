/**
 * NeuroShield — WCAG 2.3.1 / 2.3.2 flash analysis.
 *
 * Pure analysis: turns frames of pixels into luminance samples and decides
 * whether a sliding one-second window contains too many flashes. No DOM
 * access, so the same file runs in the content script and in Node tests.
 *
 * Definitions (WCAG 2.x, "general flash and red flash thresholds"):
 *   - Relative luminance uses sRGB linearization (IEC 61966-2-1) and the
 *     ITU-R BT.709 coefficients.
 *   - A transition is a change in relative luminance of 0.1 or more where the
 *     darker state is below 0.80.
 *   - A flash is a pair of opposing transitions. Content fails when it
 *     flashes more than three times in any one second: seven transitions.
 *   - A red transition involves a saturated red: R/(R+G+B) >= 0.8 and a
 *     change in (R - G - B) x 320 of more than 20 (R, G, B linear, as in the
 *     relative luminance definition).
 *   - Flashes smaller than 25% of a 10° visual field (about 341 × 256 CSS px
 *     at typical viewing distance) are below the threshold.
 *
 * Transitions are counted peak-to-peak (from the last turning point), not
 * frame-to-frame. Frame-to-frame deltas shrink as the sampling rate rises, so a
 * smooth flash sampled at 60 fps could slip under the 0.1 threshold even though
 * it swings from black to white.
 */
var NeuroShieldDetector = (() => {
  'use strict';

  // ─── Constants ───────────────────────────────────────────────────────

  /** Analysis grid: each frame is reduced to SAMPLE_SIZE × SAMPLE_SIZE samples. */
  const SAMPLE_SIZE = 32;

  /**
   * Localized flashes are found at two scales, each with overlapping
   * positions so a flash centred on a boundary isn't split four ways:
   *   fine:   a 4×4 grid of 8×8-sample regions, plus a 3×3 grid of the same
   *           size shifted by half a region;
   *   coarse: 16×16-sample blocks (a quarter of the frame) at 3×3 positions.
   */
  const REGION_GRID = 4;
  const REGION_COUNT = REGION_GRID * REGION_GRID;
  const REGION_SIZE = SAMPLE_SIZE / REGION_GRID;
  const OFFSET_GRID = REGION_GRID - 1;
  const OFFSET_COUNT = OFFSET_GRID * OFFSET_GRID;
  const BLOCK_GRID = 3;
  const BLOCK_COUNT = BLOCK_GRID * BLOCK_GRID;

  /** WCAG's small safe area, in CSS px²: 25% of a 10° visual field (341 × 256 px). */
  const WCAG_AREA = 0.25 * 341 * 256;

  /** Sliding window for counting flashes: WCAG counts flashes in any one second. */
  const WINDOW_MS = 1000;

  const LUMINANCE_DELTA_THRESHOLD = 0.1;
  const DARK_STATE_THRESHOLD = 0.8;
  const RED_RATIO_THRESHOLD = 0.8;
  /** WCAG: (R - G - B) x 320 > 20, with R, G, B linear in [0, 1]. */
  const RED_LEVEL_THRESHOLD = 20 / 320;
  /** At or above this flash rate (per second) the severity is "danger". */
  const DANGER_FLASH_COUNT = 10;

  /**
   * Sensitivity presets, in flashes per second. Low, Medium and High trigger
   * at more than that many flashes in a second (Medium is WCAG 2.3.1: "no
   * more than three flashes in any one second"); Maximum triggers at one.
   */
  const SENSITIVITY = Object.freeze({
    low: 5,
    medium: 3,
    high: 2,
    maximum: 1,
  });

  /** Transitions within the window that trigger each preset. */
  const TRIGGER_TRANSITIONS = Object.freeze({
    low: 2 * SENSITIVITY.low + 1,
    medium: 2 * SENSITIVITY.medium + 1,
    high: 2 * SENSITIVITY.high + 1,
    maximum: 2 * SENSITIVITY.maximum,
  });

  // ─── sRGB → linear → relative luminance ─────────────────────────────

  /**
   * Linearize an sRGB channel value (0–255).
   * @param {number} c
   * @returns {number} linear value in [0, 1]
   */
  function linearize(c) {
    const s = c / 255;
    return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  }

  /** WCAG relative luminance from linear RGB in [0, 1]. */
  function relativeLuminance(r, g, b) {
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  }

  /** sRGB byte → linear float. */
  const LINEAR_LUT = new Float32Array(256);
  for (let i = 0; i < 256; i++) LINEAR_LUT[i] = linearize(i);

  // ─── Frame analysis ──────────────────────────────────────────────────

  /** Per-area sums: luminance, linear R, G, B, red level. */
  const SUMS = 5;

  function summarize(sums, k, count) {
    const r = sums[k + 1];
    const total = r + sums[k + 2] + sums[k + 3];
    return {
      luminance: sums[k] / count,
      // WCAG's R/(R+G+B) on linear values, from the area's summed light, so
      // black parts of the area don't water down a red that's there.
      redRatio: total > 0 ? r / total : 0,
      redLevel: sums[k + 4] / count,
    };
  }

  /**
   * Reduce one frame of RGBA pixels to whole-frame and per-area samples.
   *
   * For a 32×32 frame the result also has the fine regions (16, row-major
   * 4×4), the shifted fine regions (9, row-major 3×3) and the coarse blocks
   * (9, row-major 3×3). Other sizes get whole-frame values in every area.
   *
   * @param {Uint8Array|Uint8ClampedArray} data RGBA bytes
   * @param {boolean} [linearInput] true when bytes are already linear light
   *   (the WebGL sampler averages in linear space), false for sRGB bytes
   * @returns {{ luminance: number, redRatio: number, redLevel: number,
   *             regions: Array<object>, offsets: Array<object>, blocks: Array<object> }}
   */
  function analyzeFrame(data, linearInput) {
    const pixelCount = data.length >> 2;
    const isGrid = pixelCount === SAMPLE_SIZE * SAMPLE_SIZE;
    const aligned = new Float64Array(REGION_COUNT * SUMS);
    const shifted = new Float64Array(OFFSET_COUNT * SUMS);
    const whole = new Float64Array(SUMS);
    const half = REGION_SIZE / 2;
    const span = OFFSET_GRID * REGION_SIZE;

    for (let p = 0, i = 0; p < pixelCount; p++, i += 4) {
      const rLin = linearInput ? data[i] / 255 : LINEAR_LUT[data[i]];
      const gLin = linearInput ? data[i + 1] / 255 : LINEAR_LUT[data[i + 1]];
      const bLin = linearInput ? data[i + 2] / 255 : LINEAR_LUT[data[i + 2]];
      const l = relativeLuminance(rLin, gLin, bLin);
      const red = rLin - gLin - bLin;
      const rl = red > 0 ? red : 0;

      whole[0] += l;
      whole[1] += rLin;
      whole[2] += gLin;
      whole[3] += bLin;
      whole[4] += rl;

      if (isGrid) {
        const x = p & (SAMPLE_SIZE - 1);
        const y = p >> 5;
        let k = ((y >> 3) * REGION_GRID + (x >> 3)) * SUMS;
        aligned[k] += l;
        aligned[k + 1] += rLin;
        aligned[k + 2] += gLin;
        aligned[k + 3] += bLin;
        aligned[k + 4] += rl;
        const ox = x - half;
        const oy = y - half;
        if (ox >= 0 && oy >= 0 && ox < span && oy < span) {
          k = ((oy >> 3) * OFFSET_GRID + (ox >> 3)) * SUMS;
          shifted[k] += l;
          shifted[k + 1] += rLin;
          shifted[k + 2] += gLin;
          shifted[k + 3] += bLin;
          shifted[k + 4] += rl;
        }
      }
    }

    const frame = summarize(whole, 0, pixelCount || 1);
    frame.regions = new Array(REGION_COUNT);
    frame.offsets = new Array(OFFSET_COUNT);
    frame.blocks = new Array(BLOCK_COUNT);
    if (!isGrid) {
      frame.regions.fill(frame);
      frame.offsets.fill(frame);
      frame.blocks.fill(frame);
      return frame;
    }
    const perRegion = REGION_SIZE * REGION_SIZE;
    for (let r = 0; r < REGION_COUNT; r++) frame.regions[r] = summarize(aligned, r * SUMS, perRegion);
    for (let r = 0; r < OFFSET_COUNT; r++) frame.offsets[r] = summarize(shifted, r * SUMS, perRegion);
    // Coarse blocks: 2×2 fine regions starting at each of the 3×3 region positions.
    const block = new Float64Array(SUMS);
    for (let by = 0; by < BLOCK_GRID; by++) {
      for (let bx = 0; bx < BLOCK_GRID; bx++) {
        block.fill(0);
        for (const [dx, dy] of [[0, 0], [1, 0], [0, 1], [1, 1]]) {
          const k = ((by + dy) * REGION_GRID + bx + dx) * SUMS;
          for (let c = 0; c < SUMS; c++) block[c] += aligned[k + c];
        }
        frame.blocks[by * BLOCK_GRID + bx] = summarize(block, 0, 4 * perRegion);
      }
    }
    return frame;
  }

  // ─── Flash window analysis ───────────────────────────────────────────

  /** Saturated red per WCAG. Samples without redLevel (older callers) only use the ratio. */
  function isSaturatedRed(s) {
    return s.redRatio >= RED_RATIO_THRESHOLD && (s.redLevel === undefined || s.redLevel > RED_LEVEL_THRESHOLD);
  }

  /**
   * Count transitions in one series, peak-to-peak.
   *
   * Until the first transition, the running high and low are tracked. After
   * that, the extreme of the current swing is extended while the signal keeps
   * moving the same way. A transition is confirmed when the signal moves back
   * from that extreme by at least `threshold`.
   *
   * @param {Array<object>} samples
   * @param {(s: object) => number} value series value of a sample
   * @param {number} threshold minimum swing
   * @param {(from: object, to: object) => boolean} accept extra condition on a swing
   * @param {(from: object, to: object, swing: number) => void} onTransition
   * @returns {number} transitions counted
   */
  function countTransitions(samples, value, threshold, accept, onTransition) {
    const n = samples.length;
    if (n < 2) return 0;
    let count = 0;
    let dir = 0;
    let hi = samples[0];
    let lo = samples[0];
    let extreme = samples[0];

    for (let i = 1; i < n; i++) {
      const s = samples[i];
      const v = value(s);

      if (dir === 0) {
        if (v > value(hi)) hi = s;
        if (v < value(lo)) lo = s;
        const swing = value(hi) - value(lo);
        if (swing >= threshold && (s === hi || s === lo)) {
          const rising = s === hi;
          const from = rising ? lo : hi;
          if (accept(from, s)) {
            count++;
            onTransition(from, s, swing);
            dir = rising ? 1 : -1;
            extreme = s;
          }
        }
      } else if (dir === 1) {
        if (v >= value(extreme)) {
          extreme = s;
        } else {
          const swing = value(extreme) - v;
          if (swing >= threshold && accept(extreme, s)) {
            count++;
            onTransition(extreme, s, swing);
            dir = -1;
            extreme = s;
          }
        }
      } else if (v <= value(extreme)) {
        extreme = s;
      } else {
        const swing = v - value(extreme);
        if (swing >= threshold && accept(extreme, s)) {
          count++;
          onTransition(extreme, s, swing);
          dir = 1;
          extreme = s;
        }
      }
    }
    return count;
  }

  const getLuminance = (s) => s.luminance;
  const getRedLevel = (s) => (s.redLevel === undefined ? 0 : s.redLevel);
  const darkerBelowLimit = (a, b) => Math.min(a.luminance, b.luminance) < DARK_STATE_THRESHOLD;
  const involvesSaturatedRed = (a, b) => isSaturatedRed(a) || isSaturatedRed(b);

  /**
   * Flash frequency implied by transitions spread from `first` to `last` ms.
   * More accurate than the window count right after detection, when only a
   * few flashes have been seen but they came quickly.
   */
  function flashRate(transitions, first, last) {
    if (transitions < 3 || !(last > first)) return transitions / 2;
    return Math.min(60, ((transitions - 1) / 2) * (1000 / (last - first)));
  }

  /**
   * Analyze one series of samples (the whole frame, or one region).
   * @returns {{ flashCount: number, flashesPerSecond: number,
   *             redTransitions: number, peakDelta: number }}
   */
  function analyzeSeries(samples) {
    let peakDelta = 0;
    let redTransitions = 0;
    let gFirst = -1;
    let gLast = -1;
    let rFirst = -1;
    let rLast = -1;

    const general = countTransitions(samples, getLuminance, LUMINANCE_DELTA_THRESHOLD, darkerBelowLimit, (from, to, swing) => {
      if (swing > peakDelta) peakDelta = swing;
      if (involvesSaturatedRed(from, to)) redTransitions++;
      if (gFirst < 0) gFirst = to.timestamp;
      gLast = to.timestamp;
    });

    // Red flashes can happen without a large luminance change (red ↔ green).
    // Only samples that report redLevel can take part.
    const red = samples[0] && samples[0].redLevel !== undefined
      ? countTransitions(samples, getRedLevel, RED_LEVEL_THRESHOLD, involvesSaturatedRed, (from, to) => {
        if (rFirst < 0) rFirst = to.timestamp;
        rLast = to.timestamp;
      })
      : 0;

    const useRed = red > general;
    const transitions = useRed ? red : general;
    return {
      transitions,
      flashCount: Math.floor(transitions / 2),
      flashesPerSecond: useRed ? flashRate(red, rFirst, rLast) : flashRate(general, gFirst, gLast),
      redTransitions: redTransitions + red,
      peakDelta,
    };
  }

  /** @param {number} needed transitions in the window that count as flashing */
  function verdict(series, needed, region) {
    const isFlashing = series.transitions >= needed;
    const isRedFlash = series.redTransitions > 0;
    const rate = Math.max(series.flashCount, series.flashesPerSecond);
    let severity = 'safe';
    if (isFlashing) {
      severity = rate >= DANGER_FLASH_COUNT || isRedFlash ? 'danger' : 'warning';
    }
    return {
      isFlashing,
      flashCount: series.flashCount,
      flashesPerSecond: Math.round(rate),
      isRedFlash,
      peakDelta: series.peakDelta,
      severity,
      region,
    };
  }

  /**
   * Which analysis scales can show a flash of at least the WCAG area, for
   * content displayed at `area` CSS px². Unknown size: all of them.
   */
  function scalesFor(area) {
    if (!(area > 0)) return { whole: true, coarse: true, fine: true };
    return { whole: area >= WCAG_AREA, coarse: area / 4 >= WCAG_AREA, fine: area / REGION_COUNT >= WCAG_AREA };
  }

  const SAFE = Object.freeze({ isFlashing: false, flashCount: 0, flashesPerSecond: 0, isRedFlash: false, peakDelta: 0, severity: 'safe', region: -1 });

  /** Check one kind of area (e.g. the fine regions) across the window. */
  function firstFlashingArea(history, key, count, limit, indexBase) {
    const first = history[0][key];
    if (!first || first.length !== count) return null;
    const series = new Array(history.length);
    for (let r = 0; r < count; r++) {
      for (let i = 0; i < history.length; i++) series[i] = history[i][key][r];
      const result = verdict(analyzeSeries(series), limit, indexBase + r);
      if (result.isFlashing) return result;
    }
    return null;
  }

  /**
   * Decide whether a window of samples is flashing too much.
   *
   * The whole frame is checked first. If it does not trigger, quarter-frame
   * blocks and then the fine regions are checked on their own, so a flash
   * confined to part of the frame isn't averaged away by the static rest.
   * Scales whose areas are too small on screen to hold a flash of the WCAG
   * area are skipped.
   *
   * @param {Array<{timestamp: number, luminance: number, redRatio: number,
   *                redLevel?: number, regions?: Array<object>,
   *                offsets?: Array<object>, blocks?: Array<object>}>} history
   * @param {string} sensitivity 'low' | 'medium' | 'high' | 'maximum'
   * @param {number} [area] displayed size of the content in CSS px²
   * @returns {{ isFlashing: boolean, flashCount: number, flashesPerSecond: number,
   *             isRedFlash: boolean, peakDelta: number, severity: string, region: number }}
   *          flashCount is the number of flashes in the window; flashesPerSecond
   *          estimates the rate from transition timing. region is -1 for the
   *          whole frame, 0–15 for a fine region, 16–24 for a shifted fine
   *          region and 25–33 for a coarse block.
   */
  function analyzeFlashWindow(history, sensitivity, area) {
    if (history.length < 3) return Object.assign({}, SAFE);
    const scales = scalesFor(area);
    if (!scales.whole) return Object.assign({}, SAFE);
    const limit = TRIGGER_TRANSITIONS[sensitivity] || TRIGGER_TRANSITIONS.medium;
    const whole = verdict(analyzeSeries(history), limit, -1);
    if (whole.isFlashing) return whole;

    const local = (scales.coarse && firstFlashingArea(history, 'blocks', BLOCK_COUNT, limit, REGION_COUNT + OFFSET_COUNT))
      || (scales.fine && (firstFlashingArea(history, 'regions', REGION_COUNT, limit, 0)
        || firstFlashingArea(history, 'offsets', OFFSET_COUNT, limit, REGION_COUNT)));
    if (local) {
      if (whole.peakDelta > local.peakDelta) local.peakDelta = whole.peakDelta;
      return local;
    }
    return whole;
  }

  // ─── CSS colors ──────────────────────────────────────────────────────

  const RGB_PATTERN = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:\s*[,/]\s*([\d.]+)(%?))?\s*\)$/i;
  const SRGB_PATTERN = /^color\(srgb\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)(?:\s*\/\s*([\d.]+)(%?))?\s*\)$/i;

  function clampByte(v) {
    return Math.max(0, Math.min(255, Math.round(v)));
  }

  function parseAlpha(value, percent) {
    if (value === undefined) return 1;
    const a = parseFloat(value) / (percent ? 100 : 1);
    return Number.isFinite(a) ? Math.max(0, Math.min(1, a)) : 1;
  }

  /**
   * Parse a computed CSS color (as returned by getComputedStyle) into sRGB
   * bytes and alpha. Returns null for anything that isn't rgb()/rgba() or
   * color(srgb …), including 'transparent'.
   * @param {string} color
   * @returns {{ r: number, g: number, b: number, a: number } | null}
   */
  function parseColor(color) {
    if (typeof color !== 'string') return null;
    const value = color.trim();
    let m = RGB_PATTERN.exec(value);
    if (m) {
      return { r: clampByte(+m[1]), g: clampByte(+m[2]), b: clampByte(+m[3]), a: parseAlpha(m[4], m[5]) };
    }
    m = SRGB_PATTERN.exec(value);
    if (m) {
      return { r: clampByte(m[1] * 255), g: clampByte(m[2] * 255), b: clampByte(m[3] * 255), a: parseAlpha(m[4], m[5]) };
    }
    return null;
  }

  /** Relative luminance of sRGB bytes. */
  function luminanceOf(rgb) {
    return relativeLuminance(LINEAR_LUT[rgb.r], LINEAR_LUT[rgb.g], LINEAR_LUT[rgb.b]);
  }

  // ─── Streaming analyzer ──────────────────────────────────────────────

  /**
   * Keeps the sliding window for one source and analyzes each new sample.
   */
  class FlashAnalyzer {
    constructor(sensitivity) {
      this.sensitivity = SENSITIVITY[sensitivity] !== undefined ? sensitivity : 'medium';
      this.history = [];
      /** Displayed size in CSS px², or 0 when unknown. */
      this.area = 0;
    }

    /** How large the content is on screen; small content can't flash over the WCAG area. */
    setArea(area) {
      this.area = area > 0 ? area : 0;
    }

    setSensitivity(level) {
      if (SENSITIVITY[level] !== undefined) this.sensitivity = level;
    }

    reset() {
      this.history.length = 0;
    }

    /**
     * Add a sample and analyze the window ending at it. Samples older than the
     * window are dropped; a sample older than the newest one resets the window
     * (the clock went backwards).
     */
    push(sample) {
      if (!Number.isFinite(sample.luminance) || !Number.isFinite(sample.timestamp)) return Object.assign({}, SAFE);
      const h = this.history;
      if (h.length && sample.timestamp < h[h.length - 1].timestamp) h.length = 0;
      h.push(sample);
      const cutoff = sample.timestamp - WINDOW_MS;
      let drop = 0;
      while (drop < h.length && h[drop].timestamp < cutoff) drop++;
      if (drop) h.splice(0, drop);
      return analyzeFlashWindow(h, this.sensitivity, this.area);
    }
  }

  return Object.freeze({
    SENSITIVITY,
    SAMPLE_SIZE,
    REGION_COUNT,
    WINDOW_MS,
    WCAG_AREA,
    FlashAnalyzer,
    analyzeFrame,
    analyzeFlashWindow,
    linearize,
    relativeLuminance,
    luminanceOf,
    parseColor,
  });
})();
