/**
 * NeuroShield — guards: one controller per protected element.
 *
 *   VideoGuard      analyzes every presented frame (requestVideoFrameCallback),
 *                   so even a 30 Hz strobe can't hide between samples. Costs
 *                   nothing while the video is paused.
 *   CanvasGuard     reads visible, large canvases through captureStream(),
 *                   which delivers every frame they present and none while
 *                   they're still.
 *   AnimationGuard  watches short, repeating CSS/Web Animations that change
 *                   color or opacity for two cycles, then either pauses them
 *                   or stops watching (they repeat, so two cycles tell all).
 *
 * States: watching → blocked → dimmed | revealed (re-armed after 10 s) → watching.
 * A video's new source always starts over in "watching". Videos that can't be
 * read (cross-origin, DRM) are "unscannable".
 */
var NeuroShieldGuards = (() => {
  'use strict';

  const { FlashAnalyzer, analyzeFrame, parseColor, luminanceOf, linearize, WINDOW_MS, WCAG_AREA } = NeuroShieldDetector;
  const Sampler = NeuroShieldSampler;
  const Overlay = NeuroShieldOverlay;

  /**
   * Inline filters applied to protected elements.
   * dimmed: measured in Chrome, black ↔ white through this filter swings 0.088
   * in relative luminance (under WCAG's 0.1) and pure red is no longer a
   * saturated red. contrast() must come first; filters apply in order in sRGB.
   */
  const FILTERS = Object.freeze({
    hidden: 'brightness(0)',
    transparent: 'opacity(0)',
    dimmed: 'contrast(0.3) brightness(0.6) saturate(0.5)',
  });

  /** After "Show anyway", start watching again after this long. */
  const REARM_DELAY_MS = 10000;
  /**
   * WCAG's small safe area: 25% of a 10° visual field, about 341 × 256 CSS px
   * at typical viewing distance. Anything smaller on screen can't flash over
   * the threshold, so it isn't analyzed.
   */
  const MIN_AREA = WCAG_AREA;
  /** Videos smaller than this don't get the "can't scan" chip. */
  const NOTICE_MIN_AREA = 200 * 112;
  const NOTICE_AUTO_HIDE_MS = 8000;
  const MAX_ERRORS = 30;
  /** Extra samples scheduled per callback when the page renders slower than the video. */
  const MAX_CATCH_UP_SAMPLES = 3;

  function area(el) {
    const r = el.getBoundingClientRect();
    return r.width * r.height;
  }

  /**
   * How much larger than a CSS pixel things look on screen: browser zoom
   * (estimated in the top frame, never below 1) times pinch zoom. Errs large,
   * which only makes small content count as bigger.
   */
  let zoomCache = { at: -Infinity, value: 1 };
  function zoomFactor() {
    const now = performance.now();
    if (now - zoomCache.at < 1000) return zoomCache.value;
    let zoom = 1;
    try {
      if (window === window.top && window.innerWidth > 0) zoom = Math.max(1, window.outerWidth / window.innerWidth);
      if (window.visualViewport && window.visualViewport.scale > 1) zoom *= window.visualViewport.scale;
    } catch (_) {
      zoom = 1;
    }
    zoomCache = { at: now, value: zoom };
    return zoom;
  }

  /** On-screen area of an element (or its pseudo-element), in CSS px² at 100% zoom. */
  function displayArea(el, pseudo) {
    let a = area(el);
    if (pseudo) {
      const style = getComputedStyle(el, pseudo);
      const w = parseFloat(style.width);
      const h = parseFloat(style.height);
      if (w > 0 && h > 0) a = Math.max(a, w * h);
    }
    const z = zoomFactor();
    return a * z * z;
  }

  function inPictureInPicture(video) {
    try {
      return video.matches(':picture-in-picture');
    } catch (_) {
      return false;
    }
  }

  // ─── Inline style lock ───────────────────────────────────────────────

  /**
   * Applies an !important inline filter to an element and keeps it applied
   * (pages that rewrite the style attribute get it back), then restores the
   * element's own values on release.
   */
  class StyleLock {
    constructor(element) {
      this.element = element;
      this.mode = null;
      this.background = null;
      this.touchedBackground = false;
      this.saved = null;
      this.written = '';
      this.observer = null;
    }

    /**
     * @param {string} mode a key of FILTERS
     * @param {string} [background] an opaque background to lock too, so a
     *   transparent element's see-through parts are filtered with the rest
     */
    apply(mode, background) {
      const style = this.element.style;
      if (!style) return;
      if (!this.saved) {
        this.saved = ['filter', 'transition', 'background-color'].map((p) => [p, style.getPropertyValue(p), style.getPropertyPriority(p)]);
      }
      this.mode = mode;
      const hadBackground = !!this.background;
      this.background = background || null;
      if (hadBackground && !this.background) this.restoreProperty('background-color');
      this.write();
      this.element.setAttribute('data-neuroshield', mode);
      if (!this.observer) {
        this.observer = new MutationObserver(() => {
          if (!this.mode) return;
          const style = this.element.style;
          if (style.getPropertyValue('filter') !== this.written
            || (this.background && style.getPropertyPriority('background-color') !== 'important')) this.write();
        });
        this.observer.observe(this.element, { attributes: true, attributeFilter: ['style'] });
      }
    }

    write() {
      const style = this.element.style;
      style.setProperty('filter', FILTERS[this.mode], 'important');
      style.setProperty('transition', 'none', 'important');
      if (this.background) {
        style.setProperty('background-color', this.background, 'important');
        this.touchedBackground = true;
      }
      this.written = style.getPropertyValue('filter');
    }

    restoreProperty(prop) {
      const saved = this.saved && this.saved.find(([p]) => p === prop);
      const style = this.element.style;
      if (saved && saved[1]) style.setProperty(prop, saved[1], saved[2]);
      else style.removeProperty(prop);
    }

    release() {
      if (this.observer) this.observer.disconnect();
      this.observer = null;
      if (this.saved) {
        const style = this.element.style;
        for (const [prop, value, priority] of this.saved) {
          if (prop === 'background-color' && !this.touchedBackground) continue;
          if (value) style.setProperty(prop, value, priority);
          else style.removeProperty(prop);
        }
      }
      this.touchedBackground = false;
      if (this.mode) this.element.removeAttribute('data-neuroshield');
      this.saved = null;
      this.mode = null;
      this.background = null;
    }
  }

  // ─── Base guard ──────────────────────────────────────────────────────

  class Guard {
    /**
     * @param {Element} element
     * @param {object} ctx controller hooks: settings(), isNear(el), onDetection(guard, result), onChange()
     * @param {string} kind 'video' | 'canvas' | 'animation'
     */
    constructor(element, ctx, kind) {
      this.element = element;
      this.ctx = ctx;
      this.kind = kind;
      this.state = 'off';
      this.active = false;
      this.analyzer = new FlashAnalyzer(ctx.settings().sensitivity);
      this.lock = new StyleLock(element);
      this.layer = null;
      this.rearmTimer = 0;
      this.errors = 0;
    }

    activate() {
      if (this.active) return;
      this.active = true;
      this.state = 'watching';
      this.analyzer.reset();
      this.start();
    }

    /**
     * Stop protecting (protection turned off, element removed, or teardown).
     * Paused media stays paused: resuming here could replay flashing content
     * nobody chose to see.
     */
    deactivate() {
      if (!this.active) return;
      this.active = false;
      this.stop();
      this.clearUi();
      this.lock.release();
      this.forget();
      this.state = 'off';
    }

    dispose() {
      this.deactivate();
    }

    /** Dispose, making sure hidden media can't play unhidden afterwards. */
    retire() {
      if (this.state === 'blocked' && this.element instanceof HTMLMediaElement && !this.element.paused) {
        this.element.pause();
      }
      this.dispose();
    }

    setSensitivity(level) {
      this.analyzer.setSensitivity(level);
    }

    clearUi() {
      if (this.layer) this.layer.remove();
      this.layer = null;
      clearTimeout(this.rearmTimer);
      this.rearmTimer = 0;
    }

    /** Run one detection result through the state machine. */
    consider(result) {
      if (result.isFlashing && this.state === 'watching') this.block(result);
    }

    block(result) {
      const settings = this.ctx.settings();
      this.state = 'blocked';
      this.analyzer.reset();
      this.halt();
      const paused = this.protect(settings);
      this.layer = Overlay.block(this.element, {
        kind: this.kind,
        flashesPerSecond: result.flashesPerSecond,
        isRedFlash: result.isRedFlash,
        paused,
        sensitivity: settings.sensitivity,
      }, {
        dimmed: () => this.reveal('dimmed'),
        anyway: () => this.reveal('anyway'),
      });
      this.ctx.onDetection(this, result);
      this.ctx.onChange();
    }

    reveal(mode) {
      if (!this.active || (this.state !== 'blocked' && this.state !== 'dimmed')) return;
      this.clearUi();
      if (mode === 'dimmed') {
        this.state = 'dimmed';
        this.lock.apply('dimmed', this.dimBackground());
        this.layer = Overlay.dimmedChip(this.element, { restore: () => this.reveal('anyway') });
      } else {
        this.state = 'revealed';
        this.lock.release();
        this.rearmTimer = setTimeout(() => this.rearm(), REARM_DELAY_MS);
      }
      this.restore();
      this.ctx.onChange();
    }

    rearm() {
      this.rearmTimer = 0;
      if (!this.active || this.state !== 'revealed') return;
      this.state = 'watching';
      this.analyzer.reset();
      this.resume();
      this.ctx.onChange();
    }

    noteError(e) {
      this.errors++;
      if (this.errors === 1) console.debug('[NeuroShield]', e);
      if (this.errors > MAX_ERRORS) this.deactivate();
    }

    // Subclass hooks.
    /** Opaque background to put behind the element while dimmed, if it can be see-through. */
    dimBackground() {
      return null;
    }
    start() {}
    stop() {}
    /** Stop sampling (blocked). */
    halt() {}
    /** Start sampling again (re-armed). */
    resume() {}
    /** Hide the element. Returns true when it also paused playback. */
    protect() {
      this.lock.apply('hidden');
      return false;
    }
    /** Undo what protect() did besides the style lock. */
    restore() {}
    /** Drop protect()'s bookkeeping without undoing it. */
    forget() {}
  }

  // ─── Video ───────────────────────────────────────────────────────────

  class VideoGuard extends Guard {
    constructor(video, ctx) {
      super(video, ctx, 'video');
      this.reader = null;
      this.request = 0;
      this.pausedByUs = false;
      this.unscannable = '';
      this.noticeDismissed = false;
      this.noticeTimer = 0;
      this.lastFrame = null;
      this.catchUp = [];
      this.sizeCheck = 0;
      this.displayArea = 0;
      this.onPlay = () => this.schedule();
      // CSS filters don't reach the picture-in-picture window: a hidden or
      // dimmed video must not play unfiltered there (Chrome can open it
      // automatically when the tab is switched).
      this.onEnterPip = () => {
        if (this.lock.mode) document.exitPictureInPicture().catch(() => {});
      };
      // A paused video doesn't need its full-resolution GPU texture.
      this.onStop = () => {
        this.dropReader();
        this.lastFrame = null;
      };
      this.onNewSource = () => this.newSource();
      this.onVideoFrame = (now, meta) => this.frame(now, meta);
      this.sink = (pixels, timestamp, linear) => this.analyze(pixels, timestamp, linear);
    }

    start() {
      const v = this.element;
      v.addEventListener('play', this.onPlay);
      v.addEventListener('playing', this.onPlay);
      v.addEventListener('seeked', this.onPlay);
      v.addEventListener('pause', this.onStop);
      v.addEventListener('ended', this.onStop);
      v.addEventListener('loadstart', this.onNewSource);
      v.addEventListener('emptied', this.onNewSource);
      v.addEventListener('enterpictureinpicture', this.onEnterPip);
      this.schedule();
    }

    stop() {
      const v = this.element;
      v.removeEventListener('play', this.onPlay);
      v.removeEventListener('playing', this.onPlay);
      v.removeEventListener('seeked', this.onPlay);
      v.removeEventListener('pause', this.onStop);
      v.removeEventListener('ended', this.onStop);
      v.removeEventListener('loadstart', this.onNewSource);
      v.removeEventListener('emptied', this.onNewSource);
      v.removeEventListener('enterpictureinpicture', this.onEnterPip);
      this.halt();
      this.dropReader();
      clearTimeout(this.noticeTimer);
    }

    halt() {
      if (this.request) this.element.cancelVideoFrameCallback(this.request);
      this.request = 0;
      for (const timer of this.catchUp) clearTimeout(timer);
      this.catchUp = [];
      this.lastFrame = null;
    }

    resume() {
      this.schedule();
    }

    schedule() {
      if (!this.active || this.request || this.state !== 'watching') return;
      this.request = this.element.requestVideoFrameCallback(this.onVideoFrame);
    }

    dropReader() {
      if (this.reader) this.reader.dispose();
      this.reader = null;
    }

    frame(_now, meta) {
      this.request = 0;
      if (!this.active || this.state !== 'watching') return;
      this.schedule();
      const v = this.element;
      try {
        if (v.mediaKeys) {
          this.markUnscannable('protected');
          return;
        }
        const pip = inPictureInPicture(v);
        if (!this.ctx.isNear(v) && !pip) return;
        const { width, height } = Sampler.sourceSize(v);
        if (!width || !height) return;
        // Too small on screen to flash over the WCAG area (thumbnails, previews):
        // nothing to analyze. Re-measured every 15 frames.
        if (this.sizeCheck-- <= 0) {
          this.sizeCheck = 15;
          this.displayArea = pip ? 0 : displayArea(v);
          this.analyzer.setArea(this.displayArea);
        }
        if (!pip && this.displayArea < MIN_AREA) return;
        // performance.now(), not the frame's `now`: catch-up samples taken by
        // timers must sort correctly against callback samples.
        this.capture(performance.now());
        this.catchUpIfBehind(meta);
      } catch (e) {
        this.fail(e);
      }
    }

    capture(timestamp) {
      if (!this.reader || this.reader.broken) {
        this.dropReader();
        this.reader = Sampler.createReader();
      }
      this.reader.capture(this.element, timestamp, this.sink);
    }

    fail(e) {
      if (Sampler.isSecurityError(e)) this.markUnscannable('cross-origin');
      else this.noteError(e);
    }

    /**
     * When the page renders slower than the video (a busy page, two videos,
     * Chrome's Energy Saver), callbacks skip frames the screen still shows,
     * and can lock onto every other frame: a strobe that alternates each
     * frame then looks steady. Sample again between callbacks to break that.
     */
    catchUpIfBehind(meta) {
      const last = this.lastFrame;
      this.lastFrame = meta ? { presented: meta.presentedFrames, mediaTime: meta.mediaTime } : null;
      if (!last || !meta) return;
      const skipped = meta.presentedFrames - last.presented - 1;
      if (skipped < 1) return;
      const rate = Math.abs(this.element.playbackRate) || 1;
      const frameMs = ((meta.mediaTime - last.mediaTime) / (skipped + 1) / rate) * 1000;
      if (!(frameMs > 4 && frameMs < 100)) return;
      for (let k = 1; k <= Math.min(skipped, MAX_CATCH_UP_SAMPLES); k++) {
        const timer = setTimeout(() => {
          this.catchUp = this.catchUp.filter((t) => t !== timer);
          if (!this.active || this.state !== 'watching') return;
          try {
            this.capture(performance.now());
          } catch (e) {
            this.fail(e);
          }
        }, frameMs * k);
        this.catchUp.push(timer);
      }
    }

    analyze(pixels, timestamp, linear) {
      if (this.state !== 'watching') return;
      const sample = analyzeFrame(pixels, linear);
      sample.timestamp = timestamp;
      this.consider(this.analyzer.push(sample));
    }

    protect(settings) {
      const v = this.element;
      this.lock.apply('hidden');
      if (inPictureInPicture(v)) document.exitPictureInPicture().catch(() => {});
      if (settings.pauseOnDetect && !v.paused) {
        v.pause();
        this.pausedByUs = true;
      }
      return this.pausedByUs;
    }

    restore() {
      if (!this.pausedByUs) return;
      this.pausedByUs = false;
      const playing = this.element.play();
      if (playing && playing.catch) playing.catch(() => {});
    }

    forget() {
      this.pausedByUs = false;
    }

    /** A new source (or YouTube's next video in the same element) starts over. */
    newSource() {
      if (!this.active) return;
      this.halt();
      this.clearUi();
      clearTimeout(this.noticeTimer);
      this.lock.release();
      this.pausedByUs = false;
      this.dropReader();
      this.analyzer.reset();
      this.sizeCheck = 0;
      this.unscannable = '';
      this.noticeDismissed = false;
      this.errors = 0;
      this.state = 'watching';
      this.schedule();
      this.ctx.onChange();
    }

    markUnscannable(reason) {
      if (this.state === 'unscannable') return;
      this.state = 'unscannable';
      this.unscannable = reason;
      this.halt();
      this.dropReader();
      this.applyUnscannableMode();
      this.ctx.onChange();
    }

    /** Show the notice, dim, or do nothing, per the "unscannable" setting. */
    applyUnscannableMode() {
      if (this.state !== 'unscannable') return;
      this.clearUi();
      clearTimeout(this.noticeTimer);
      const mode = this.ctx.settings().unscannable;
      const restore = () => {
        this.clearUi();
        this.lock.release();
        this.noticeDismissed = true;
      };
      if (mode === 'dim' && !this.noticeDismissed) {
        this.lock.apply('dimmed');
        this.layer = Overlay.dimmedChip(this.element, { restore });
        return;
      }
      this.lock.release();
      if (mode !== 'notice' || this.noticeDismissed || area(this.element) < NOTICE_MIN_AREA) return;
      this.layer = Overlay.noticeChip(this.element, this.unscannable, {
        dim: () => {
          this.clearUi();
          clearTimeout(this.noticeTimer);
          this.lock.apply('dimmed');
          this.layer = Overlay.dimmedChip(this.element, { restore });
        },
        dismiss: () => {
          this.clearUi();
          this.noticeDismissed = true;
        },
      });
      this.noticeTimer = setTimeout(() => {
        if (this.layer && this.lock.mode === null) this.clearUi();
      }, NOTICE_AUTO_HIDE_MS);
    }
  }

  // ─── Canvas ──────────────────────────────────────────────────────────

  /**
   * What a (partly) transparent canvas looks like over `backdrop`: transparent
   * pixels show the page behind, not black. WebGL samples are linear and
   * premultiplied; 2D samples are sRGB and straight.
   */
  function compositeOver(pixels, linear, backdrop, out) {
    const b = linear
      ? [linearize(backdrop.r), linearize(backdrop.g), linearize(backdrop.b)].map((v) => v * 255)
      : [backdrop.r, backdrop.g, backdrop.b];
    for (let i = 0; i < pixels.length; i += 4) {
      const a = pixels[i + 3] / 255;
      for (let c = 0; c < 3; c++) {
        const value = linear ? pixels[i + c] + (1 - a) * b[c] : pixels[i + c] * a + (1 - a) * b[c];
        out[i + c] = value > 255 ? 255 : value;
      }
      out[i + 3] = 255;
    }
    return out;
  }

  /**
   * Canvases are read through canvas.captureStream(): the stream delivers
   * exactly the frames the canvas presents, including WebGL canvases whose
   * drawing buffer reads back empty between frames, and nothing at all while
   * the canvas is still. Only visible canvases of a meaningful size are read.
   */
  class CanvasGuard extends Guard {
    constructor(canvas, ctx) {
      super(canvas, ctx, 'canvas');
      this.reader = null;
      this.track = null;
      this.frames = null;
      this.timer = 0;
      this.eligible = false;
      this.unscannable = '';
      this.lastFrameAt = 0;
      this.probedAt = 0;
      this.backdrop = null;
      this.backdropAt = -Infinity;
      this.composited = new Uint8Array(Sampler.SIZE * Sampler.SIZE * 4);
      this.sink = (pixels, timestamp, linear) => this.analyze(pixels, timestamp, linear);
    }

    start() {
      this.check();
    }

    stop() {
      clearTimeout(this.timer);
      this.timer = 0;
      this.detach();
      if (this.reader) this.reader.dispose();
      this.reader = null;
    }

    halt() {
      clearTimeout(this.timer);
      this.timer = 0;
      this.detach();
    }

    resume() {
      this.check();
    }

    /** Attach to visible, large canvases; let go of the rest. Re-checked every second. */
    check() {
      this.timer = 0;
      if (!this.active || this.state !== 'watching') return;
      const c = this.element;
      const onScreen = c.isConnected && !document.hidden && this.ctx.isNear(c) && c.width > 0 && c.height > 0;
      const size = onScreen ? displayArea(c) : 0;
      this.analyzer.setArea(size);
      this.eligible = onScreen && size >= MIN_AREA;
      if (this.eligible && !this.frames) this.attach();
      else if (!this.eligible && this.frames) this.detach();
      else if (this.frames) this.probeTaint();
      if (this.state === 'watching') this.timer = setTimeout(() => this.check(), 1000);
    }

    /**
     * Once a canvas draws cross-origin content, its stream silently stops.
     * After a few quiet seconds, ask for a new stream: that throws for a
     * tainted canvas, so it can be reported as unscannable.
     */
    probeTaint() {
      const now = performance.now();
      if (now - this.lastFrameAt < 3000 || now - this.probedAt < 10000) return;
      this.probedAt = now;
      try {
        for (const track of this.element.captureStream().getTracks()) track.stop();
      } catch (e) {
        if (Sampler.isSecurityError(e)) this.markUnscannable();
      }
    }

    attach() {
      let track;
      try {
        track = this.element.captureStream().getVideoTracks()[0];
      } catch (e) {
        // Tainted by cross-origin drawing: nothing can be read from it.
        if (Sampler.isSecurityError(e)) this.markUnscannable();
        else this.noteError(e);
        return;
      }
      if (!track) return;
      this.track = track;
      this.lastFrameAt = performance.now();
      this.frames = new MediaStreamTrackProcessor({ track }).readable.getReader();
      this.pump(this.frames);
    }

    detach() {
      if (this.frames) this.frames.cancel().catch(() => {});
      if (this.track) this.track.stop();
      this.frames = null;
      this.track = null;
    }

    async pump(frames) {
      while (this.frames === frames) {
        let next;
        try {
          next = await frames.read();
        } catch (_) {
          return;
        }
        if (next.done) return;
        const frame = next.value;
        this.lastFrameAt = performance.now();
        try {
          if (this.frames === frames && this.state === 'watching') {
            if (!this.reader || this.reader.broken) {
              if (this.reader) this.reader.dispose();
              this.reader = Sampler.createReader();
            }
            this.reader.capture(frame, performance.now(), this.sink);
          }
        } catch (e) {
          if (Sampler.isSecurityError(e)) this.markUnscannable();
          else this.noteError(e);
        } finally {
          frame.close();
        }
      }
    }

    markUnscannable() {
      this.unscannable = 'cross-origin';
      this.state = 'unscannable';
      this.halt();
      this.ctx.onChange();
    }

    analyze(pixels, timestamp, linear) {
      if (this.state !== 'watching') return;
      if (timestamp - this.backdropAt > 2000) {
        this.backdrop = backdropColor(this.element);
        this.backdropAt = timestamp;
      }
      const sample = analyzeFrame(compositeOver(pixels, linear, this.backdrop, this.composited), linear);
      sample.timestamp = timestamp;
      this.consider(this.analyzer.push(sample));
    }

    protect() {
      // Transparent canvases would still show flashing shapes as black, so hide it entirely.
      this.lock.apply('transparent');
      return false;
    }

    dimBackground() {
      // Dimming filters the canvas's own pixels; its see-through parts would
      // still show the page at full contrast. Put the page color behind it.
      const b = backdropColor(this.element);
      return `rgb(${b.r}, ${b.g}, ${b.b})`;
    }
  }

  // ─── CSS / Web Animations ────────────────────────────────────────────

  const TRANSPARENT = Object.freeze({ r: 0, g: 0, b: 0, a: 0 });
  const BLACK = Object.freeze({ r: 0, g: 0, b: 0, a: 1 });
  const WHITE = Object.freeze({ r: 255, g: 255, b: 255, a: 1 });

  /** Animated color properties (keyframe names) → the computed-style property to read. */
  const COLOR_PROPERTIES = {
    color: 'color',
    fill: 'fill',
    stroke: 'stroke',
    borderColor: 'borderTopColor',
    borderTopColor: 'borderTopColor',
    borderRightColor: 'borderRightColor',
    borderBottomColor: 'borderBottomColor',
    borderLeftColor: 'borderLeftColor',
    outlineColor: 'outlineColor',
  };
  const BACKGROUND_PROPERTIES = new Set(['backgroundColor', 'background']);
  /** Animated properties whose effect on brightness can be measured from computed style. */
  const MEASURABLE = new Set(['opacity', 'visibility', 'filter', ...BACKGROUND_PROPERTIES, ...Object.keys(COLOR_PROPERTIES)]);

  /** Iteration duration in ms (wall clock), or 0 when unknown. */
  function iterationDuration(anim) {
    const d = anim.effect.getComputedTiming().duration;
    return typeof d === 'number' && Number.isFinite(d) ? d / Math.abs(anim.playbackRate || 1) : 0;
  }

  /** The measurable properties an animation changes. */
  function animatedProperties(anim) {
    const props = new Set();
    for (const frame of anim.effect.getKeyframes()) {
      for (const p of Object.keys(frame)) if (MEASURABLE.has(p)) props.add(p);
    }
    return props;
  }

  /**
   * What decides whether an animation is a candidate (and whether it was
   * judged safe): a page that speeds an animation up gets it checked again.
   */
  function timingKey(anim) {
    const t = anim.effect.getTiming();
    return `${anim.playState}|${t.duration}|${t.iterations}|${anim.playbackRate}`;
  }

  /**
   * Repeating animation that changes color, opacity, visibility or filters
   * quickly: a short cycle that repeats, or a long cycle with many steps (a
   * strobe written as one long keyframe list).
   */
  function judgeCandidate(anim) {
    const effect = anim.effect;
    if (!effect || !effect.target || anim.playState !== 'running') return false;
    const duration = iterationDuration(anim);
    if (!(duration > 0)) return false;
    const iterations = effect.getComputedTiming().iterations;
    const keyframes = effect.getKeyframes();
    if (!keyframes.some((frame) => Object.keys(frame).some((p) => MEASURABLE.has(p)))) return false;
    if (duration < 2000 && (iterations === Infinity || iterations >= 2)) return true;
    const steps = keyframes.length - 1;
    return steps * Math.min(iterations, 2) >= 4 && (steps * 1000) / duration >= 2;
  }

  /** Verdicts by animation, kept until its timing changes. Checking is cheap after the first time. */
  const candidates = new WeakMap();

  function isCandidate(anim) {
    try {
      if (!anim.effect) return false;
      const key = timingKey(anim);
      const known = candidates.get(anim);
      if (known && known.key === key) return known.value;
      const value = judgeCandidate(anim);
      candidates.set(anim, { key, value });
      return value;
    } catch (_) {
      return false;
    }
  }

  /** Apply the brightness() and invert() parts of a computed filter to a color. */
  function applyFilter(rgb, filter) {
    if (!filter || filter === 'none') return rgb;
    let { r, g, b } = rgb;
    const re = /(brightness|invert)\(\s*([\d.]+)(%?)\s*\)/g;
    let m;
    while ((m = re.exec(filter))) {
      const amount = parseFloat(m[2]) / (m[3] ? 100 : 1);
      if (m[1] === 'brightness') {
        r *= amount;
        g *= amount;
        b *= amount;
      } else {
        const k = Math.min(1, amount);
        r = r * (1 - k) + (255 - r) * k;
        g = g * (1 - k) + (255 - g) * k;
        b = b * (1 - k) + (255 - b) * k;
      }
    }
    const clamp = (v) => Math.max(0, Math.min(255, Math.round(v)));
    return { r: clamp(r), g: clamp(g), b: clamp(b), a: rgb.a };
  }

  /** Color behind an element: the first mostly-opaque ancestor background, else white. */
  function backdropColor(element) {
    const up = (node) => node.parentElement || (node.getRootNode && node.getRootNode().host) || null;
    let node = up(element);
    for (let depth = 0; node && depth < 40; depth++) {
      const bg = parseColor(getComputedStyle(node).backgroundColor);
      if (bg && bg.a >= 0.5) return { r: bg.r, g: bg.g, b: bg.b, a: 1 };
      node = up(node);
    }
    return WHITE;
  }

  /** Shared animation-frame loop for every animation guard that is sampling. */
  const animationLoop = {
    guards: new Set(),
    frame: 0,
    add(guard) {
      this.guards.add(guard);
      if (!this.frame) this.frame = requestAnimationFrame((now) => this.run(now));
    },
    delete(guard) {
      this.guards.delete(guard);
    },
    run(now) {
      this.frame = 0;
      for (const guard of [...this.guards]) guard.sample(now);
      if (this.guards.size) this.frame = requestAnimationFrame((t) => this.run(t));
    },
  };

  /** Animations watched for a full window, on screen, and found safe, with the timing they had then. */
  const cleared = new WeakMap();

  function isCleared(anim) {
    try {
      return cleared.get(anim) === timingKey(anim);
    } catch (_) {
      return false;
    }
  }

  /** How long to watch an animation: a full window, and every phase of its cycle. */
  function watchTime(anim) {
    const d = iterationDuration(anim);
    return Math.max(WINDOW_MS + 100, Math.min(2 * d, d + WINDOW_MS) + 100);
  }

  class AnimationGuard extends Guard {
    constructor(element, ctx) {
      super(element, ctx, 'animation');
      this.animations = new Set();
      this.props = new Set();
      this.pausedByUs = [];
      this.pseudo = null;
      this.watchFor = 0;
      this.observedSince = 0;
      this.backdrop = WHITE;
      this.backdropAt = -Infinity;
      this.checkIn = 0;
    }

    /** Watch `anim` (a candidate on this element) for long enough to judge it. */
    track(anim) {
      if (this.state === 'blocked') {
        // Restarted (or new) while the card says it's paused: pause it too.
        if (anim.playState === 'running') anim.pause();
        if (!this.pausedByUs.includes(anim)) this.pausedByUs.push(anim);
        this.animations.add(anim);
        return;
      }
      if (isCleared(anim)) return;
      if (!this.animations.has(anim)) {
        this.animations.add(anim);
        for (const p of animatedProperties(anim)) this.props.add(p);
        this.pseudo = anim.effect.pseudoElement || null;
        this.watchFor = Math.max(this.watchFor, watchTime(anim));
      }
      this.wake();
    }

    /** Start (or keep) sampling if there is something to watch. */
    wake() {
      if (this.active && this.state === 'watching' && this.animations.size) animationLoop.add(this);
    }

    /** Stop sampling for now, without judging the animations. */
    sleep() {
      animationLoop.delete(this);
      this.observedSince = 0;
      this.checkIn = 0;
    }

    start() {
      this.wake();
    }

    stop() {
      this.sleep();
    }

    halt() {
      this.sleep();
    }

    resume() {
      for (const anim of this.animations) cleared.delete(anim);
      this.observedSince = 0;
      this.wake();
    }

    /** Watched on screen for a full window without flashing: stop watching these. */
    finish() {
      for (const anim of this.animations) {
        try {
          cleared.set(anim, timingKey(anim));
        } catch (_) {
          // animation gone
        }
      }
      this.animations.clear();
      this.props.clear();
      this.watchFor = 0;
      this.sleep();
      this.ctx.onChange();
    }

    sample(now) {
      if (!this.active || this.state !== 'watching') {
        animationLoop.delete(this);
        return;
      }
      const el = this.element;
      for (const anim of this.animations) if (anim.playState !== 'running') this.animations.delete(anim);
      if (!this.animations.size || !el.isConnected) {
        this.sleep();
        this.ctx.onChange();
        return;
      }
      // Off screen, in a hidden tab or too small: wait without judging. The
      // content script wakes the guard when it comes into view.
      if (this.checkIn-- <= 0) {
        this.checkIn = 15;
        if (document.hidden || !this.ctx.isNear(el) || displayArea(el, this.pseudo) < MIN_AREA) {
          this.sleep();
          return;
        }
      }
      if (!this.observedSince) {
        this.observedSince = now;
        this.analyzer.reset();
      } else if (now - this.observedSince > this.watchFor) {
        this.finish();
        return;
      }
      try {
        this.consider(this.analyzer.push(this.measure(now)));
      } catch (e) {
        this.noteError(e);
      }
    }

    /** Approximate brightness of the element as composited over what's behind it. */
    measure(now) {
      const style = getComputedStyle(this.element, this.pseudo);
      if (now - this.backdropAt > 2000) {
        this.backdrop = backdropColor(this.element);
        this.backdropAt = now;
      }
      const backdrop = luminanceOf(this.backdrop);
      const background = parseColor(style.backgroundColor) || TRANSPARENT;
      const animatesBackground = [...BACKGROUND_PROPERTIES].some((p) => this.props.has(p));

      let content = background;
      if (background.a < 0.5 && !animatesBackground) {
        // A transparent box shows its content (images, text, children), which
        // computed style can't tell us. Use the animated color if there is
        // one; otherwise assume the content contrasts as much as possible
        // with what's behind it, so opacity and visibility blinks register.
        const prop = Object.keys(COLOR_PROPERTIES).find((p) => this.props.has(p));
        const color = prop ? parseColor(style[COLOR_PROPERTIES[prop]]) : null;
        if (color) content = color;
        else if (this.props.has('filter')) content = WHITE;
        else content = backdrop >= 0.5 ? BLACK : WHITE;
      }
      content = applyFilter(content, style.filter);

      let opacity = parseFloat(style.opacity);
      if (!Number.isFinite(opacity)) opacity = 1;
      const alpha = style.visibility === 'hidden' ? 0 : Math.min(1, content.a) * opacity;
      const sum = content.r + content.g + content.b;
      const red = linearize(content.r) - linearize(content.g) - linearize(content.b);
      return {
        timestamp: now,
        luminance: alpha * luminanceOf(content) + (1 - alpha) * backdrop,
        redRatio: alpha >= 0.5 && sum > 0 ? content.r / sum : 0,
        redLevel: alpha * Math.max(0, red),
      };
    }

    protect() {
      this.pausedByUs = [];
      for (const anim of this.element.getAnimations({ subtree: true })) {
        if (anim.playState === 'running' && isCandidate(anim)) {
          anim.pause();
          this.pausedByUs.push(anim);
        }
      }
      // A page can call play() again (no event fires): keep them paused.
      clearInterval(this.holdTimer);
      this.holdTimer = setInterval(() => {
        for (const anim of this.pausedByUs) {
          try {
            if (anim.playState === 'running') anim.pause();
          } catch (_) {
            // animation removed
          }
        }
      }, 200);
      return false;
    }

    restore() {
      clearInterval(this.holdTimer);
      this.holdTimer = 0;
      for (const anim of this.pausedByUs) {
        try {
          anim.play();
        } catch (_) {
          // animation removed
        }
      }
      this.pausedByUs = [];
    }

    forget() {
      clearInterval(this.holdTimer);
      this.holdTimer = 0;
      this.pausedByUs = [];
    }

    reveal() {
      // Animations only offer "Resume": no dimming, re-armed after the delay.
      super.reveal('anyway');
    }
  }

  return Object.freeze({
    VideoGuard,
    CanvasGuard,
    AnimationGuard,
    isAnimationCandidate: isCandidate,
    displayArea,
    FILTERS,
    MIN_AREA,
  });
})();
