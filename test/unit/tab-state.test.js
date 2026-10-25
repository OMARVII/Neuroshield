const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { loadScripts } = require('./helpers');

const Tabs = loadScripts(['src/background/tab-state.js']).NeuroShieldTabs;

const counts = (o) => Object.assign({ videos: 0, canvases: 0, animations: 0, blocked: 0, unscannable: 0, detections: 0 }, o);
const report = (top, page, state, extra = {}) => Object.assign({ top, page, state, host: top ? 'example.com' : undefined, active: true }, extra);

describe('tab state', () => {
  it('adds up every frame of a tab', () => {
    let tab = Tabs.applyFrameState(null, 0, report(true, 'p1', { videos: 1, detections: 1 }));
    tab = Tabs.applyFrameState(tab, 7, report(false, 'x', { videos: 2, unscannable: 1 }));
    assert.deepStrictEqual({ ...Tabs.summarize(tab) }, counts({ videos: 3, unscannable: 1, detections: 1 }));
    assert.strictEqual(tab.host, 'example.com');
  });

  it('a frame report replaces that frame\'s earlier report', () => {
    let tab = Tabs.applyFrameState(null, 0, report(true, 'p1', { videos: 2 }));
    tab = Tabs.applyFrameState(tab, 0, report(true, 'p1', { videos: 1 }));
    assert.strictEqual(Tabs.summarize(tab).videos, 1);
  });

  it('a new page in the top frame drops the previous page\'s frames', () => {
    let tab = Tabs.applyFrameState(null, 0, report(true, 'p1', { detections: 3 }));
    tab = Tabs.applyFrameState(tab, 5, report(false, 'x', { detections: 2 }));
    tab = Object.assign({}, tab, { hidden: true });
    tab = Tabs.applyFrameState(tab, 0, report(true, 'p2', {}));
    assert.strictEqual(Tabs.summarize(tab).detections, 0);
    assert.strictEqual(tab.hidden, false);
    assert.deepStrictEqual(Object.keys(tab.frames), ['0']);
  });

  it('counts a detection before the frame reports it', () => {
    let tab = Tabs.applyFrameState(null, 0, report(true, 'p1', {}));
    tab = Tabs.applyDetection(tab, 3);
    tab = Tabs.applyDetection(tab, 3);
    assert.strictEqual(Tabs.summarize(tab).detections, 2);
  });

  it('does not mutate the previous state', () => {
    const before = Tabs.applyFrameState(null, 0, report(true, 'p1', { videos: 1 }));
    const snapshot = JSON.stringify(before);
    Tabs.applyFrameState(before, 2, report(false, 'x', { videos: 4 }));
    Tabs.applyDetection(before, 0);
    assert.strictEqual(JSON.stringify(before), snapshot);
  });

  it('keeps only non-negative whole counts from reports', () => {
    const tab = Tabs.applyFrameState(null, 0, report(true, 'p1', { videos: -3, canvases: '2', animations: 1.7, blocked: NaN, bogus: 9 }));
    assert.deepStrictEqual({ ...tab.frames[0] }, counts({ canvases: 2, animations: 1 }));
  });

  it('drops a frame that went away but keeps the flashes it hid', () => {
    let tab = Tabs.applyFrameState(null, 0, report(true, 'p1', { videos: 1 }));
    tab = Tabs.applyFrameState(tab, 4, report(false, 'x', { videos: 2, detections: 3 }));
    tab = Tabs.removeFrame(tab, 4);
    assert.deepStrictEqual({ ...Tabs.summarize(tab) }, counts({ videos: 1, detections: 3 }));
    tab = Tabs.applyFrameState(tab, 0, report(true, 'p2', {}));
    assert.strictEqual(Tabs.summarize(tab).detections, 0, 'a new page starts from zero');
  });

  it('takes the hidden state from the top frame when it reports one', () => {
    let tab = Tabs.applyFrameState(null, 0, report(true, 'p1', {}));
    tab = Tabs.applyFrameState(tab, 0, report(true, 'p2', {}, { hidden: true }));
    assert.strictEqual(tab.hidden, true, 'a page restored from the back/forward cache with its cover up');
    tab = Tabs.applyFrameState(tab, 3, report(false, 'x', {}, { hidden: false }));
    assert.strictEqual(tab.hidden, true, 'sub-frames do not decide');
    tab = Tabs.applyFrameState(tab, 0, report(true, 'p2', {}));
    assert.strictEqual(tab.hidden, true, 'a report without it keeps the stored value');
  });

  it('records whether protection runs on the page', () => {
    const tab = Tabs.applyFrameState(null, 0, report(true, 'p1', {}, { active: false, siteDisabled: true }));
    assert.strictEqual(tab.active, false);
    assert.strictEqual(tab.siteDisabled, true);
  });
});

describe('badge text', () => {
  it('is empty without detections and caps at 99+', () => {
    assert.strictEqual(Tabs.badgeText(counts()), '');
    assert.strictEqual(Tabs.badgeText(counts({ detections: 4 })), '4');
    assert.strictEqual(Tabs.badgeText(counts({ detections: 120 })), '99+');
  });
});
