/**
 * NeuroShield — content script controller (one per frame).
 *
 * Finds videos, canvases and short repeating animations, including inside
 * open and closed shadow roots, attaches a guard to each, keeps guards in
 * sync with settings, and reports this frame's state to the service worker.
 *
 * Runs at document_start. As soon as settings are read (a few milliseconds),
 * media events are caught in the capture phase and the existing DOM is
 * scanned, so a video that starts before the page finishes loading is covered.
 */
var NeuroShieldContent = (() => {
  'use strict';

  if (!(document instanceof HTMLDocument)) return null;

  // After an update, Chrome injects the new version into open tabs in the same
  // isolated world, next to the old (now disconnected) copy. The newest copy
  // always takes over; the old one pauses whatever it was hiding and steps aside.
  // A page hidden with "Hide everything" stays hidden through the handover.
  const previous = globalThis.NeuroShieldContent;
  const inheritedHidden = previous && previous.releaseHidden ? previous.releaseHidden() : null;
  if (previous && previous.retire) previous.retire();

  const Settings = NeuroShieldSettings;
  const { VideoGuard, CanvasGuard, AnimationGuard, isAnimationCandidate } = NeuroShieldGuards;
  const Overlay = NeuroShieldOverlay;

  const IS_TOP = window === window.top;
  const PAGE_ID = Math.random().toString(36).slice(2);
  const MEDIA_EVENTS = ['play', 'playing', 'loadeddata'];
  const ANIMATION_SWEEP_MS = 3000;
  /** Defined custom elements can attach a shadow root a little after they're connected. */
  const LATE_SHADOW_MS = 10000;
  const PENDING_LIMIT = 500;

  let settings = Settings.normalize(null);
  let active = false;
  let alive = true;
  let detections = 0;

  const mediaGuards = new Map(); // Element → VideoGuard | CanvasGuard
  const animationGuards = new Map(); // Element → AnimationGuard

  function contextValid() {
    try {
      return !!(chrome.runtime && chrome.runtime.id);
    } catch (_) {
      return false;
    }
  }

  function send(message) {
    if (!contextValid()) return;
    try {
      const pending = chrome.runtime.sendMessage(message);
      if (pending && pending.catch) pending.catch(() => {});
    } catch (_) {
      // Service worker unavailable; the next report carries the state.
    }
  }

  /** Hostname of the top-level page, also from inside cross-origin frames. */
  function topHostname() {
    if (IS_TOP) return location.hostname;
    const origins = location.ancestorOrigins;
    if (origins && origins.length) {
      try {
        return new URL(origins[origins.length - 1]).hostname;
      } catch (_) {
        // opaque origin
      }
    }
    return location.hostname;
  }
  const TOP_HOST = topHostname();

  // ─── Guards ──────────────────────────────────────────────────────────

  /** Elements near the viewport (one screen of margin), from a shared IntersectionObserver. */
  const near = new WeakMap();
  const nearObserver = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      near.set(entry.target, entry.isIntersecting);
      // Animations wait off screen without being judged; resume watching now.
      if (entry.isIntersecting && animationGuards.has(entry.target)) animationGuards.get(entry.target).wake();
    }
  }, { rootMargin: '100% 0px' });

  const ctx = {
    settings: () => settings,
    isNear: (el) => near.get(el) !== false,
    onDetection(guard, result) {
      detections++;
      send({ type: 'detection', kind: guard.kind, severity: result.severity });
    },
    onChange: () => scheduleReport(),
  };

  function guardMedia(el) {
    if (mediaGuards.has(el)) return mediaGuards.get(el);
    const guard = el instanceof HTMLVideoElement ? new VideoGuard(el, ctx) : new CanvasGuard(el, ctx);
    mediaGuards.set(el, guard);
    nearObserver.observe(el);
    if (active) guard.activate();
    scheduleReport();
    return guard;
  }

  function guardAnimation(anim) {
    if (!isAnimationCandidate(anim)) return;
    const el = anim.effect.target;
    let guard = animationGuards.get(el);
    if (!guard) {
      guard = new AnimationGuard(el, ctx);
      animationGuards.set(el, guard);
      nearObserver.observe(el);
      if (active) guard.activate();
    }
    guard.track(anim);
  }

  function disposeGuard(map, el) {
    const guard = map.get(el);
    if (!guard) return;
    guard.dispose();
    map.delete(el);
    nearObserver.unobserve(el);
  }

  /** Drop guards whose element left the document. */
  function sweepDetached() {
    for (const el of [...mediaGuards.keys()]) if (!el.isConnected) disposeGuard(mediaGuards, el);
    for (const el of [...animationGuards.keys()]) if (!el.isConnected) disposeGuard(animationGuards, el);
    scheduleReport();
  }

  function forEachGuard(fn) {
    for (const guard of mediaGuards.values()) fn(guard);
    for (const guard of animationGuards.values()) fn(guard);
  }

  // ─── Discovery ───────────────────────────────────────────────────────

  const discovery = {
    running: false,
    observer: null,
    roots: new Set(), // ShadowRoots we listen to
    known: new WeakSet(),
    queue: [],
    queued: false,
    pending: new Map(), // custom element without a shadow root → give-up time once defined
    pendingTimer: 0,
    sweepTimer: 0,
    detachTimer: 0,
    animationTimer: 0,
    animationScanAt: 0,
    animationScanCost: 0,

    onMedia: (e) => {
      const target = e.composedPath ? e.composedPath()[0] : e.target;
      if (target instanceof HTMLVideoElement) guardMedia(target);
    },

    // element.getAnimations() costs time in proportion to every animation on
    // the page, so calling it per event froze pages with thousands of them.
    // Events only schedule one shared scan (which also sees pseudo-elements).
    onAnimationStart: () => discovery.requestAnimationScan(),

    listen(root) {
      for (const type of MEDIA_EVENTS) root.addEventListener(type, this.onMedia, true);
      root.addEventListener('animationstart', this.onAnimationStart, true);
    },

    unlisten(root) {
      for (const type of MEDIA_EVENTS) root.removeEventListener(type, this.onMedia, true);
      root.removeEventListener('animationstart', this.onAnimationStart, true);
    },

    start() {
      if (this.running) return;
      this.running = true;
      this.listen(document);
      this.observer = new MutationObserver((records) => this.onMutations(records));
      this.observer.observe(document, { childList: true, subtree: true });
      this.sweepTimer = setInterval(() => this.requestAnimationScan(), ANIMATION_SWEEP_MS);
      if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => this.running && this.scan(document), { once: true });
      } else {
        this.scan(document);
      }
    },

    stop() {
      if (!this.running) return;
      this.running = false;
      this.unlisten(document);
      for (const root of this.roots) this.unlisten(root);
      this.roots.clear();
      this.known = new WeakSet();
      this.observer.disconnect();
      this.observer = null;
      this.queue = [];
      this.pending.clear();
      clearInterval(this.pendingTimer);
      clearInterval(this.sweepTimer);
      clearTimeout(this.detachTimer);
      clearTimeout(this.animationTimer);
      this.pendingTimer = 0;
      this.detachTimer = 0;
      this.animationTimer = 0;
    },

    onMutations(records) {
      let removed = false;
      for (const record of records) {
        for (const node of record.addedNodes) if (node.nodeType === 1) this.queue.push(node);
        if (record.removedNodes.length) removed = true;
      }
      if (this.queue.length && !this.queued) {
        this.queued = true;
        const run = () => this.drain();
        if (window.requestIdleCallback) requestIdleCallback(run, { timeout: 250 });
        else setTimeout(run, 50);
      }
      if (removed && !this.detachTimer) {
        this.detachTimer = setTimeout(() => {
          this.detachTimer = 0;
          sweepDetached();
          this.pruneRoots();
        }, 1000);
      }
    },

    drain() {
      this.queued = false;
      if (!this.running) return;
      const batch = this.queue;
      this.queue = [];
      for (const node of batch) if (node.isConnected) this.scan(node);
    },

    shadowRootOf(el) {
      if (el.shadowRoot) return el.shadowRoot;
      if (!el.localName.includes('-')) return null;
      try {
        return chrome.dom && chrome.dom.openOrClosedShadowRoot ? chrome.dom.openOrClosedShadowRoot(el) : null;
      } catch (_) {
        return null;
      }
    },

    /** Find media and shadow roots in a subtree (a node, a document or a shadow root). */
    scan(root) {
      if (root instanceof HTMLVideoElement || root instanceof HTMLCanvasElement) guardMedia(root);
      if (root.querySelectorAll) for (const el of root.querySelectorAll('video, canvas')) guardMedia(el);
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
      for (let node = root.nodeType === 1 ? root : walker.nextNode(); node; node = walker.nextNode()) {
        const shadow = this.shadowRootOf(node);
        if (shadow) this.adopt(shadow);
        else if (node.localName.includes('-')) this.addPending(node);
      }
    },

    /** Start watching a shadow root like the document itself. */
    adopt(shadow) {
      if (this.known.has(shadow)) return;
      this.known.add(shadow);
      this.roots.add(shadow);
      this.listen(shadow);
      this.observer.observe(shadow, { childList: true, subtree: true });
      this.scan(shadow);
    },

    pruneRoots() {
      for (const root of this.roots) {
        if (!root.host || !root.host.isConnected) {
          this.unlisten(root);
          this.roots.delete(root);
          // Adopt it again if the host comes back (e.g. a cached SPA view).
          this.known.delete(root);
        }
      }
    },

    /**
     * Custom elements get their shadow root later: when their definition
     * loads (which can be much later, for lazy-loaded components), or a
     * moment after they're connected. Check back until then.
     */
    addPending(el) {
      if (this.pending.has(el) || this.pending.size >= PENDING_LIMIT) return;
      this.pending.set(el, el.matches(':defined') ? performance.now() + LATE_SHADOW_MS : Infinity);
      if (!this.pendingTimer) this.pendingTimer = setInterval(() => this.checkPending(), 1000);
    },

    checkPending() {
      const now = performance.now();
      for (const [el, giveUpAt] of this.pending) {
        const shadow = el.isConnected ? this.shadowRootOf(el) : null;
        if (shadow) this.adopt(shadow);
        if (shadow || !el.isConnected) {
          this.pending.delete(el);
        } else if (giveUpAt === Infinity) {
          if (el.matches(':defined')) this.pending.set(el, now + LATE_SHADOW_MS);
        } else if (now > giveUpAt) {
          this.pending.delete(el);
        }
      }
      if (!this.pending.size) {
        clearInterval(this.pendingTimer);
        this.pendingTimer = 0;
      }
    },

    /**
     * Look at every running animation once, soon. Scans are spaced so they
     * take at most ~10% of the main thread on pages with huge numbers of
     * animations, where a single scan can take tens of milliseconds.
     */
    requestAnimationScan() {
      if (this.animationTimer || !this.running) return;
      const wait = Math.max(50, this.animationScanAt + this.animationScanCost * 10 - performance.now());
      this.animationTimer = setTimeout(() => {
        this.animationTimer = 0;
        this.scanAnimations();
      }, wait);
    },

    /** Guard candidate animations, including Web Animations started from script (no event). */
    scanAnimations() {
      if (!this.running || document.hidden) return;
      const start = performance.now();
      try {
        for (const anim of document.getAnimations()) guardAnimation(anim);
        for (const root of this.roots) for (const anim of root.getAnimations()) guardAnimation(anim);
      } catch (_) {
        // getAnimations unavailable
      }
      this.animationScanAt = performance.now();
      this.animationScanCost = this.animationScanAt - start;
    },
  };

  // ─── Activation & settings ───────────────────────────────────────────

  function activate() {
    active = true;
    discovery.start();
    forEachGuard((g) => g.activate());
  }

  function deactivate() {
    active = false;
    discovery.stop();
    forEachGuard((g) => g.deactivate());
  }

  function applySettings(next) {
    if (!alive) return;
    const previous = settings;
    settings = next;
    const shouldRun = next.enabled && !Settings.isSiteDisabled(next, TOP_HOST);
    if (next.sensitivity !== previous.sensitivity) forEachGuard((g) => g.setSensitivity(next.sensitivity));
    if (shouldRun && !active) activate();
    else if (!shouldRun && active) deactivate();
    if (next.unscannable !== previous.unscannable) {
      for (const guard of mediaGuards.values()) if (guard.applyUnscannableMode) guard.applyUnscannableMode();
    }
    scheduleReport(true);
  }

  // ─── Reporting ───────────────────────────────────────────────────────

  let reportTimer = 0;

  function frameState() {
    const state = { videos: 0, canvases: 0, animations: 0, blocked: 0, unscannable: 0, detections };
    for (const guard of mediaGuards.values()) {
      if (!guard.active) continue;
      if (guard.state === 'unscannable') state.unscannable++;
      else if (guard.kind === 'video') state.videos++;
      else if (guard.eligible) state.canvases++;
      if (guard.state === 'blocked' || guard.state === 'dimmed') state.blocked++;
    }
    for (const guard of animationGuards.values()) {
      if (!guard.active) continue;
      if (guard.animations.size) state.animations++;
      if (guard.state === 'blocked') state.blocked++;
    }
    return state;
  }

  function report() {
    reportTimer = 0;
    const state = frameState();
    const empty = !state.videos && !state.canvases && !state.animations && !state.unscannable && !state.detections;
    // Sub-frames with nothing to say stay quiet (most are ads and trackers).
    if (!IS_TOP && empty && !report.sent) return;
    report.sent = true;
    send({
      type: 'frame-state',
      page: PAGE_ID,
      top: IS_TOP,
      host: IS_TOP ? TOP_HOST : undefined,
      active,
      siteDisabled: settings.enabled && Settings.isSiteDisabled(settings, TOP_HOST),
      hidden: IS_TOP ? !!hidden.layer : undefined,
      state,
    });
  }
  report.sent = false;

  function scheduleReport(soon) {
    if (reportTimer) {
      if (!soon) return;
      clearTimeout(reportTimer);
    }
    reportTimer = setTimeout(report, soon ? 0 : 300);
  }

  // ─── Hide everything on this page ────────────────────────────────────

  const hidden = { layer: null, videos: [], animations: [] };

  function allVideos() {
    const set = new Set(document.querySelectorAll('video'));
    for (const el of mediaGuards.keys()) if (el instanceof HTMLVideoElement) set.add(el);
    for (const root of discovery.roots) for (const v of root.querySelectorAll('video')) set.add(v);
    return set;
  }

  function hidePage() {
    if (hidden.layer || hidden.videos.length || hidden.animations.length) return;
    for (const video of allVideos()) {
      if (!video.paused) {
        video.pause();
        hidden.videos.push(video);
      }
    }
    try {
      const animations = [...document.getAnimations()];
      for (const root of discovery.roots) animations.push(...root.getAnimations());
      for (const anim of animations) {
        if (anim.playState === 'running') {
          anim.pause();
          hidden.animations.push(anim);
        }
      }
    } catch (_) {
      // getAnimations unavailable
    }
    if (IS_TOP) {
      hidden.layer = Overlay.pageShield({
        show: () => {
          if (contextValid()) send({ type: 'show-page' });
          else showPage();
        },
      });
      scheduleReport(true);
    }
  }

  function showPage() {
    if (hidden.layer) hidden.layer.remove();
    for (const video of hidden.videos) {
      const playing = video.play();
      if (playing && playing.catch) playing.catch(() => {});
    }
    for (const anim of hidden.animations) {
      try {
        anim.play();
      } catch (_) {
        // removed
      }
    }
    const wasCovered = !!hidden.layer;
    hidden.layer = null;
    hidden.videos = [];
    hidden.animations = [];
    if (IS_TOP && wasCovered) scheduleReport(true);
  }

  /**
   * Hand the "hidden page" state to a newer copy: the media this copy paused,
   * so the new copy can resume them on "Show page". Null when not hidden.
   */
  function releaseHidden() {
    if (!hidden.layer && !hidden.videos.length && !hidden.animations.length) return null;
    const handed = { videos: hidden.videos, animations: hidden.animations };
    hidden.videos = [];
    hidden.animations = [];
    return handed;
  }

  // ─── Lifecycle ───────────────────────────────────────────────────────

  let unsubscribe = () => {};

  function onMessage(message, _sender, sendResponse) {
    if (!message || !alive) return;
    if (message.type === 'hide-page') hidePage();
    else if (message.type === 'show-page') showPage();
    else if (message.type === 'ping' && IS_TOP) sendResponse({ page: PAGE_ID });
  }

  /**
   * The extension was updated, reloaded or removed, or a newer copy took
   * over: undo everything. Hidden videos are paused first, so nothing that
   * was flashing plays unhidden while a newer copy starts up.
   */
  function teardown() {
    if (!alive) return;
    alive = false;
    clearInterval(lifeTimer);
    clearTimeout(reportTimer);
    discovery.stop();
    forEachGuard((g) => g.retire());
    mediaGuards.clear();
    animationGuards.clear();
    nearObserver.disconnect();
    if (hidden.layer) hidden.layer.remove();
    Overlay.removeAll();
    document.removeEventListener('neuroshield:takeover', onTakeover);
    try {
      unsubscribe();
      chrome.runtime.onMessage.removeListener(onMessage);
    } catch (_) {
      // context already gone
    }
  }

  // A newer copy of the content script announces itself; orphaned copies from
  // a previous version step aside at once instead of at the next check.
  function onTakeover() {
    if (!contextValid()) teardown();
  }

  const lifeTimer = setInterval(() => {
    if (!contextValid()) teardown();
  }, 5000);

  document.addEventListener('neuroshield:takeover', onTakeover);
  document.dispatchEvent(new CustomEvent('neuroshield:takeover'));

  // Back/forward cache: the page comes back with its old state, re-announce it.
  window.addEventListener('pageshow', (e) => {
    if (e.persisted && alive) scheduleReport(true);
  });
  // A prerendered page reports only once it is actually shown (the service
  // worker ignores reports from prerendering documents).
  document.addEventListener('prerenderingchange', () => alive && scheduleReport(true));
  // A frame going away takes its counts with it.
  window.addEventListener('pagehide', (e) => {
    if (alive && !IS_TOP && report.sent && !e.persisted) send({ type: 'frame-gone' });
  });
  document.addEventListener('visibilitychange', () => {
    if (alive && !document.hidden) for (const guard of animationGuards.values()) guard.wake();
  });

  try {
    chrome.runtime.onMessage.addListener(onMessage);
    unsubscribe = Settings.onChange(applySettings);
  } catch (_) {
    teardown();
  }
  Settings.load().then(applySettings);
  if (inheritedHidden) {
    hidePage();
    hidden.videos.push(...inheritedHidden.videos);
    hidden.animations.push(...inheritedHidden.animations);
  }
  if (IS_TOP) scheduleReport(true);

  return Object.freeze({
    get active() {
      return active;
    },
    frameState,
    releaseHidden,
    retire: teardown,
  });
})();
