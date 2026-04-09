/**
 * NeuroShield — WCAG 2.3.1 Flash Detection Engine
 *
 * Detects dangerous flashing content in real-time by analyzing
 * luminance transitions in video frames and animated elements.
 *
 * References:
 *   - WCAG 2.3.1: Three Flashes or Below Threshold (Level A)
 *   - WCAG 2.3.2: Three Flashes (Level AAA)
 *   - ITU-R BT.709 relative luminance
 *   - W3C "relative luminance" definition with sRGB linearization
 */

var NeuroShieldDetector = (function () {
  'use strict';

  // ─── Constants ───────────────────────────────────────────────────────

  /** Downsampled analysis resolution (pixels). Lower = faster. */
  const SAMPLE_WIDTH = 32;
  const SAMPLE_HEIGHT = 32;

  /** Target analysis frame rate (Hz). 15 fps ≈ 66ms per sample. */
  const TARGET_FPS = 15;
  const FRAME_INTERVAL_MS = Math.round(1000 / TARGET_FPS);

  /**
   * Sliding window duration for flash counting (ms).
   * Extended by one frame interval beyond 1 second so the window reliably
   * captures transitions at the boundary. Without this, a flash whose
   * direction change falls right at the 1-second edge is missed ~40% of the
   * time, causing under-detection at the exact threshold frequency (e.g.
   * 3 Hz at medium sensitivity).  The extra 67 ms has negligible impact on
   * false-positive rate (effective threshold shifts from 3.0 Hz to ~2.8 Hz).
   */
  const WINDOW_DURATION_MS = 1000 + FRAME_INTERVAL_MS;

  /**
   * WCAG general flash threshold.
   * A "general flash" is a pair of opposing luminance changes of ≥ 0.1
   * (on a 0–1 relative luminance scale) where the darker state < 0.80.
   */
  const LUMINANCE_DELTA_THRESHOLD = 0.1;
  const DARK_STATE_THRESHOLD = 0.80;

  /**
   * WCAG red flash thresholds.
   * A "red flash" is a pair of opposing transitions involving a saturated red.
   * Saturated red: R/(R+G+B) ≥ 0.80 and R value is dominant.
   */
  const RED_RATIO_THRESHOLD = 0.80;

  /** Sensitivity presets: max flashes per second before triggering. */
  const SENSITIVITY = {
    low: 5,       // Relaxed — only extreme strobing
    medium: 3,    // WCAG 2.3.1 standard
    high: 2,      // Stricter than WCAG
    maximum: 1,   // Any significant flash triggers
  };

  // ─── Extension Context Validation ─────────────────────────────────────

  function isExtensionContextValid() {
    try { return !!(typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.id); }
    catch (e) { return false; }
  }

  // ─── sRGB → Linear → Relative Luminance ─────────────────────────────

  /**
   * Linearize an sRGB channel value (0–255) per WCAG/IEC 61966-2-1.
   * @param {number} c — sRGB channel value [0, 255]
   * @returns {number} Linear channel value [0, 1]
   */
  function linearize(c) {
    const s = c / 255;
    return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  }

  /**
   * Compute WCAG relative luminance from linear RGB.
   * L = 0.2126·R + 0.7152·G + 0.0722·B
   * @param {number} r — Linear red [0, 1]
   * @param {number} g — Linear green [0, 1]
   * @param {number} b — Linear blue [0, 1]
   * @returns {number} Relative luminance [0, 1]
   */
  function relativeLuminance(r, g, b) {
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  }

  // ─── Pre-computed lookup table for linearization (perf) ──────────────

  const LINEAR_LUT = new Float32Array(256);
  for (let i = 0; i < 256; i++) {
    LINEAR_LUT[i] = linearize(i);
  }

  // ─── Frame Analysis ──────────────────────────────────────────────────

  /**
   * Analyze a single frame's pixel data. Returns average luminance
   * and average red ratio for flash classification.
   *
   * @param {Uint8ClampedArray} data — RGBA pixel data
   * @returns {{ luminance: number, redRatio: number }}
   */
  function analyzeFrame(data) {
    let totalLuminance = 0;
    let totalRedRatio = 0;
    const pixelCount = data.length / 4;

    for (let i = 0; i < data.length; i += 4) {
      const rLin = LINEAR_LUT[data[i]];
      const gLin = LINEAR_LUT[data[i + 1]];
      const bLin = LINEAR_LUT[data[i + 2]];

      totalLuminance += relativeLuminance(rLin, gLin, bLin);

      // Red ratio for red flash detection
      const sum = data[i] + data[i + 1] + data[i + 2];
      if (sum > 0) {
        totalRedRatio += data[i] / sum;
      }
    }

    return {
      luminance: totalLuminance / pixelCount,
      redRatio: totalRedRatio / pixelCount,
    };
  }

  // ─── Flash Detector Class ────────────────────────────────────────────

  /**
   * FlashDetector monitors a media element for dangerous flash patterns.
   *
   * @param {HTMLVideoElement|HTMLCanvasElement|HTMLImageElement} element
   * @param {object} options
   * @param {string} options.sensitivity — 'low' | 'medium' | 'high' | 'maximum'
   * @param {function} options.onFlashDetected — callback(detail)
   * @param {function} options.onSafe — callback() when flash stops
   */
  function FlashDetector(element, options) {
    this.element = element;
    this.sensitivity = options.sensitivity || 'medium';
    this.onFlashDetected = options.onFlashDetected || function () {};
    this.onSafe = options.onSafe || function () {};

    // Analysis canvas (offscreen, tiny)
    this.canvas = document.createElement('canvas');
    this.canvas.width = SAMPLE_WIDTH;
    this.canvas.height = SAMPLE_HEIGHT;
    this.ctx = this.canvas.getContext('2d', {
      willReadFrequently: true,
      desynchronized: true,
    });

    // Sliding window of frame measurements
    // Each entry: { timestamp, luminance, redRatio }
    this.frameHistory = [];

    // State
    this.running = false;
    this.animFrameId = null;
    this.lastSampleTime = 0;
    this.isFlashing = false;
    this.corsBlocked = false;
    this.destroyed = false;
    this.errorCount = 0;
    this.MAX_ERRORS = 50;
    this._boundOnFrame = this._onFrame.bind(this);
  }

  FlashDetector.prototype = {
    /**
     * Start monitoring the element.
     */
    start: function () {
      if (this.destroyed || this.running) return;
      this.running = true;
      this.lastSampleTime = 0;
      this._loop();
    },

    /**
     * Stop monitoring.
     */
    stop: function () {
      this.running = false;
      if (this.animFrameId) {
        cancelAnimationFrame(this.animFrameId);
        this.animFrameId = null;
      }
    },

    /**
     * Clean up completely.
     */
    destroy: function () {
      this.stop();
      this.destroyed = true;
      this.frameHistory = [];
      this.element = null;
      this.canvas = null;
      this.ctx = null;
    },

    /**
     * Update sensitivity at runtime.
     * @param {string} level
     */
    setSensitivity: function (level) {
      if (SENSITIVITY[level] !== undefined) {
        this.sensitivity = level;
      }
    },

    /**
     * Main analysis loop using requestAnimationFrame.
     * @private
     */
    _loop: function () {
      if (!this.running || this.destroyed) return;

      this.animFrameId = requestAnimationFrame(this._boundOnFrame);
    },

    /**
     * Per-frame callback. Throttled to TARGET_FPS.
     * @private
     */
    _onFrame: function (timestamp) {
      if (!isExtensionContextValid()) { this.destroy(); return; }
      if (!this.running || this.destroyed) return;

      try {
        if (timestamp - this.lastSampleTime < FRAME_INTERVAL_MS) {
          return;
        }
        this.lastSampleTime = timestamp;

        if (this.element.tagName === 'VIDEO') {
          if (this.element.paused || this.element.ended) {
            return;
          }
          if (this.element.videoWidth === 0 || this.element.videoHeight === 0) {
            return;
          }
        }

        var frameData = this._sampleFrame();
        if (!frameData) {
          return;
        }

        this.frameHistory.push({
          timestamp: timestamp,
          luminance: frameData.luminance,
          redRatio: frameData.redRatio,
        });

        var cutoff = timestamp - WINDOW_DURATION_MS;
        while (this.frameHistory.length > 0 && this.frameHistory[0].timestamp < cutoff) {
          this.frameHistory.shift();
        }

        var result = this._analyzeWindow();

        if (result.isFlashing && !this.isFlashing) {
          this.isFlashing = true;
          this.onFlashDetected({
            element: this.element,
            flashesPerSecond: result.flashCount,
            isRedFlash: result.isRedFlash,
            peakLuminanceDelta: result.peakDelta,
            severity: result.severity,
          });
        } else if (!result.isFlashing && this.isFlashing) {
          this.isFlashing = false;
          this.onSafe();
        }
      } catch (e) {
        console.warn('[NeuroShield] _onFrame error:', e);
        this.errorCount++;
        if (this.errorCount > this.MAX_ERRORS) { this.destroy(); return; }
      } finally {
        this._loop();
      }
    },

    /**
     * Draw current frame to analysis canvas and extract pixel data.
     * @private
     * @returns {{ luminance: number, redRatio: number } | null}
     */
    _sampleFrame: function () {
      if (this.corsBlocked) return null;

      try {
        this.ctx.drawImage(this.element, 0, 0, SAMPLE_WIDTH, SAMPLE_HEIGHT);
        var imageData = this.ctx.getImageData(0, 0, SAMPLE_WIDTH, SAMPLE_HEIGHT);
        return analyzeFrame(imageData.data);
      } catch (e) {
        if (e.name === 'SecurityError') {
          this.corsBlocked = true;
          this.onFlashDetected({
            element: this.element,
            corsBlocked: true,
            flashesPerSecond: 0,
            severity: 'unknown',
          });
          this.stop();
          return null;
        }
        if (e instanceof TypeError || e instanceof DOMException) {
          return null;
        }
        return null;
      }
    },

    /**
     * Analyze the sliding window for flash transitions.
     * Counts opposing luminance transitions that exceed the WCAG threshold.
     *
     * A "flash" = one bright→dark→bright (or dark→bright→dark) cycle.
     * This means 2 opposing transitions = 1 flash.
     * WCAG limit: 3 flashes/sec = 6 transitions/sec.
     *
     * @private
     * @returns {{ isFlashing: boolean, flashCount: number, isRedFlash: boolean, peakDelta: number, severity: string }}
     */
    _analyzeWindow: function () {
      var history = this.frameHistory;
      if (history.length < 3) {
        return { isFlashing: false, flashCount: 0, isRedFlash: false, peakDelta: 0, severity: 'safe' };
      }

      var directionChanges = 0;
      var redTransitions = 0;
      var peakDelta = 0;
      var lastDirection = 0; // +1 = getting brighter, -1 = getting darker

      for (var i = 1; i < history.length; i++) {
        var delta = history[i].luminance - history[i - 1].luminance;
        var absDelta = Math.abs(delta);
        var darkerLum = Math.min(history[i].luminance, history[i - 1].luminance);

        // Track peak delta
        if (absDelta > peakDelta) peakDelta = absDelta;

        // Check if this is a significant luminance change
        if (absDelta >= LUMINANCE_DELTA_THRESHOLD && darkerLum < DARK_STATE_THRESHOLD) {
          var direction = delta > 0 ? 1 : -1;

          // Count every significant direction change, including the first.
          // The first change starts a potential flash cycle; subsequent
          // opposing changes continue it. Two direction changes = one flash.
          if (lastDirection === 0 || direction !== lastDirection) {
            directionChanges++;
          }
          lastDirection = direction;

          // Check for red flash
          var avgRedRatio = (history[i].redRatio + history[i - 1].redRatio) / 2;
          if (avgRedRatio >= RED_RATIO_THRESHOLD) {
            redTransitions++;
          }
        }
      }

      // Each flash = 1 full cycle (bright→dark→bright) = 2 direction changes.
      // floor() is used because an incomplete cycle (single direction change)
      // does not constitute a full flash per WCAG 2.3.1.
      var flashCount = Math.floor(directionChanges / 2);
      var threshold = SENSITIVITY[this.sensitivity] || SENSITIVITY.medium;
      var isFlashing = flashCount >= threshold;
      var isRedFlash = redTransitions >= 1;

      // Severity classification
      var severity = 'safe';
      if (isFlashing) {
        if (flashCount >= 10 || isRedFlash) {
          severity = 'danger';
        } else if (flashCount >= threshold) {
          severity = 'warning';
        }
      }

      return {
        isFlashing: isFlashing,
        flashCount: flashCount,
        isRedFlash: isRedFlash,
        peakDelta: peakDelta,
        severity: severity,
      };
    },
  };

  // ─── CSS Animation Flash Detector ────────────────────────────────────

  /**
   * Detects rapid CSS animations that may cause flashing.
   * Monitors elements with animations/transitions that rapidly change
   * opacity, background-color, or visibility.
   *
   * @param {HTMLElement} element
   * @param {object} options — same as FlashDetector
   */
  function CSSFlashDetector(element, options) {
    this.element = element;
    this.sensitivity = options.sensitivity || 'medium';
    this.onFlashDetected = options.onFlashDetected || function () {};
    this.onSafe = options.onSafe || function () {};

    this.history = [];
    this.running = false;
    this.intervalId = null;
    this.isFlashing = false;
    this.destroyed = false;
    this.errorCount = 0;
    this.MAX_ERRORS = 50;
  }

  CSSFlashDetector.prototype = {
    start: function () {
      if (this.destroyed || this.running) return;
      this.running = true;

      var self = this;
      this.intervalId = setInterval(function () {
        self._sample();
      }, FRAME_INTERVAL_MS);
    },

    stop: function () {
      this.running = false;
      if (this.intervalId) {
        clearInterval(this.intervalId);
        this.intervalId = null;
      }
    },

    destroy: function () {
      this.stop();
      this.destroyed = true;
      this.history = [];
      this.element = null;
    },

    setSensitivity: function (level) {
      if (SENSITIVITY[level] !== undefined) {
        this.sensitivity = level;
      }
    },

    _sample: function () {
      if (!isExtensionContextValid()) { this.destroy(); return; }
      if (!this.running || this.destroyed || !this.element) return;

      var style;
      try {
        style = getComputedStyle(this.element);
      } catch (e) {
        this.destroy();
        return;
      }

      try {
        var bgColor = style.backgroundColor;
        var opacity = parseFloat(style.opacity);

        var rgb = this._parseColor(bgColor);
        var luminance = 0;
        if (rgb) {
          luminance = relativeLuminance(
            LINEAR_LUT[rgb.r],
            LINEAR_LUT[rgb.g],
            LINEAR_LUT[rgb.b]
          ) * opacity;
        }

        var now = performance.now();
        this.history.push({ timestamp: now, luminance: luminance });

        var cutoff = now - WINDOW_DURATION_MS;
        while (this.history.length > 0 && this.history[0].timestamp < cutoff) {
          this.history.shift();
        }

        var transitions = 0;
        var lastDir = 0;
        for (var i = 1; i < this.history.length; i++) {
          var delta = this.history[i].luminance - this.history[i - 1].luminance;
          var darkerLum = Math.min(this.history[i].luminance, this.history[i - 1].luminance);
          if (Math.abs(delta) >= LUMINANCE_DELTA_THRESHOLD && darkerLum < DARK_STATE_THRESHOLD) {
            var dir = delta > 0 ? 1 : -1;
            if (lastDir !== 0 && dir !== lastDir) transitions++;
            lastDir = dir;
          }
        }

        var flashCount = Math.ceil(transitions / 2);
        var threshold = SENSITIVITY[this.sensitivity] || SENSITIVITY.medium;
        var isFlashing = flashCount >= threshold;

        if (isFlashing && !this.isFlashing) {
          this.isFlashing = true;
          this.onFlashDetected({
            element: this.element,
            flashesPerSecond: flashCount,
            isRedFlash: false,
            severity: flashCount >= 10 ? 'danger' : 'warning',
            type: 'css-animation',
          });
        } else if (!isFlashing && this.isFlashing) {
          this.isFlashing = false;
          this.onSafe();
        }
      } catch (e) {
        console.warn('[NeuroShield] _sample error:', e);
        this.errorCount++;
        if (this.errorCount > this.MAX_ERRORS) { this.destroy(); }
      }
    },

    _parseColor: function (color) {
      if (!color || color === 'transparent') return null;
      var match = color.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
      if (match) {
        return {
          r: parseInt(match[1], 10),
          g: parseInt(match[2], 10),
          b: parseInt(match[3], 10),
        };
      }
      return null;
    },
  };

  // ─── Public API ──────────────────────────────────────────────────────

  return {
    FlashDetector: FlashDetector,
    CSSFlashDetector: CSSFlashDetector,
    SENSITIVITY: SENSITIVITY,
    // Expose for testing
    _analyzeFrame: analyzeFrame,
    _linearize: linearize,
    _relativeLuminance: relativeLuminance,
  };
})();
