/**
 * NeuroShield — on-page UI.
 *
 * Every piece of UI is a "layer": a host element in the browser's top layer
 * (via the Popover API) with a closed shadow root. The top layer sits above
 * fullscreen elements and any z-index, and the shadow root keeps page CSS out.
 *
 * Layers never do the protecting themselves: guards black out or dim the
 * flashing element with an inline filter, which the browser keeps perfectly
 * aligned while scrolling. Layers only carry the message and the buttons.
 *
 * DOM is built with createElement only (see CONTRIBUTING.md).
 */
var NeuroShieldOverlay = (() => {
  'use strict';

  const SVG_NS = 'http://www.w3.org/2000/svg';

  const LEVEL_NAMES = { low: 'Low', medium: 'Medium', high: 'High', maximum: 'Maximum' };

  const STYLES = `
:host { all: initial; }
* { box-sizing: border-box; }
.layer {
  position: absolute; inset: 0; display: grid; place-items: center; padding: 8px;
  pointer-events: none; overflow: visible;
  font: 13px/1.45 ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
  color: #e8eaed; -webkit-font-smoothing: antialiased; text-align: left;
  --accent: #5eead4; --accent-ink: #042f2e; --accent-hover: #99f6e4;
}
.layer[data-place="corner"] { place-items: start; }
.layer.page { pointer-events: auto; background: #0b0d10; }
.card, .chip, .mini { pointer-events: auto; animation: enter .16s ease-out both; }
@keyframes enter { from { opacity: 0; transform: translateY(4px) scale(.98); } }
@media (prefers-reduced-motion: reduce) { .card, .chip, .mini { animation: none; } }

.card {
  display: grid; justify-items: center; gap: 12px; text-align: center;
  width: min(360px, 100%); padding: 20px 22px;
  background: #15181d; border: 1px solid rgba(255,255,255,.09); border-radius: 16px;
  box-shadow: 0 16px 40px rgba(0,0,0,.45), 0 2px 6px rgba(0,0,0,.3);
}
.badge {
  display: grid; place-items: center; width: 44px; height: 44px; border-radius: 50%;
  color: var(--accent); background: rgba(94,234,212,.12);
}
.badge svg { width: 24px; height: 24px; }
.text { display: grid; gap: 4px; }
.title { margin: 0; font-size: 15px; font-weight: 650; color: #f3f4f6; letter-spacing: -.005em; }
.detail { margin: 0; color: #c4c9d1; }
.meta { margin: 0; color: #8b929d; font-size: 12px; }
.actions { display: flex; flex-wrap: wrap; justify-content: center; gap: 8px; }

button {
  all: unset; box-sizing: border-box; display: inline-flex; align-items: center; justify-content: center; gap: 6px;
  min-height: 34px; padding: 0 14px; border-radius: 9px; cursor: pointer;
  font: 600 13px/1 ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; white-space: nowrap;
  transition: background-color .12s, border-color .12s, color .12s;
}
button:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.primary { background: var(--accent); color: var(--accent-ink); }
.primary:hover { background: var(--accent-hover); }
.secondary { background: rgba(255,255,255,.07); color: #e8eaed; box-shadow: inset 0 0 0 1px rgba(255,255,255,.12); }
.secondary:hover { background: rgba(255,255,255,.12); }

/* Compact: a single row for small players. */
.layer[data-size="compact"] .card { grid-template-columns: auto 1fr; justify-items: start; text-align: left; gap: 8px 10px; padding: 12px 14px; width: min(320px, 100%); border-radius: 12px; box-shadow: 0 4px 14px rgba(0,0,0,.35); }
.layer[data-size="compact"] .badge { width: 32px; height: 32px; }
.layer[data-size="compact"] .badge svg { width: 18px; height: 18px; }
.layer[data-size="compact"] .title { font-size: 13px; }
.layer[data-size="compact"] .detail, .layer[data-size="compact"] .meta { display: none; }
.layer[data-size="compact"] .actions { grid-column: 1 / -1; justify-content: flex-start; }
.layer[data-size="compact"] button { min-height: 28px; padding: 0 10px; font-size: 12px; border-radius: 7px; }

/* Mini: just the shield as a button. */
.mini {
  display: grid; place-items: center; width: 36px; height: 36px; padding: 0; border-radius: 50%;
  color: var(--accent); background: #15181d; box-shadow: inset 0 0 0 1px rgba(255,255,255,.12), 0 4px 12px rgba(0,0,0,.4);
}
.mini svg { width: 18px; height: 18px; }

/* Chips: small corner notes that don't cover the content. */
.chip {
  display: flex; align-items: center; gap: 8px; max-width: 100%;
  padding: 5px 5px 5px 10px; border-radius: 999px;
  background: rgba(21,24,29,.92); box-shadow: inset 0 0 0 1px rgba(255,255,255,.1), 0 4px 14px rgba(0,0,0,.35);
  font-size: 12px; color: #d7dbe0;
}
.chip svg { width: 15px; height: 15px; flex: none; color: var(--accent); }
.chip.muted svg { color: #9aa3ae; }
.chip .label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.chip button { min-height: 24px; padding: 0 10px; font-size: 12px; border-radius: 999px; }
.chip .close { width: 24px; padding: 0; font-size: 15px; font-weight: 500; color: #9aa3ae; }
.chip .close:hover { background: rgba(255,255,255,.1); color: #e8eaed; }
`;

  // ─── DOM helpers ─────────────────────────────────────────────────────

  function el(tag, props, children) {
    const node = document.createElement(tag);
    if (props) {
      for (const [key, value] of Object.entries(props)) {
        if (key === 'text') node.textContent = value;
        else if (key === 'onclick') node.addEventListener('click', value);
        else node.setAttribute(key, value);
      }
    }
    if (children) for (const child of children) if (child) node.appendChild(child);
    return node;
  }

  function svg(paths) {
    const root = document.createElementNS(SVG_NS, 'svg');
    root.setAttribute('viewBox', '0 0 24 24');
    root.setAttribute('fill', 'none');
    root.setAttribute('stroke', 'currentColor');
    root.setAttribute('stroke-width', '1.8');
    root.setAttribute('stroke-linecap', 'round');
    root.setAttribute('stroke-linejoin', 'round');
    root.setAttribute('aria-hidden', 'true');
    for (const d of paths) {
      const path = document.createElementNS(SVG_NS, 'path');
      path.setAttribute('d', d);
      root.appendChild(path);
    }
    return root;
  }

  const ICONS = {
    shield: () => svg(['M12 3 5 5.8v5.6c0 4.3 2.9 7.9 7 9.6 4.1-1.7 7-5.3 7-9.6V5.8L12 3Z', 'M8.5 12.3l1.6-2.3 1.9 3.9 1.4-2.2h2.1']),
    eyeOff: () => svg(['M3 3l18 18', 'M10.6 5.1A9.8 9.8 0 0 1 12 5c5 0 8.5 4.4 9.5 7-.4 1-1.2 2.4-2.4 3.7', 'M6.4 6.5C4.6 7.8 3.2 9.7 2.5 12c1 2.6 4.5 7 9.5 7 1.7 0 3.3-.5 4.6-1.3', 'M9.9 9.9a3 3 0 0 0 4.2 4.2']),
    halfMoon: () => svg(['M12 3a9 9 0 1 0 0 18V3Z', 'M12 3a9 9 0 0 1 0 18']),
  };

  /**
   * Button whose click never reaches the page. Only real user input counts:
   * a page must not be able to press "Show anyway" on someone's behalf.
   */
  function button(label, className, onPress, attrs) {
    return el('button', Object.assign({ type: 'button', class: className, text: label }, attrs || {}, {
      onclick: (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (e.isTrusted) onPress();
      },
    }));
  }

  // ─── Styles ──────────────────────────────────────────────────────────

  let sheet = null;
  function styleSheet() {
    if (!sheet) {
      sheet = new CSSStyleSheet();
      sheet.replaceSync(STYLES);
    }
    return sheet;
  }

  // Inline !important beats every page rule; `all: initial` clears inherited oddities.
  const HOST_STYLE = [
    'all: initial', 'position: fixed', 'display: block', 'margin: 0', 'padding: 0', 'border: 0',
    'inset: auto', 'top: 0', 'left: 0', 'width: 0', 'height: 0', 'overflow: visible',
    'background: transparent', 'pointer-events: none', 'box-sizing: border-box', 'contain: layout style',
  ].map((d) => d + ' !important').join('; ');

  // ─── Where layers live ───────────────────────────────────────────────

  /** Elements that can't hold rendered children. */
  const REPLACED = new Set(['VIDEO', 'CANVAS', 'IMG', 'IFRAME', 'OBJECT', 'EMBED', 'AUDIO']);

  function shadowRootOf(el) {
    if (el.shadowRoot) return el.shadowRoot;
    try {
      return chrome.dom && chrome.dom.openOrClosedShadowRoot ? chrome.dom.openOrClosedShadowRoot(el) : null;
    } catch (_) {
      return null;
    }
  }

  /** The element that is really fullscreen, looking through shadow roots. */
  function fullscreenElement() {
    let fs = document.fullscreenElement;
    for (let depth = 0; fs && depth < 10; depth++) {
      const root = shadowRootOf(fs);
      const inner = root && root.fullscreenElement;
      if (!inner || inner === fs) break;
      fs = inner;
    }
    return fs || null;
  }

  /** The open modal <dialog> on top, if any (the last one opened is last in the top layer, usually last in the document too). */
  function topModalDialog() {
    try {
      const open = document.querySelectorAll('dialog:modal');
      return open.length ? open[open.length - 1] : null;
    } catch (_) {
      return null;
    }
  }

  /** Parent in the flat tree: through slots and out of shadow roots. */
  function flatParent(node) {
    return node.assignedSlot || node.parentElement || (node.parentNode && node.parentNode.host) || null;
  }

  function flatContains(ancestor, node) {
    for (let n = node, depth = 0; n && depth < 200; n = flatParent(n), depth++) if (n === ancestor) return true;
    return false;
  }

  /**
   * While an element is fullscreen or a modal dialog is open, Chrome makes
   * everything outside it inert: a layer outside would show but couldn't be
   * clicked. So a layer for something inside a modal dialog lives in that
   * dialog (the page cover always does), layers in fullscreen live inside the
   * fullscreen element, and on the root element otherwise.
   */
  function layerParent(element) {
    const dialog = topModalDialog();
    if (dialog && (!element || flatContains(dialog, element))) return dialog;
    const fs = fullscreenElement();
    if (fs && !REPLACED.has(fs.tagName)) return fs;
    return document.documentElement || document.body;
  }

  /**
   * The part of an element's box that isn't clipped away by scrolling or
   * overflow-hidden ancestors (an inner-scrolling pane, a carousel), in
   * viewport coordinates.
   */
  function visibleBox(el) {
    const r = el.getBoundingClientRect();
    let left = r.left;
    let top = r.top;
    let right = r.right;
    let bottom = r.bottom;
    // Overflow set on <body> moves to the viewport when <html> leaves it visible.
    const bodyScrollsViewport = document.body && getComputedStyle(document.documentElement).overflow === 'visible';
    let fixed = false;
    for (let node = flatParent(el), depth = 0; node && node !== document.documentElement && depth < 60; node = flatParent(node), depth++) {
      if (node === document.body && bodyScrollsViewport) continue;
      const style = getComputedStyle(node);
      if (fixed && style.transform === 'none' && style.contain === 'none') continue;
      if (style.overflowX !== 'visible' || style.overflowY !== 'visible') {
        const c = node.getBoundingClientRect();
        if (style.overflowX !== 'visible') {
          left = Math.max(left, c.left);
          right = Math.min(right, c.right);
        }
        if (style.overflowY !== 'visible') {
          top = Math.max(top, c.top);
          bottom = Math.min(bottom, c.bottom);
        }
      }
      if (style.position === 'fixed') fixed = true;
    }
    return { left, top, right, bottom };
  }

  /**
   * A fullscreen <video> (native controls) can't hold our UI, so leave
   * fullscreen for it to be usable. Called when protection kicks in.
   */
  function leaveUnusableFullscreen() {
    const fs = fullscreenElement();
    if (fs && REPLACED.has(fs.tagName)) document.exitFullscreen().catch(() => {});
  }

  // ─── Position tracking ───────────────────────────────────────────────

  /**
   * Keeps element-bound layers over their element. Event-driven: scroll and
   * resize schedule one update per frame, a ResizeObserver catches size
   * changes, and a slow poll catches layout shifts. Nothing runs per frame
   * while the page is still.
   */
  const tracker = {
    layers: new Set(),
    frame: 0,
    poll: 0,
    resize: null,

    add(layer) {
      if (!this.layers.size) this.start();
      this.layers.add(layer);
      if (layer.element && this.resize) this.resize.observe(layer.element);
    },

    delete(layer) {
      if (!this.layers.delete(layer)) return;
      if (layer.element && this.resize && ![...this.layers].some((l) => l.element === layer.element)) {
        this.resize.unobserve(layer.element);
      }
      if (!this.layers.size) this.stop();
    },

    start() {
      this.onScroll = () => this.schedule();
      this.onFullscreen = () => {
        for (const layer of this.layers) layer.attach(true);
        this.schedule();
      };
      window.addEventListener('scroll', this.onScroll, { capture: true, passive: true });
      window.addEventListener('resize', this.onScroll, { passive: true });
      document.addEventListener('fullscreenchange', this.onFullscreen);
      this.resize = new ResizeObserver(() => this.schedule());
      this.poll = setInterval(() => this.update(), 250);
    },

    stop() {
      window.removeEventListener('scroll', this.onScroll, { capture: true });
      window.removeEventListener('resize', this.onScroll);
      document.removeEventListener('fullscreenchange', this.onFullscreen);
      if (this.resize) this.resize.disconnect();
      this.resize = null;
      clearInterval(this.poll);
      cancelAnimationFrame(this.frame);
      this.frame = 0;
    },

    schedule() {
      if (!this.frame) this.frame = requestAnimationFrame(() => this.update());
    },

    update() {
      this.frame = 0;
      for (const layer of [...this.layers]) layer.update();
    },
  };

  // ─── Layers ──────────────────────────────────────────────────────────

  class Layer {
    /**
     * @param {string} kind used in the host's data-neuroshield-overlay attribute
     * @param {Element|null} element the element to cover, or null for the viewport
     */
    constructor(kind, element) {
      this.kind = kind;
      this.element = element;
      this.rect = '';
      this.host = document.createElement('div');
      this.host.setAttribute('data-neuroshield-overlay', kind);
      this.host.setAttribute('popover', 'manual');
      this.host.style.cssText = HOST_STYLE;
      this.root = this.host.attachShadow({ mode: 'closed' });
      this.root.adoptedStyleSheets = [styleSheet()];
      this.layer = el('div', { class: 'layer' });
      this.root.appendChild(this.layer);
      this.removed = false;
    }

    mount() {
      this.attach(true);
      tracker.add(this);
      this.update();
      return this;
    }

    /**
     * Put the host where it can be seen and clicked, and on top of the top
     * layer. `force` re-shows it even if it's already in place (an element
     * that enters fullscreen goes above everything shown before it).
     */
    attach(force) {
      const parent = layerParent(this.element);
      if (this.host.parentNode !== parent) {
        parent.appendChild(this.host);
        force = true;
      }
      if (!force && this.host.matches(':popover-open')) return;
      try {
        if (this.host.matches(':popover-open')) this.host.hidePopover();
        this.show();
      } catch (_) {
        // Not connected or popovers unsupported; the next update re-attaches.
      }
    }

    /** Open the popover; tied to the element, so Tab moves from it into the card. */
    show() {
      const source = this.element instanceof HTMLElement ? this.element : null;
      if (source) {
        try {
          this.host.showPopover({ source });
          return;
        } catch (_) {
          // older Chrome: no options
        }
      }
      this.host.showPopover();
    }

    setBox(left, top, width, height) {
      const key = `${left}|${top}|${width}|${height}`;
      if (key === this.rect) return;
      this.rect = key;
      const s = this.host.style;
      s.setProperty('left', left + 'px', 'important');
      s.setProperty('top', top + 'px', 'important');
      s.setProperty('width', width + 'px', 'important');
      s.setProperty('height', height + 'px', 'important');
    }

    update() {
      if (this.removed) return;
      // The page may have removed, moved or closed the host (some UI
      // libraries close every popover on navigation).
      if (!this.host.isConnected || this.host.parentNode !== layerParent(this.element)) this.attach(true);
      else if (!this.host.matches(':popover-open')) this.attach(true);
      // CSS zoom on the page scales the host's coordinates too.
      const zoom = this.host.currentCSSZoom || 1;
      if (!this.element) {
        this.setBox(0, 0, Math.round(window.innerWidth / zoom), Math.round(window.innerHeight / zoom));
        return;
      }
      if (!this.element.isConnected) {
        this.setBox(0, 0, 0, 0);
        return;
      }
      const r = visibleBox(this.element);
      const left = Math.max(0, r.left);
      const top = Math.max(0, r.top);
      const width = Math.max(0, Math.min(window.innerWidth, r.right) - left);
      const height = Math.max(0, Math.min(window.innerHeight, r.bottom) - top);
      if (width < 2 || height < 2) {
        this.setBox(0, 0, 0, 0);
        return;
      }
      this.setBox(Math.round(left / zoom), Math.round(top / zoom), Math.round(width / zoom), Math.round(height / zoom));
      this.layout(width / zoom, height / zoom);
    }

    /** Hook for layers that adapt to their size. */
    layout() {}

    remove() {
      if (this.removed) return;
      this.removed = true;
      tracker.delete(this);
      try {
        this.host.hidePopover();
      } catch (_) {
        // already hidden
      }
      this.host.remove();
    }
  }

  function describe(info) {
    const subject = info.kind === 'video' ? 'This video' : 'This animation';
    if (info.isRedFlash) return `${subject} has rapid red flashes.`;
    const n = Math.round(info.flashesPerSecond || 0);
    if (n < 2) return `${subject} flashes about once per second.`;
    return `${subject} flashes about ${n} times per second.`;
  }

  /** Card shown over a blacked-out video or canvas, or next to a paused animation. */
  class BlockLayer extends Layer {
    constructor(element, info, actions) {
      super('block', element);
      const isAnimation = info.kind === 'animation';
      const title = isAnimation ? 'Flashing animation paused' : 'Flashing content hidden';
      const meta = [info.paused ? 'Video paused' : '', `${LEVEL_NAMES[info.sensitivity] || 'Medium'} sensitivity`]
        .filter(Boolean)
        .join(' · ');

      const buttons = isAnimation
        ? [button('Resume animation', 'secondary', actions.anyway)]
        : [button('Show dimmed', 'primary', actions.dimmed), button('Show anyway', 'secondary', actions.anyway)];

      this.card = el('div', { class: 'card', role: 'dialog', 'aria-label': 'NeuroShield' }, [
        el('div', { class: 'badge' }, [ICONS.shield()]),
        el('div', { class: 'text' }, [
          el('p', { class: 'title', role: 'alert', text: title }),
          el('p', { class: 'detail', text: describe(info) }),
          el('p', { class: 'meta', text: meta }),
        ]),
        el('div', { class: 'actions' }, buttons),
      ]);
      this.mini = button('', 'mini', isAnimation ? actions.anyway : actions.dimmed, {
        'aria-label': `${title}. ${isAnimation ? 'Resume animation' : 'Show dimmed'}`,
        title: title,
      });
      this.mini.appendChild(ICONS.shield());
      this.size = '';
    }

    layout(width, height) {
      // The full card is ~212 px tall and the compact one ~92 px, plus padding.
      const size = width >= 320 && height >= 240 ? 'full' : width >= 180 && height >= 112 ? 'compact' : 'mini';
      if (size === this.size) return;
      this.size = size;
      this.layer.setAttribute('data-size', size);
      this.layer.replaceChildren(size === 'mini' ? this.mini : this.card);
    }

    /** Move keyboard focus to the first action (used when the element is fullscreen). */
    focus() {
      const target = this.size === 'mini' ? this.mini : this.card.querySelector('button');
      if (target) target.focus({ preventScroll: true });
    }
  }

  /** Corner chip: dimmed state, or a note that the element can't be scanned. */
  class ChipLayer extends Layer {
    constructor(kind, element, chip) {
      super(kind, element);
      this.layer.setAttribute('data-place', 'corner');
      this.layer.appendChild(chip);
    }
  }

  function dimmedChip(element, actions) {
    const chip = el('div', { class: 'chip', role: 'status' }, [
      ICONS.halfMoon(),
      el('span', { class: 'label', text: 'Dimmed by NeuroShield' }),
      button('Show original', 'secondary', actions.restore),
    ]);
    return new ChipLayer('dimmed', element, chip).mount();
  }

  function noticeChip(element, reason, actions) {
    const text = reason === 'protected' ? "Can't scan protected video" : "Can't scan this video";
    const chip = el('div', { class: 'chip muted', role: 'status', title: 'NeuroShield can only analyze videos the page is allowed to read. Dimming lowers the risk if it flashes.' }, [
      ICONS.shield(),
      el('span', { class: 'label', text }),
      button('Dim', 'secondary', actions.dim),
      button('×', 'close', actions.dismiss, { 'aria-label': 'Dismiss' }),
    ]);
    return new ChipLayer('notice', element, chip).mount();
  }

  /** Opaque cover over the whole viewport ("hide everything on this page"). */
  function pageShield(actions) {
    leaveUnusableFullscreen();
    const layer = new Layer('page', null);
    layer.layer.classList.add('page');
    layer.layer.appendChild(
      el('div', { class: 'card', role: 'dialog', 'aria-label': 'NeuroShield' }, [
        el('div', { class: 'badge' }, [ICONS.eyeOff()]),
        el('div', { class: 'text' }, [
          el('p', { class: 'title', role: 'alert', text: 'Page hidden' }),
          el('p', { class: 'detail', text: 'Videos and animations on this page are paused.' }),
        ]),
        el('div', { class: 'actions' }, [button('Show page', 'primary', actions.show)]),
      ]),
    );
    layer.host.style.setProperty('pointer-events', 'auto', 'important');
    layer.mount();
    const first = layer.layer.querySelector('button');
    if (first) first.focus({ preventScroll: true });
    return layer;
  }

  function block(element, info, actions) {
    leaveUnusableFullscreen();
    const layer = new BlockLayer(element, info, actions).mount();
    if (fullscreenElement()) layer.focus();
    return layer;
  }

  /** Remove every layer this script created (used on teardown). */
  function removeAll() {
    for (const layer of [...tracker.layers]) layer.remove();
  }

  return Object.freeze({ block, dimmedChip, noticeChip, pageShield, removeAll });
})();
