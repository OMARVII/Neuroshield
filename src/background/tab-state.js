/**
 * NeuroShield — per-tab state kept by the service worker.
 *
 * Every frame of a tab reports its own counts; the tab state is the sum.
 * Pure functions on plain objects so the state can be stored in
 * chrome.storage.session and tested without a browser.
 */
var NeuroShieldTabs = (() => {
  'use strict';

  const COUNTS = Object.freeze(['videos', 'canvases', 'animations', 'blocked', 'unscannable', 'detections']);

  function createTab() {
    // goneDetections: flashes hidden in frames that have since gone away.
    return { page: '', host: '', active: true, siteDisabled: false, hidden: false, frames: {}, goneDetections: 0 };
  }

  function emptyCounts() {
    const counts = {};
    for (const key of COUNTS) counts[key] = 0;
    return counts;
  }

  /** Keep only known, non-negative integer counts. */
  function sanitize(state) {
    const counts = emptyCounts();
    for (const key of COUNTS) {
      const value = Number(state && state[key]);
      counts[key] = Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
    }
    return counts;
  }

  /**
   * Merge one frame's report. A report from the top frame with a new page id
   * means the tab navigated: everything from the previous page is dropped.
   * @returns {object} a new tab state
   */
  function applyFrameState(tab, frameId, message) {
    const next = Object.assign(createTab(), tab, { frames: Object.assign({}, tab && tab.frames) });
    if (message.top) {
      if (message.page !== next.page) {
        next.page = message.page;
        next.frames = {};
        next.hidden = false;
        next.goneDetections = 0;
      }
      next.host = typeof message.host === 'string' ? message.host : '';
      next.active = message.active !== false;
      next.siteDisabled = !!message.siteDisabled;
      // The page knows best whether it's covered (e.g. after back/forward cache or an update).
      if (typeof message.hidden === 'boolean') next.hidden = message.hidden;
    }
    next.frames[frameId] = sanitize(message.state);
    return next;
  }

  /** Count a detection right away; the frame's next report replaces the estimate. */
  function applyDetection(tab, frameId) {
    const next = Object.assign(createTab(), tab, { frames: Object.assign({}, tab && tab.frames) });
    const frame = Object.assign(emptyCounts(), next.frames[frameId]);
    frame.detections++;
    next.frames[frameId] = frame;
    return next;
  }

  /** Drop a frame that went away, keeping the flashes it hid in the page's total. */
  function removeFrame(tab, frameId) {
    const next = Object.assign(createTab(), tab, { frames: Object.assign({}, tab && tab.frames) });
    const frame = next.frames[frameId];
    if (frame) next.goneDetections = (next.goneDetections || 0) + (frame.detections || 0);
    delete next.frames[frameId];
    return next;
  }

  function summarize(tab) {
    const total = emptyCounts();
    if (!tab) return total;
    for (const frame of Object.values(tab.frames)) {
      for (const key of COUNTS) total[key] += frame[key] || 0;
    }
    total.detections += tab.goneDetections || 0;
    return total;
  }

  /** Toolbar badge: detections on this page, if any. */
  function badgeText(summary) {
    const n = summary.detections;
    if (!n) return '';
    return n > 99 ? '99+' : String(n);
  }

  return Object.freeze({ COUNTS, createTab, applyFrameState, applyDetection, removeFrame, summarize, badgeText });
})();
