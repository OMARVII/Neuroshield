var NeuroShieldOverlay = (function () {
  'use strict';

  var overlays = new WeakMap();
  var dismissCallbacks = new WeakMap();
  var enabled = true;

  function create(element, detail) {
    if (!enabled) return;
    if (overlays.has(element)) return;

    var rect = element.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;

    var wrapper = document.createElement('div');
    var abortCtrl = new AbortController();
    var signal = abortCtrl.signal;

    wrapper.className = 'neuroshield-overlay';
    wrapper.setAttribute('data-severity', detail.severity || 'warning');

    if (detail.corsBlocked) {
      wrapper.setAttribute('data-severity', 'cors');
    }

    wrapper.setAttribute('role', 'alertdialog');
    wrapper.setAttribute('aria-label', 'NeuroShield: Flashing content detected');
    wrapper.setAttribute('aria-live', 'assertive');
    wrapper.setAttribute('tabindex', '-1');

    wrapper.addEventListener('keydown', function(e) {
      if (e.key === 'Escape') {
        e.stopPropagation();
        remove(element);
      }
    }, { signal: signal });

    var shield = document.createElement('div');
    shield.className = 'neuroshield-shield';

    var badge = document.createElement('div');
    badge.className = 'neuroshield-badge';

    var icon = document.createElement('span');
    icon.className = 'neuroshield-icon';
    icon.textContent = detail.corsBlocked ? '\u26A0' : '\u26A1';

    var title = document.createElement('span');
    title.className = 'neuroshield-title';

    if (detail.corsBlocked) {
      title.textContent = 'Limited protection (cross-origin video)';
    } else if (detail.isRedFlash) {
      title.textContent = 'Red flash detected — high seizure risk';
    } else if (detail.severity === 'danger') {
      title.textContent = 'Dangerous flashing detected (' + detail.flashesPerSecond + '/sec)';
    } else {
      title.textContent = 'Flashing content detected (' + detail.flashesPerSecond + '/sec)';
    }

    badge.appendChild(icon);
    badge.appendChild(title);

    var actions = document.createElement('div');
    actions.className = 'neuroshield-actions';

    if (!detail.corsBlocked) {
      var dimBtn = document.createElement('button');
      dimBtn.className = 'neuroshield-btn neuroshield-btn-dim';
      dimBtn.textContent = 'Dim';
      dimBtn.setAttribute('aria-label', 'Dim flashing content');
      dimBtn.addEventListener('click', function (e) {
        e.stopPropagation();
        element.style.filter = 'brightness(0.3)';
        shield.style.display = 'none';
        badge.setAttribute('data-mode', 'dimmed');
        title.textContent = 'Dimmed — click to restore';
      });

      var pauseBtn = document.createElement('button');
      pauseBtn.className = 'neuroshield-btn neuroshield-btn-pause';
      pauseBtn.textContent = 'Pause';
      pauseBtn.setAttribute('aria-label', 'Pause video');
      pauseBtn.addEventListener('click', function (e) {
        e.stopPropagation();
        if (element.tagName === 'VIDEO' && !element.paused) {
          element.pause();
          badge.setAttribute('data-mode', 'paused');
          title.textContent = 'Paused for safety';
          shield.style.display = 'none';
        }
      });

      var dismissBtn = document.createElement('button');
      dismissBtn.className = 'neuroshield-btn neuroshield-btn-dismiss';
      dismissBtn.textContent = 'Continue';
      dismissBtn.setAttribute('aria-label', 'Dismiss warning and continue watching');
      dismissBtn.addEventListener('click', function (e) {
        e.stopPropagation();
        remove(element);
      });

      actions.appendChild(dimBtn);
      if (element.tagName === 'VIDEO') {
        actions.appendChild(pauseBtn);
      }
      actions.appendChild(dismissBtn);
    } else {
      var corsNote = document.createElement('span');
      corsNote.className = 'neuroshield-cors-note';
      corsNote.textContent = 'Cannot analyze this video (cross-origin). Apply a protective filter?';
      actions.appendChild(corsNote);

      var corsProtect = document.createElement('button');
      corsProtect.className = 'neuroshield-btn neuroshield-btn-dim';
      corsProtect.textContent = 'Protect';
      corsProtect.setAttribute('aria-label', 'Apply protective brightness filter to cross-origin video');
      corsProtect.addEventListener('click', function (e) {
        e.stopPropagation();
        element.style.filter = 'brightness(0.7) contrast(0.9)';
        shield.style.display = 'none';
        badge.setAttribute('data-mode', 'protected');
        title.textContent = 'Protective filter applied';
      });
      actions.appendChild(corsProtect);

      var corsDismiss = document.createElement('button');
      corsDismiss.className = 'neuroshield-btn neuroshield-btn-dismiss';
      corsDismiss.textContent = 'Dismiss';
      corsDismiss.setAttribute('aria-label', 'Dismiss cross-origin warning');
      corsDismiss.addEventListener('click', function (e) {
        e.stopPropagation();
        remove(element);
      });
      actions.appendChild(corsDismiss);
    }

    wrapper.appendChild(shield);
    wrapper.appendChild(badge);
    wrapper.appendChild(actions);

    positionOverlay(wrapper, element);
    document.body.appendChild(wrapper);
    wrapper.focus();
    overlays.set(element, { wrapper: wrapper, abort: abortCtrl, observer: null });

    trackPosition(wrapper, element);

    document.addEventListener('fullscreenchange', function () {
      if (!overlays.has(element)) {
        abortCtrl.abort();
        return;
      }
      var fullscreenEl = document.fullscreenElement;
      if (fullscreenEl && (fullscreenEl === element || fullscreenEl.contains(element))) {
        fullscreenEl.appendChild(wrapper);
      } else if (wrapper.parentNode !== document.body) {
        document.body.appendChild(wrapper);
      }
      positionOverlay(wrapper, element);
    }, { signal: signal });

    if (element.tagName === 'VIDEO') {
      element.addEventListener('enterpictureinpicture', function() {
        wrapper.style.display = 'none';
      }, { signal: signal });
      element.addEventListener('leavepictureinpicture', function() {
        if (overlays.has(element)) {
          wrapper.style.display = '';
          positionOverlay(wrapper, element);
        }
      }, { signal: signal });
    }
  }

  function remove(element) {
    var entry = overlays.get(element);
    if (entry) {
      entry.abort.abort();
      entry.wrapper.remove();
      overlays.delete(element);
      element.style.filter = '';

      var cb = dismissCallbacks.get(element);
      if (cb) {
        dismissCallbacks.delete(element);
        cb();
      }
    }
  }

  function onDismiss(element, callback) {
    dismissCallbacks.set(element, callback);
  }

  function positionOverlay(wrapper, element) {
    var rect = element.getBoundingClientRect();
    wrapper.style.position = 'fixed';
    wrapper.style.top = rect.top + 'px';
    wrapper.style.left = rect.left + 'px';
    wrapper.style.width = rect.width + 'px';
    wrapper.style.height = rect.height + 'px';
    wrapper.style.zIndex = '2147483646';
  }

  function trackPosition(wrapper, element) {
    var frameId = null;
    function update() {
      if (!document.body.contains(wrapper)) {
        cancelAnimationFrame(frameId);
        return;
      }
      if (!overlays.has(element)) return;
      positionOverlay(wrapper, element);
      frameId = requestAnimationFrame(update);
    }
    frameId = requestAnimationFrame(update);

    var observer = new MutationObserver(function () {
      if (!overlays.has(element) || !document.body.contains(element)) {
        cancelAnimationFrame(frameId);
        if (overlays.has(element)) remove(element);
        observer.disconnect();
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }

  function setEnabled(value) {
    enabled = value;
  }

  function isEnabled() {
    return enabled;
  }

  return {
    create: create,
    remove: remove,
    onDismiss: onDismiss,
    setEnabled: setEnabled,
    isEnabled: isEnabled,
  };
})();
