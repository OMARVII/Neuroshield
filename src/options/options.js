/**
 * NeuroShield — options page (also shown once after install as a welcome page).
 */
(() => {
  'use strict';

  const Settings = NeuroShieldSettings;
  const $ = (id) => document.getElementById(id);

  const ui = {
    enabled: $('enabled'),
    levels: [...document.querySelectorAll('input[name="sensitivity"]')],
    pauseOnDetect: $('pauseOnDetect'),
    unscannable: $('unscannable'),
    sites: $('sites'),
    sitesEmpty: $('sitesEmpty'),
    addSite: $('addSite'),
    siteInput: $('siteInput'),
    siteError: $('siteError'),
    total: $('total'),
  };

  let settings = Settings.normalize(null);

  function render() {
    ui.enabled.checked = settings.enabled;
    for (const input of ui.levels) {
      input.checked = input.value === settings.sensitivity;
      input.disabled = !settings.enabled;
    }
    ui.pauseOnDetect.checked = settings.pauseOnDetect;
    ui.unscannable.value = settings.unscannable;

    ui.sites.replaceChildren(
      ...settings.disabledSites.map((site) => {
        const item = document.createElement('li');
        const name = document.createElement('span');
        name.textContent = site;
        const remove = document.createElement('button');
        remove.type = 'button';
        remove.className = 'button subtle';
        remove.textContent = 'Resume';
        remove.setAttribute('aria-label', `Resume protection on ${site}`);
        remove.addEventListener('click', () => {
          Settings.save({ disabledSites: settings.disabledSites.filter((s) => s !== site) });
        });
        item.append(name, remove);
        return item;
      }),
    );
    ui.sitesEmpty.hidden = settings.disabledSites.length > 0;
    ui.sites.hidden = settings.disabledSites.length === 0;
  }

  function renderTotal(stats) {
    const n = (stats && Number(stats.totalDetections)) || 0;
    if (!n) ui.total.textContent = 'No flashing hidden yet';
    else ui.total.textContent = `${n.toLocaleString()} flashing ${n === 1 ? 'sequence' : 'sequences'} hidden`;
  }

  ui.enabled.addEventListener('change', () => Settings.save({ enabled: ui.enabled.checked }));
  for (const input of ui.levels) {
    input.addEventListener('change', () => input.checked && Settings.save({ sensitivity: input.value }));
  }
  ui.pauseOnDetect.addEventListener('change', () => Settings.save({ pauseOnDetect: ui.pauseOnDetect.checked }));
  ui.unscannable.addEventListener('change', () => Settings.save({ unscannable: ui.unscannable.value }));

  ui.addSite.addEventListener('submit', (e) => {
    e.preventDefault();
    const site = Settings.siteKey(ui.siteInput.value);
    // A bare "com" or "uk" would pause every site under it.
    const whole = site && (site.includes('.') || site === 'localhost' || site.startsWith('['));
    if (!whole) {
      showSiteError('Enter a site like example.com.');
      return;
    }
    if (Settings.isSiteDisabled(settings, site)) {
      showSiteError(`${site} is already paused.`);
      return;
    }
    ui.siteError.hidden = true;
    ui.siteInput.value = '';
    Settings.save({ disabledSites: [...settings.disabledSites, site] });
  });
  function showSiteError(text) {
    ui.siteError.textContent = text;
    ui.siteError.hidden = false;
  }

  ui.siteInput.addEventListener('input', () => {
    ui.siteError.hidden = true;
  });

  // Two presses to reset, so the count isn't lost to a stray click.
  const resetStats = $('resetStats');
  let resetTimer = 0;
  resetStats.addEventListener('click', () => {
    if (!resetTimer) {
      resetStats.textContent = 'Press again to reset';
      resetTimer = setTimeout(() => {
        resetTimer = 0;
        resetStats.textContent = 'Reset';
      }, 4000);
      return;
    }
    clearTimeout(resetTimer);
    resetTimer = 0;
    resetStats.textContent = 'Reset';
    chrome.storage.local.set({ stats: { totalDetections: 0 } });
  });
  $('editShortcuts').addEventListener('click', () => chrome.tabs.create({ url: 'chrome://extensions/shortcuts' }));

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.stats) renderTotal(changes.stats.newValue);
  });
  Settings.onChange((next) => {
    settings = next;
    render();
  });

  $('version').textContent = 'v' + chrome.runtime.getManifest().version;
  $('welcome').hidden = location.hash !== '#welcome';

  chrome.commands.getAll().then((commands) => {
    const hide = commands.find((c) => c.name === 'toggle-hide-page');
    const text = hide && hide.shortcut ? hide.shortcut : 'Not set';
    for (const el of document.querySelectorAll('.shortcut-text')) el.textContent = text;
    // Chrome leaves the shortcut unassigned when another extension already uses it.
    $('welcomeShortcut').hidden = !(hide && hide.shortcut);
  });

  Settings.load().then((loaded) => {
    settings = loaded;
    render();
  });
  chrome.storage.local.get('stats').then(({ stats }) => renderTotal(stats));
})();
