const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { loadScripts } = require('./helpers');

/** Minimal chrome.storage.local stand-in. */
function fakeChrome() {
  const data = {};
  const listeners = [];
  return {
    data,
    listeners,
    runtime: { lastError: undefined },
    storage: {
      local: {
        get(keys, callback) {
          const out = {};
          for (const k of keys) if (k in data) out[k] = data[k];
          callback(out);
        },
        set(patch) {
          const changes = {};
          for (const [k, v] of Object.entries(patch)) {
            changes[k] = { oldValue: data[k], newValue: v };
            data[k] = v;
          }
          for (const l of listeners) l(changes, 'local');
          return Promise.resolve();
        },
      },
      onChanged: {
        addListener: (l) => listeners.push(l),
        removeListener: (l) => listeners.splice(listeners.indexOf(l), 1),
      },
    },
  };
}

/** Values from the VM sandbox, as plain data from this realm. */
const plain = (v) => JSON.parse(JSON.stringify(v));

function load(chrome) {
  return loadScripts(['src/shared/settings.js'], { chrome, URL }).NeuroShieldSettings;
}

describe('settings.normalize', () => {
  const S = load(fakeChrome());

  it('fills in defaults', () => {
    assert.deepStrictEqual(plain(S.normalize(null)), {
      enabled: true,
      sensitivity: 'medium',
      pauseOnDetect: true,
      unscannable: 'notice',
      disabledSites: [],
    });
  });

  it('keeps valid values and repairs invalid ones', () => {
    const s = S.normalize({ enabled: false, sensitivity: 'turbo', unscannable: 'explode', pauseOnDetect: false, disabledSites: 'nope' });
    assert.strictEqual(s.enabled, false);
    assert.strictEqual(s.sensitivity, 'medium');
    assert.strictEqual(s.unscannable, 'notice');
    assert.strictEqual(s.pauseOnDetect, false);
    assert.deepStrictEqual(plain(s.disabledSites), []);
  });

  it('migrates v1.0 storage (enabled, sensitivity, stats)', () => {
    const s = S.normalize({ enabled: true, sensitivity: 'maximum', stats: { totalDetections: 7, sessionsProtected: 2 } });
    assert.strictEqual(s.sensitivity, 'maximum');
    assert.ok(!('stats' in s));
  });

  it('cleans, de-duplicates and sorts paused sites', () => {
    const s = S.normalize({ disabledSites: ['WWW.YouTube.com', 'youtube.com', 'https://news.example.org/path', '', 42, 'bad host!'] });
    assert.deepStrictEqual(plain(s.disabledSites), ['news.example.org', 'youtube.com']);
  });
});

describe('settings.siteKey', () => {
  const S = load(fakeChrome());

  it('reduces hostnames and URLs to a lowercase host without www.', () => {
    assert.strictEqual(S.siteKey('www.Example.com'), 'example.com');
    assert.strictEqual(S.siteKey('https://www.example.com:8080/x?y'), 'example.com');
    assert.strictEqual(S.siteKey('localhost:3000'), 'localhost');
    assert.strictEqual(S.siteKey('sub.example.co.uk.'), 'sub.example.co.uk');
  });

  it('stores international names in punycode, typed or from a URL', () => {
    assert.strictEqual(S.siteKey('münchen.de'), 'xn--mnchen-3ya.de');
    assert.strictEqual(S.siteKey('https://münchen.de/x'), 'xn--mnchen-3ya.de');
    assert.strictEqual(S.siteKey('[::1]:8080'), '[::1]');
  });

  it('rejects empty and invalid input', () => {
    for (const bad of ['', '   ', null, undefined, 5, 'has space.com', 'http://', 'javascript:alert(1)', 'file:///etc/hosts']) assert.strictEqual(S.siteKey(bad), '');
  });
});

describe('settings.isSiteDisabled', () => {
  const S = load(fakeChrome());
  const settings = S.normalize({ disabledSites: ['example.com'] });

  it('matches the site and its subdomains', () => {
    assert.strictEqual(S.isSiteDisabled(settings, 'example.com'), true);
    assert.strictEqual(S.isSiteDisabled(settings, 'www.example.com'), true);
    assert.strictEqual(S.isSiteDisabled(settings, 'video.cdn.example.com'), true);
  });

  it('does not match look-alikes or empty hosts', () => {
    assert.strictEqual(S.isSiteDisabled(settings, 'notexample.com'), false);
    assert.strictEqual(S.isSiteDisabled(settings, 'example.com.evil.net'), false);
    assert.strictEqual(S.isSiteDisabled(settings, ''), false);
  });
});

describe('settings storage', () => {
  let chrome;
  let S;
  beforeEach(() => {
    chrome = fakeChrome();
    S = load(chrome);
  });

  it('load() returns normalized settings', async () => {
    chrome.data.sensitivity = 'high';
    chrome.data.disabledSites = ['www.a.com'];
    const s = await S.load();
    assert.strictEqual(s.sensitivity, 'high');
    assert.deepStrictEqual(plain(s.disabledSites), ['a.com']);
  });

  it('save() writes only the given keys, normalized', async () => {
    await S.save({ sensitivity: 'bogus', disabledSites: ['WWW.B.com'], unrelated: 1 });
    assert.deepStrictEqual(plain(chrome.data), { sensitivity: 'medium', disabledSites: ['b.com'] });
  });

  it('onChange() fires for setting changes only', async () => {
    const seen = [];
    S.onChange((s) => seen.push(s.sensitivity));
    await chrome.storage.local.set({ stats: { totalDetections: 1 } });
    await chrome.storage.local.set({ sensitivity: 'low' });
    await new Promise((r) => setTimeout(r, 0));
    assert.deepStrictEqual(seen, ['low']);
  });
});
