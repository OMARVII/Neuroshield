/**
 * NeuroShield — settings shared by the content scripts, the service worker,
 * the popup and the options page.
 *
 * Settings live in chrome.storage.local (never synced). Every context reads
 * them through load() and reacts to chrome.storage.onChanged, so a change made
 * anywhere reaches every open tab and frame immediately.
 */
var NeuroShieldSettings = (() => {
  'use strict';

  const SENSITIVITY_LEVELS = Object.freeze(['low', 'medium', 'high', 'maximum']);
  const UNSCANNABLE_MODES = Object.freeze(['notice', 'dim', 'off']);

  const DEFAULTS = Object.freeze({
    enabled: true,
    sensitivity: 'medium',
    /** Pause a video when its flashing is hidden, so nothing plays unseen. */
    pauseOnDetect: true,
    /** What to do with videos that can't be analyzed (cross-origin, DRM). */
    unscannable: 'notice',
    /** Hostnames (without "www.") where protection is paused. */
    disabledSites: [],
  });

  const KEYS = Object.freeze(Object.keys(DEFAULTS));

  /** Coerce whatever is in storage into a valid settings object. */
  function normalize(raw) {
    const s = Object.assign({}, DEFAULTS, raw || {});
    return {
      enabled: s.enabled !== false,
      sensitivity: SENSITIVITY_LEVELS.includes(s.sensitivity) ? s.sensitivity : DEFAULTS.sensitivity,
      pauseOnDetect: s.pauseOnDetect !== false,
      unscannable: UNSCANNABLE_MODES.includes(s.unscannable) ? s.unscannable : DEFAULTS.unscannable,
      disabledSites: Array.isArray(s.disabledSites)
        ? [...new Set(s.disabledSites.map(siteKey).filter(Boolean))].sort()
        : [],
    };
  }

  /**
   * The key a site is stored under: lowercase ASCII hostname (international
   * names in punycode, as the browser reports them) without a leading
   * "www.". Accepts a hostname or a full URL. Returns '' when there is none.
   */
  function siteKey(input) {
    if (typeof input !== 'string') return '';
    const text = input.trim();
    if (!text) return '';
    let host;
    try {
      host = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : 'http://' + text).hostname;
    } catch (_) {
      return '';
    }
    host = host.toLowerCase().replace(/^www\./, '').replace(/\.$/, '');
    return /^[a-z0-9.-]+$/.test(host) || /^\[[0-9a-f:.]+\]$/.test(host) ? host : '';
  }

  /** True when `hostname` is a paused site or a subdomain of one. */
  function isSiteDisabled(settings, hostname) {
    const host = siteKey(hostname);
    if (!host) return false;
    return settings.disabledSites.some((site) => host === site || host.endsWith('.' + site));
  }

  function load() {
    return new Promise((resolve) => {
      try {
        chrome.storage.local.get(KEYS, (raw) => {
          if (chrome.runtime.lastError) return resolve(normalize(null));
          resolve(normalize(raw));
        });
      } catch (_) {
        resolve(normalize(null));
      }
    });
  }

  function save(patch) {
    const clean = {};
    const normalized = normalize(Object.assign({}, DEFAULTS, patch));
    for (const key of Object.keys(patch)) {
      if (KEYS.includes(key)) clean[key] = normalized[key];
    }
    return chrome.storage.local.set(clean);
  }

  /** Subscribe to settings changes. The callback receives the full, normalized settings. */
  function onChange(callback) {
    const listener = (changes, area) => {
      if (area !== 'local' || !KEYS.some((k) => k in changes)) return;
      load().then(callback);
    };
    chrome.storage.onChanged.addListener(listener);
    return () => chrome.storage.onChanged.removeListener(listener);
  }

  return Object.freeze({
    DEFAULTS,
    KEYS,
    SENSITIVITY_LEVELS,
    UNSCANNABLE_MODES,
    normalize,
    siteKey,
    isSiteDisabled,
    load,
    save,
    onChange,
  });
})();
