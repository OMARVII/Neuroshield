/**
 * NeuroShield — service worker.
 *
 * Owns the toolbar button (icon, badge, title), per-tab state for the popup,
 * lifetime stats, the "hide everything on this page" command, and putting
 * protection into tabs that were already open when NeuroShield was installed
 * or updated. Settings are not relayed through here: every context reads
 * chrome.storage directly and reacts to its changes.
 */
importScripts('../shared/settings.js', 'tab-state.js');

(() => {
  'use strict';

  const Settings = NeuroShieldSettings;
  const Tabs = NeuroShieldTabs;

  const ICONS = Object.freeze({
    on: { 16: '/icons/icon-16.png', 32: '/icons/icon-32.png' },
    off: { 16: '/icons/icon-off-16.png', 32: '/icons/icon-off-32.png' },
  });
  const BADGE_COLOR = '#b45309';
  const EXTENSION_ORIGIN = chrome.runtime.getURL('');
  const SCRIPTABLE = /^(https?|file):/;

  let settings = Settings.normalize(null);
  const settingsReady = Settings.load().then((s) => {
    settings = s;
    return s;
  });

  // ─── Toolbar ─────────────────────────────────────────────────────────

  function quiet(promise) {
    if (promise && promise.catch) promise.catch(() => {});
  }

  function refreshGlobalAction() {
    quiet(chrome.action.setIcon({ path: settings.enabled ? ICONS.on : ICONS.off }));
    // Neutral when on: tabs where NeuroShield runs get their own title once they report.
    quiet(chrome.action.setTitle({ title: settings.enabled ? 'NeuroShield' : 'NeuroShield: protection off' }));
    quiet(chrome.action.setBadgeBackgroundColor({ color: BADGE_COLOR }));
    if (chrome.action.setBadgeTextColor) quiet(chrome.action.setBadgeTextColor({ color: '#ffffff' }));
  }

  /** What each tab's button shows, so unchanged values aren't sent again on every report. */
  const shown = new Map();

  function refreshTabAction(tabId) {
    const tab = tabs.get(tabId);
    if (!tab) return;
    const summary = Tabs.summarize(tab);
    const on = settings.enabled && tab.active;
    let title = 'NeuroShield: protection off';
    if (on) title = summary.detections ? `NeuroShield: hid flashing ${summary.detections}× on this page` : 'NeuroShield: protecting this page';
    else if (settings.enabled && tab.siteDisabled) title = `NeuroShield: paused on ${tab.host}`;
    const text = on ? Tabs.badgeText(summary) : '';
    const last = shown.get(tabId) || {};
    if (last.text !== text) quiet(chrome.action.setBadgeText({ tabId, text }));
    if (last.on !== on) quiet(chrome.action.setIcon({ tabId, path: on ? ICONS.on : ICONS.off }));
    if (last.title !== title) quiet(chrome.action.setTitle({ tabId, title }));
    shown.set(tabId, { text, on, title });
  }

  /** Chrome resets a tab's button when it navigates; forget what was shown. */
  function resetTabAction(tabId) {
    shown.delete(tabId);
    quiet(chrome.action.setBadgeText({ tabId, text: '' }));
    quiet(chrome.action.setIcon({ tabId, path: settings.enabled ? ICONS.on : ICONS.off }));
    quiet(chrome.action.setTitle({ tabId, title: settings.enabled ? 'NeuroShield' : 'NeuroShield: protection off' }));
  }

  // ─── Tab state ───────────────────────────────────────────────────────
  // Kept in memory and mirrored to storage.session, so a restarted worker
  // picks up where it left off.

  const tabs = new Map();
  const saveTimers = new Map();
  const loading = new Map();

  /**
   * Make sure a tab's stored state is in memory. Concurrent callers share one
   * read, and every update reads tabs.get() afterwards, so none is lost.
   */
  function loadTab(tabId) {
    if (tabs.has(tabId)) return Promise.resolve(tabs.get(tabId));
    if (!loading.has(tabId)) {
      const key = 'tab:' + tabId;
      loading.set(tabId, chrome.storage.session.get(key).then((stored) => {
        loading.delete(tabId);
        if (stored[key] && !tabs.has(tabId)) tabs.set(tabId, stored[key]);
        return tabs.get(tabId) || null;
      }, () => {
        loading.delete(tabId);
        return tabs.get(tabId) || null;
      }));
    }
    return loading.get(tabId);
  }

  function storeTab(tabId, tab) {
    tabs.set(tabId, tab);
    clearTimeout(saveTimers.get(tabId));
    saveTimers.set(tabId, setTimeout(() => {
      saveTimers.delete(tabId);
      const current = tabs.get(tabId);
      if (current) quiet(chrome.storage.session.set({ ['tab:' + tabId]: current }));
    }, 400));
    refreshTabAction(tabId);
  }

  function forgetTab(tabId) {
    tabs.delete(tabId);
    shown.delete(tabId);
    clearTimeout(saveTimers.get(tabId));
    saveTimers.delete(tabId);
    quiet(chrome.storage.session.remove('tab:' + tabId));
  }

  async function onFrameState(tabId, frameId, message) {
    await settingsReady;
    await loadTab(tabId);
    const before = tabs.get(tabId);
    // A new page may have had its button reset by Chrome: send everything again.
    if (message.top && (!before || before.page !== message.page)) shown.delete(tabId);
    storeTab(tabId, Tabs.applyFrameState(before, frameId, message));
  }

  async function onDetection(tabId, frameId) {
    await settingsReady;
    await loadTab(tabId);
    storeTab(tabId, Tabs.applyDetection(tabs.get(tabId), frameId));
    bumpLifetimeCount();
  }

  async function onFrameGone(tabId, frameId) {
    await loadTab(tabId);
    const tab = tabs.get(tabId);
    if (tab && tab.frames[frameId]) storeTab(tabId, Tabs.removeFrame(tab, frameId));
  }

  /** Send to every frame of a tab. False when no frame has NeuroShield running. */
  async function sendToTab(tabId, message, options) {
    try {
      return { ok: true, response: await chrome.tabs.sendMessage(tabId, message, options) };
    } catch (_) {
      return { ok: false };
    }
  }

  /**
   * Hide or show a whole page. If NeuroShield isn't running in the tab yet it
   * is started first; where Chrome doesn't allow it at all (browser pages, the
   * Web Store), the popup opens to say so instead of silently doing nothing.
   */
  async function setHidden(tabId, hidden) {
    const message = { type: hidden ? 'hide-page' : 'show-page' };
    let sent = await sendToTab(tabId, message);
    if (!sent.ok && hidden && (await injectInto(tabId))) sent = await sendToTab(tabId, message);
    await loadTab(tabId);
    if (!sent.ok) {
      if (hidden && chrome.action.openPopup) quiet(chrome.action.openPopup());
      if (tabs.get(tabId)) storeTab(tabId, Object.assign(Tabs.createTab(), tabs.get(tabId), { hidden: false }));
      return;
    }
    storeTab(tabId, Object.assign(Tabs.createTab(), tabs.get(tabId), { hidden }));
  }

  // ─── Stats ───────────────────────────────────────────────────────────

  let statsWrites = Promise.resolve();

  /** Serialized so concurrent detections can't overwrite each other's increment. */
  function bumpLifetimeCount() {
    statsWrites = statsWrites
      .then(async () => {
        const { stats } = await chrome.storage.local.get('stats');
        const total = (stats && Number(stats.totalDetections)) || 0;
        await chrome.storage.local.set({ stats: { totalDetections: total + 1 } });
      })
      .catch(() => {});
  }

  // ─── Injection into open tabs ────────────────────────────────────────

  const contentScript = chrome.runtime.getManifest().content_scripts[0];

  async function injectInto(tabId) {
    const target = { tabId, allFrames: true };
    try {
      await chrome.scripting.insertCSS({ target, files: contentScript.css });
      await chrome.scripting.executeScript({ target, files: contentScript.js });
      return true;
    } catch (_) {
      return false;
    }
  }

  /**
   * Content scripts only load into pages opened after install, and an update
   * orphans the old ones. Put protection into every open tab right away.
   */
  async function injectIntoOpenTabs() {
    const open = await chrome.tabs.query({});
    await Promise.all(open.filter((t) => !t.discarded && SCRIPTABLE.test(t.url || '')).map((t) => injectInto(t.id)));
  }

  // ─── Popup ───────────────────────────────────────────────────────────

  /**
   * The tab's state, if it still describes the page in the tab. Without the
   * "tabs" permission there's no event for a tab moving to a page NeuroShield
   * can't run on (an error page, chrome://), so ask the top frame directly.
   */
  async function liveTab(tabId) {
    const tab = await loadTab(tabId);
    if (!tab) return null;
    const ping = await sendToTab(tabId, { type: 'ping' }, { frameId: 0 });
    if (ping.ok && ping.response && ping.response.page) return tabs.get(tabId) || null;
    if (ping.ok) return tab; // an older copy that doesn't answer pings
    forgetTab(tabId);
    resetTabAction(tabId);
    return null;
  }

  async function popupState(tabId) {
    const [current, tab, stored] = await Promise.all([
      Settings.load(),
      typeof tabId === 'number' ? liveTab(tabId) : null,
      chrome.storage.local.get('stats'),
    ]);
    return {
      settings: current,
      tab: tab
        ? Object.assign(Tabs.summarize(tab), {
          host: tab.host,
          active: tab.active,
          siteDisabled: tab.siteDisabled,
          hidden: tab.hidden,
        })
        : null,
      totalDetections: (stored.stats && Number(stored.stats.totalDetections)) || 0,
    };
  }

  // ─── Events ──────────────────────────────────────────────────────────

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!message || sender.id !== chrome.runtime.id) return false;
    const fromExtensionPage = typeof sender.url === 'string' && sender.url.startsWith(EXTENSION_ORIGIN);
    const tabId = sender.tab && sender.tab.id;
    // A prerendering page isn't on screen yet; it reports again when shown.
    if (sender.documentLifecycle && sender.documentLifecycle !== 'active' && !fromExtensionPage) return false;

    switch (message.type) {
      case 'frame-state':
        if (typeof tabId === 'number' && !fromExtensionPage) quiet(onFrameState(tabId, sender.frameId || 0, message));
        return false;
      case 'detection':
        if (typeof tabId === 'number' && !fromExtensionPage) quiet(onDetection(tabId, sender.frameId || 0));
        return false;
      case 'frame-gone':
        if (typeof tabId === 'number' && !fromExtensionPage && sender.frameId) quiet(onFrameGone(tabId, sender.frameId));
        return false;
      case 'show-page':
      case 'hide-page': {
        const target = fromExtensionPage ? message.tabId : tabId;
        if (typeof target === 'number') quiet(setHidden(target, message.type === 'hide-page'));
        return false;
      }
      case 'popup-state':
        if (!fromExtensionPage) return false;
        popupState(message.tabId).then(sendResponse, () => sendResponse(null));
        return true;
      case 'protect-tab':
        if (!fromExtensionPage || typeof message.tabId !== 'number') return false;
        injectInto(message.tabId).then(sendResponse);
        return true;
      default:
        return false;
    }
  });

  Settings.onChange((next) => {
    settings = next;
    refreshGlobalAction();
    for (const tabId of tabs.keys()) refreshTabAction(tabId);
  });

  chrome.commands.onCommand.addListener(async (command, tab) => {
    if (command !== 'toggle-hide-page' || !tab || typeof tab.id !== 'number') return;
    const state = await loadTab(tab.id);
    quiet(setHidden(tab.id, !(state && state.hidden)));
  });

  chrome.tabs.onRemoved.addListener((tabId) => forgetTab(tabId));

  // Navigating to a page NeuroShield can't run on: drop the old page's state.
  chrome.tabs.onUpdated.addListener((tabId, change) => {
    if (change.url && !SCRIPTABLE.test(change.url) && tabs.has(tabId)) {
      forgetTab(tabId);
      resetTabAction(tabId);
    } else if (change.status === 'complete' && tabs.has(tabId)) {
      // Error pages and browser pages have no content script to report the
      // change (and their URL is withheld): check the page is still ours.
      quiet(liveTab(tabId));
    }
  });

  chrome.runtime.onInstalled.addListener(async (details) => {
    // Rewrite settings in the current shape (also migrates 1.0 data).
    const stored = await chrome.storage.local.get(null);
    const total = (stored.stats && Number(stored.stats.totalDetections)) || 0;
    await chrome.storage.local.set(Object.assign(Settings.normalize(stored), { stats: { totalDetections: total } }));
    settings = await Settings.load();
    refreshGlobalAction();
    if (details.reason === 'install') {
      quiet(chrome.tabs.create({ url: chrome.runtime.getURL('src/options/options.html#welcome') }));
    }
    // Chrome or shared-module updates leave the running copies working; only
    // a new install or a new version of NeuroShield needs them (re)started.
    if (details.reason === 'install' || details.reason === 'update') await injectIntoOpenTabs();
  });

  chrome.runtime.onStartup.addListener(() => settingsReady.then(refreshGlobalAction));
  settingsReady.then(refreshGlobalAction);
})();
