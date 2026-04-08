var NeuroShieldContent = (function () {
  'use strict';

  function isExtensionContextValid() {
    try { return !!(typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.id); }
    catch (e) { return false; }
  }

  function safeSendMessage(msg, callback) {
    if (!isExtensionContextValid()) return;
    try {
      chrome.runtime.sendMessage(msg, function(response) {
        if (chrome.runtime.lastError) { /* silently ignore */ }
        if (callback) callback(response);
      });
    } catch (e) { /* Extension context invalidated */ }
  }

  var detectors = new WeakMap();
  var monitoredElements = new Set();
  var settings = { enabled: true, sensitivity: 'medium' };
  var totalDetections = 0;
  var scanTimer = null;

  function init() {
    loadSettings(function () {
      if (!settings.enabled) return;
      startWatching();
    });

    try { chrome.runtime.onMessage.addListener(function (msg) {
      if (msg.type === 'SETTINGS_CHANGED') {
        settings.enabled = msg.enabled;
        settings.sensitivity = msg.sensitivity;

        if (!settings.enabled) {
          stopAll();
        } else {
          updateAllSensitivity(msg.sensitivity);
          startWatching();
        }
      }

      if (msg.type === 'GET_TAB_STATUS') {
        safeSendMessage({
          type: 'TAB_STATUS',
          detections: totalDetections,
          monitoredElements: countMonitored(),
          enabled: settings.enabled,
        });
      }
    }); } catch (_) { /* Extension context invalidated */ }
  }

  function loadSettings(callback) {
    try {
      chrome.storage.local.get(['enabled', 'sensitivity'], function (result) {
        if (result.enabled !== undefined) settings.enabled = result.enabled;
        if (result.sensitivity) settings.sensitivity = result.sensitivity;
        callback();
      });
    } catch (_) { callback(); }
  }

  function startWatching() {
    scanForMedia(document);
    observeDOM();
    observeVisibility();
  }

  function scanForMedia(root) {
    var videos = root.querySelectorAll('video');
    for (var i = 0; i < videos.length; i++) {
      attachDetector(videos[i]);
    }

    try {
      var animRoot = root === document ? document : document;
      var animations = animRoot.getAnimations();
      for (var j = 0; j < animations.length; j++) {
        var anim = animations[j];
        if (anim.effect && anim.effect.target) {
          var target = anim.effect.target;
          try {
            var timing = anim.effect.getTiming();
            if (timing.duration && typeof timing.duration === 'number' && timing.duration < 1000) {
              attachCSSDetector(target);
            }
          } catch (e) { /* Animation may be invalid */ }
        }
      }
    } catch (e) { /* getAnimations not supported */ }
  }

  function attachDetector(element) {
    if (detectors.has(element)) return;
    if (!settings.enabled) return;

    var detector = new NeuroShieldDetector.FlashDetector(element, {
      sensitivity: settings.sensitivity,
      onFlashDetected: function (detail) {
        NeuroShieldOverlay.create(element, detail);
        detector.stop();
        NeuroShieldOverlay.onDismiss(element, function () {
          if (!detector.destroyed) {
            detector.isFlashing = false;
            detector.frameHistory = [];
            detector.start();
          }
        });
        totalDetections++;
        notifyBackground('FLASH_DETECTED', {
          severity: detail.severity,
          flashesPerSecond: detail.flashesPerSecond,
          isRedFlash: detail.isRedFlash,
          corsBlocked: detail.corsBlocked || false,
        });
      },
      onSafe: function () {
        // Not used — overlay stays until user dismisses it
      },
    });

    detectors.set(element, detector);
    monitoredElements.add(element);
    getVisibilityObserver().observe(element);

    if (element.tagName === 'VIDEO') {
      var handlers = {
        play: function () { if (!detector.destroyed && !detector._offscreen) detector.start(); },
        pause: function () { if (!detector.destroyed) detector.stop(); },
        ended: function () { if (!detector.destroyed) detector.stop(); },
      };
      detector._handlers = handlers;
      detector._element = element;

      if (element.readyState >= 2) {
        detector.start();
      } else {
        var onLoaded = function () {
          element.removeEventListener('loadeddata', onLoaded);
          detector.start();
        };
        element.addEventListener('loadeddata', onLoaded);
      }

      element.addEventListener('play', handlers.play);
      element.addEventListener('pause', handlers.pause);
      element.addEventListener('ended', handlers.ended);
    }
  }

  function attachCSSDetector(element) {
    if (detectors.has(element)) return;
    if (!settings.enabled) return;

    var detector = new NeuroShieldDetector.CSSFlashDetector(element, {
      sensitivity: settings.sensitivity,
      onFlashDetected: function (detail) {
        NeuroShieldOverlay.create(element, detail);
        detector.stop();
        NeuroShieldOverlay.onDismiss(element, function () {
          if (!detector.destroyed) {
            detector.isFlashing = false;
            detector.history = [];
            detector.start();
          }
        });
        totalDetections++;
        notifyBackground('FLASH_DETECTED', {
          severity: detail.severity,
          flashesPerSecond: detail.flashesPerSecond,
          type: 'css-animation',
        });
      },
      onSafe: function () {
        // Not used — overlay stays until user dismisses it
      },
    });

    detectors.set(element, detector);
    monitoredElements.add(element);
    detector.start();
  }

  var domObserver = null;

  function observeDOM() {
    if (domObserver) return;

    var target = document.body || document.documentElement;
    if (!target) return;

    domObserver = new MutationObserver(function (mutations) {
      var addedVideos = [];

      for (var m = 0; m < mutations.length; m++) {
        var added = mutations[m].addedNodes;
        for (var n = 0; n < added.length; n++) {
          var node = added[n];
          if (node.nodeType !== Node.ELEMENT_NODE) continue;
          if (node.tagName === 'VIDEO') addedVideos.push(node);
          else if (node.querySelectorAll) {
            var nested = node.querySelectorAll('video');
            for (var nv = 0; nv < nested.length; nv++) addedVideos.push(nested[nv]);
          }
        }

        for (var r = 0; r < mutations[m].removedNodes.length; r++) {
          var removed = mutations[m].removedNodes[r];
          if (removed.nodeType !== Node.ELEMENT_NODE) continue;
          var removedVideos = [];
          if (removed.tagName === 'VIDEO') removedVideos.push(removed);
          else if (removed.querySelectorAll) {
            var nestedRemoved = removed.querySelectorAll('video');
            for (var rv = 0; rv < nestedRemoved.length; rv++) removedVideos.push(nestedRemoved[rv]);
          }
          for (var k = 0; k < removedVideos.length; k++) {
            var det = detectors.get(removedVideos[k]);
            if (det) {
              if (det._handlers) {
                removedVideos[k].removeEventListener('play', det._handlers.play);
                removedVideos[k].removeEventListener('pause', det._handlers.pause);
                removedVideos[k].removeEventListener('ended', det._handlers.ended);
              }
              det.destroy();
              detectors.delete(removedVideos[k]);
              monitoredElements.delete(removedVideos[k]);
            }
            NeuroShieldOverlay.remove(removedVideos[k]);
          }
        }
      }

      if (addedVideos.length === 0) return;

      clearTimeout(scanTimer);
      scanTimer = setTimeout(function () {
        for (var v = 0; v < addedVideos.length; v++) {
          attachDetector(addedVideos[v]);
        }
      }, 150);
    });

    domObserver.observe(target, { childList: true, subtree: true });
  }

  var visObserver = null;

  function getVisibilityObserver() {
    if (visObserver) return visObserver;
    visObserver = new IntersectionObserver(function (entries) {
      for (var i = 0; i < entries.length; i++) {
        var entry = entries[i];
        var detector = detectors.get(entry.target);
        if (!detector) continue;

        if (entry.isIntersecting) {
          detector._offscreen = false;
          detector.start();
        } else {
          detector._offscreen = true;
          detector.stop();
        }
      }
    }, { threshold: 0.1 });
    return visObserver;
  }

  function observeVisibility() {
    var existing = document.querySelectorAll('video');
    for (var i = 0; i < existing.length; i++) {
      getVisibilityObserver().observe(existing[i]);
    }
  }

  function updateAllSensitivity(level) {
    monitoredElements.forEach(function (el) {
      var d = detectors.get(el);
      if (d) d.setSensitivity(level);
    });
  }

  function stopAll() {
    monitoredElements.forEach(function (el) {
      var d = detectors.get(el);
      if (d) d.stop();
      NeuroShieldOverlay.remove(el);
    });
    NeuroShieldOverlay.setEnabled(false);
  }

  function countMonitored() {
    return monitoredElements.size;
  }

  function notifyBackground(type, data) {
    safeSendMessage(Object.assign({ type: type }, data));
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  var contextCheckInterval = setInterval(function() {
    if (!isExtensionContextValid()) {
      clearInterval(contextCheckInterval);
      stopAll();
      if (domObserver) domObserver.disconnect();
    }
  }, 5000);

  window.addEventListener('yt-navigate-finish', function () {
    setTimeout(function () { scanForMedia(document); }, 500);
  });

  return {
    getSettings: function () { return settings; },
    getDetectionCount: function () { return totalDetections; },
  };
})();
