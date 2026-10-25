/**
 * NeuroShield — toolbar popup.
 *
 * Shows the state of the current tab and the quick controls. Settings are
 * written straight to chrome.storage; every tab picks the change up itself.
 */
(() => {
  'use strict';

  const Settings = NeuroShieldSettings;
  const $ = (id) => document.getElementById(id);

  const HINTS = {
    low: 'Hides only intense strobing: more than 5 flashes a second.',
    medium: 'Hides more than 3 flashes a second, the WCAG 2.3.1 limit. Recommended.',
    high: 'Hides more than 2 flashes a second. A good fit for migraine and visual snow.',
    maximum: 'Hides any flashing, even a single flash.',
  };

  /** Pages Chrome never lets extensions run on. */
  const BLOCKED_HOSTS = ['chromewebstore.google.com', 'chrome.google.com'];

  const ui = {
    popup: $('popup'),
    title: $('heroTitle'),
    detail: $('heroDetail'),
    enabled: $('enabled'),
    protectTab: $('protectTab'),
    sitePanel: $('sitePanel'),
    siteHost: $('siteHost'),
    siteEnabled: $('siteEnabled'),
    sensitivity: [...document.querySelectorAll('#sensitivity [role="radio"]')],
    hint: $('sensitivityHint'),
    pageCount: $('pageCount'),
    totalCount: $('totalCount'),
    hidePage: $('hidePage'),
    hidePageLabel: $('hidePageLabel'),
    shortcut: $('shortcut'),
  };

  let tab = null;
  let state = null;
  let fileAccess = true;

  /** Set text only when it changes, so the live region isn't re-announced every second. */
  function setText(node, text) {
    if (node.textContent !== text) node.textContent = text;
  }

  function plural(n, word) {
    return `${n} ${word}${n === 1 ? '' : word.endsWith('s') ? 'es' : 's'}`;
  }

  function listJoin(parts) {
    if (parts.length < 2) return parts.join('');
    return parts.slice(0, -1).join(', ') + ' and ' + parts[parts.length - 1];
  }

  /** What NeuroShield can do on the current tab, from its URL. */
  function tabKind() {
    const url = tab && tab.url;
    if (!url) return 'unsupported';
    let parsed;
    try {
      parsed = new URL(url);
    } catch (_) {
      return 'unsupported';
    }
    if (!/^(https?|file):$/.test(parsed.protocol)) return 'unsupported';
    if (BLOCKED_HOSTS.includes(parsed.hostname) && (parsed.hostname !== 'chrome.google.com' || parsed.pathname.startsWith('/webstore'))) {
      return 'unsupported';
    }
    return parsed.protocol === 'file:' ? 'file' : 'web';
  }

  function siteOfTab() {
    try {
      return Settings.siteKey(new URL(tab.url).hostname);
    } catch (_) {
      return '';
    }
  }

  function render() {
    const settings = state.settings;
    const t = state.tab;
    const kind = tabKind();
    const site = kind === 'web' ? siteOfTab() : '';
    // The entry that pauses this site: the site itself or a parent domain.
    const pausedBy = site ? settings.disabledSites.find((s) => site === s || site.endsWith('.' + s)) : undefined;

    let view;
    if (!settings.enabled) view = 'off';
    else if (kind === 'unsupported') view = 'unsupported';
    else if (pausedBy) view = 'paused';
    else if (!t) view = 'inactive';
    else if (t.unscannable) view = 'partial';
    else view = 'on';
    ui.popup.dataset.state = view;

    let title;
    let detail;
    const watching = [];
    if (t) {
      if (t.videos) watching.push(plural(t.videos, 'video'));
      if (t.canvases) watching.push(plural(t.canvases, 'canvas'));
      if (t.animations) watching.push(plural(t.animations, 'animation'));
    }
    switch (view) {
      case 'off':
        title = 'Protection is off';
        detail = 'Flashing content won\'t be hidden on any site.';
        break;
      case 'unsupported':
        title = 'Not available here';
        detail = 'Chrome doesn\'t let extensions run on this page.';
        if (!fileAccess && !tab.url) detail += ' For files on your computer, turn on "Allow access to file URLs" in NeuroShield\'s details.';
        break;
      case 'paused':
        title = `Paused on ${pausedBy}`;
        detail = pausedBy === site
          ? 'Turn it back on for this site below.'
          : `That includes ${site}. Turning it back on resumes all of ${pausedBy}.`;
        break;
      case 'inactive':
        title = 'Not running on this page';
        detail = kind === 'file'
          ? 'Turn on "Allow access to file URLs" in NeuroShield\'s details.'
          : 'It starts on pages opened or reloaded after it was installed.';
        break;
      case 'partial':
        title = 'Partly protected';
        detail = `${plural(t.unscannable, 'video')} can't be checked`;
        if (watching.length) detail += ` · watching ${listJoin(watching)}`;
        break;
      default:
        title = 'Protected';
        detail = watching.length ? `Watching ${listJoin(watching)}` : 'Nothing is playing right now';
    }
    setText(ui.title, title);
    setText(ui.detail, detail);

    ui.enabled.checked = settings.enabled;
    ui.protectTab.hidden = !(view === 'inactive' && kind === 'web');

    ui.sitePanel.hidden = !site || view === 'unsupported';
    setText(ui.siteHost, pausedBy || site);
    ui.siteEnabled.checked = !pausedBy;
    ui.siteEnabled.disabled = !settings.enabled;

    for (const button of ui.sensitivity) {
      const selected = button.dataset.value === settings.sensitivity;
      button.setAttribute('aria-checked', String(selected));
      button.tabIndex = selected ? 0 : -1;
      button.disabled = !settings.enabled;
    }
    setText(ui.hint, HINTS[settings.sensitivity]);

    setText(ui.pageCount, String(t ? t.detections : 0));
    setText(ui.totalCount, state.totalDetections.toLocaleString());

    const canHide = view !== 'unsupported' && view !== 'inactive';
    ui.hidePage.disabled = !canHide;
    setText(ui.hidePageLabel, t && t.hidden ? 'Show this page again' : 'Hide everything on this page');
  }

  async function refresh() {
    try {
      const next = await chrome.runtime.sendMessage({ type: 'popup-state', tabId: tab && tab.id });
      if (next) {
        state = next;
        render();
      }
    } catch (_) {
      // Service worker restarting; the next refresh catches up.
    }
  }

  // ─── Controls ────────────────────────────────────────────────────────

  ui.enabled.addEventListener('change', () => Settings.save({ enabled: ui.enabled.checked }));

  ui.siteEnabled.addEventListener('change', () => {
    const site = siteOfTab();
    if (!site) return;
    const sites = new Set(state.settings.disabledSites.filter((s) => !(site === s || site.endsWith('.' + s))));
    if (!ui.siteEnabled.checked) sites.add(site);
    Settings.save({ disabledSites: [...sites] });
  });

  function chooseSensitivity(button) {
    if (button.disabled) return;
    Settings.save({ sensitivity: button.dataset.value });
  }

  for (const button of ui.sensitivity) {
    button.addEventListener('click', () => chooseSensitivity(button));
    button.addEventListener('keydown', (e) => {
      const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key];
      if (!step) return;
      e.preventDefault();
      const i = ui.sensitivity.indexOf(button);
      const next = ui.sensitivity[(i + step + ui.sensitivity.length) % ui.sensitivity.length];
      next.focus();
      chooseSensitivity(next);
    });
  }

  ui.hidePage.addEventListener('click', async () => {
    if (!tab) return;
    const hidden = state.tab && state.tab.hidden;
    await chrome.runtime.sendMessage({ type: hidden ? 'show-page' : 'hide-page', tabId: tab.id });
    window.close();
  });

  ui.protectTab.addEventListener('click', async () => {
    ui.protectTab.disabled = true;
    ui.protectTab.textContent = 'Turning on…';
    const ok = await chrome.runtime.sendMessage({ type: 'protect-tab', tabId: tab.id });
    if (!ok) {
      ui.protectTab.textContent = 'Couldn\'t start here. Try reloading the page.';
      return;
    }
    setTimeout(refresh, 400);
  });

  $('openOptions').addEventListener('click', () => {
    chrome.runtime.openOptionsPage();
    window.close();
  });

  async function showShortcut() {
    try {
      const commands = await chrome.commands.getAll();
      const hide = commands.find((c) => c.name === 'toggle-hide-page');
      if (hide && hide.shortcut) {
        ui.shortcut.textContent = hide.shortcut;
        ui.shortcut.hidden = false;
        ui.hidePage.setAttribute('aria-keyshortcuts', hide.shortcut.replace(/⌥/g, 'Alt+').replace(/⇧/g, 'Shift+').replace(/⌘/g, 'Meta+').replace(/⌃/g, 'Control+').replace(/\+\+/g, '+'));
      }
    } catch (_) {
      // commands API unavailable
    }
  }

  // ─── Start ───────────────────────────────────────────────────────────

  (async () => {
    // popup.html?tab=<id> shows another tab's state (used by tests; handy for debugging).
    const requested = Number(new URLSearchParams(location.search).get('tab'));
    tab = requested > 0
      ? await chrome.tabs.get(requested).catch(() => null)
      : (await chrome.tabs.query({ active: true, currentWindow: true }))[0];
    try {
      fileAccess = (await chrome.extension.isAllowedFileSchemeAccess()) !== false;
    } catch (_) {
      // unavailable: keep the default
    }
    await refresh();
    showShortcut();
    Settings.onChange(refresh);
    // Counts change while the popup is open (a video starts, a flash is hidden).
    setInterval(refresh, 1000);
  })();
})();
