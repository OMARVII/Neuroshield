(function () {
  'use strict';

  var viewMain = document.getElementById('viewMain');
  var viewAbout = document.getElementById('viewAbout');
  var infoBtn = document.getElementById('infoBtn');
  var backBtn = document.getElementById('backBtn');
  var aboutVersion = document.getElementById('aboutVersion');

  var enableToggle = document.getElementById('enableToggle');
  var statusEl = document.getElementById('status');
  var statusText = document.getElementById('statusText');
  var sensitivityBtns = document.querySelectorAll('.sens-btn');
  var detectionCount = document.getElementById('detectionCount');
  var monitoredCount = document.getElementById('monitoredCount');

  var currentSettings = { enabled: true, sensitivity: 'medium' };

  function safeSend(msg, callback) {
    try {
      chrome.runtime.sendMessage(msg, function (response) {
        if (chrome.runtime.lastError) return;
        if (callback) callback(response);
      });
    } catch (e) { /* Popup context may close */ }
  }

  function showAbout() {
    viewMain.classList.add('hidden');
    viewAbout.classList.remove('hidden');
  }

  function showMain() {
    viewAbout.classList.add('hidden');
    viewMain.classList.remove('hidden');
  }

  infoBtn.addEventListener('click', showAbout);
  backBtn.addEventListener('click', showMain);

  try {
    var manifest = chrome.runtime.getManifest();
    aboutVersion.textContent = 'v' + manifest.version;
  } catch (e) { /* Version unavailable */ }

  function init() {
    safeSend({ type: 'GET_SETTINGS' }, function (response) {
      if (!response) return;
      currentSettings = response;
      render();
    });

    safeSend({ type: 'GET_STATS' }, function (stats) {
      if (stats && stats.totalDetections !== undefined) {
        detectionCount.textContent = stats.totalDetections;
      }
    });

    try {
      chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
        if (chrome.runtime.lastError) return;
        if (tabs[0] && tabs[0].id) {
          try {
            chrome.tabs.sendMessage(
              tabs[0].id,
              { type: 'GET_TAB_STATUS' },
              function (response) {
                if (chrome.runtime.lastError) return;
                if (response) {
                  detectionCount.textContent = response.detections || 0;
                  monitoredCount.textContent = response.monitoredElements || 0;
                }
              }
            );
          } catch (e) { /* Tab may not have content script */ }
        }
      });
    } catch (e) { /* Tabs API may be unavailable */ }
  }

  function render() {
    enableToggle.checked = currentSettings.enabled;

    if (currentSettings.enabled) {
      statusEl.classList.remove('inactive');
      statusText.textContent = 'Active';
    } else {
      statusEl.classList.add('inactive');
      statusText.textContent = 'Disabled';
    }

    for (var i = 0; i < sensitivityBtns.length; i++) {
      var btn = sensitivityBtns[i];
      if (btn.getAttribute('data-value') === currentSettings.sensitivity) {
        btn.classList.add('active');
      } else {
        btn.classList.remove('active');
      }
    }
  }

  function saveSettings() {
    safeSend({
      type: 'SET_SETTINGS',
      enabled: currentSettings.enabled,
      sensitivity: currentSettings.sensitivity,
    });
    render();
  }

  enableToggle.addEventListener('change', function () {
    currentSettings.enabled = enableToggle.checked;
    saveSettings();
  });

  for (var i = 0; i < sensitivityBtns.length; i++) {
    sensitivityBtns[i].addEventListener('click', function () {
      currentSettings.sensitivity = this.getAttribute('data-value');
      saveSettings();
    });
  }

  try {
    chrome.runtime.onMessage.addListener(function (msg) {
      if (msg.type === 'TAB_STATUS') {
        detectionCount.textContent = msg.detections || 0;
        monitoredCount.textContent = msg.monitoredElements || 0;
      }
    });
  } catch (e) { /* Listener registration may fail */ }

  init();
})();
