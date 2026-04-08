(function () {
  'use strict';

  var DEFAULT_SETTINGS = {
    enabled: true,
    sensitivity: 'medium',
  };

  chrome.runtime.onInstalled.addListener(function () {
    chrome.storage.local.get(['enabled', 'sensitivity'], function (result) {
      if (result.enabled === undefined) {
        chrome.storage.local.set(DEFAULT_SETTINGS);
      }
    });
    chrome.action.setBadgeBackgroundColor({ color: '#22c55e' });
    chrome.action.setBadgeText({ text: 'ON' });
    chrome.storage.session.set({ installTime: Date.now() });
  });

  chrome.runtime.onStartup.addListener(function() {
    chrome.storage.local.get(['enabled'], function(result) {
      var text = result.enabled !== false ? 'ON' : 'OFF';
      var color = result.enabled !== false ? '#22c55e' : '#6b7280';
      chrome.action.setBadgeText({ text: text });
      chrome.action.setBadgeBackgroundColor({ color: color });
    });
  });

  chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
    try {
      var tabId = sender.tab ? sender.tab.id : null;

      switch (msg.type) {
        case 'FLASH_DETECTED':
          if (!tabId) break;
          var badgeText = msg.severity === 'danger' ? '!!' : '!';
          var badgeColor = msg.severity === 'danger' ? '#ef4444' : '#f59e0b';
          chrome.action.setBadgeText({ text: badgeText, tabId: tabId });
          chrome.action.setBadgeBackgroundColor({ color: badgeColor, tabId: tabId });
          chrome.storage.session.set({
            ['badge_' + tabId]: { text: badgeText, color: badgeColor }
          });

          chrome.storage.local.get(['stats'], function (result) {
            var stats = result.stats || { totalDetections: 0, sessionsProtected: 0 };
            stats.totalDetections++;
            chrome.storage.local.set({ stats: stats });
          });
          break;

        case 'TAB_STATUS':
          break;

        case 'GET_SETTINGS':
          chrome.storage.local.get(['enabled', 'sensitivity'], function (result) {
            sendResponse({
              enabled: result.enabled !== undefined ? result.enabled : true,
              sensitivity: result.sensitivity || 'medium',
            });
          });
          return true;

        case 'SET_SETTINGS':
          chrome.storage.local.set({
            enabled: msg.enabled,
            sensitivity: msg.sensitivity,
          }, function () {
            if (msg.enabled) {
              chrome.action.setBadgeText({ text: 'ON' });
              chrome.action.setBadgeBackgroundColor({ color: '#22c55e' });
            } else {
              chrome.action.setBadgeText({ text: 'OFF' });
              chrome.action.setBadgeBackgroundColor({ color: '#6b7280' });
            }

            try {
              chrome.tabs.query({}, function (tabs) {
                for (var i = 0; i < tabs.length; i++) {
                  if (!tabs[i].id || !tabs[i].url || tabs[i].url.startsWith('chrome')) continue;
                  try {
                    chrome.tabs.sendMessage(tabs[i].id, {
                      type: 'SETTINGS_CHANGED',
                      enabled: msg.enabled,
                      sensitivity: msg.sensitivity,
                    });
                  } catch (e) { /* Tab may not have content script */ }
                }
              });
            } catch (e) { /* Tabs query may fail */ }

            sendResponse({ success: true });
          });
          return true;

        case 'GET_STATS':
          chrome.storage.local.get(['stats'], function (result) {
            sendResponse(result.stats || { totalDetections: 0 });
          });
          return true;
      }
    } catch (e) {
      console.warn('NeuroShield background error:', e);
    }
  });

  chrome.runtime.onConnect.addListener(function(port) {
    if (port.name === 'neuroshield-health') {
      port.onDisconnect.addListener(function() {
      });
    }
  });

  chrome.tabs.onActivated.addListener(function (activeInfo) {
    chrome.storage.session.get(['badge_' + activeInfo.tabId], function (session) {
      var saved = session['badge_' + activeInfo.tabId];
      if (saved) {
        chrome.action.setBadgeText({ text: saved.text, tabId: activeInfo.tabId });
        chrome.action.setBadgeBackgroundColor({ color: saved.color, tabId: activeInfo.tabId });
      } else {
        chrome.storage.local.get(['enabled'], function (result) {
          var text = result.enabled !== false ? 'ON' : 'OFF';
          var color = result.enabled !== false ? '#22c55e' : '#6b7280';
          chrome.action.setBadgeText({ text: text, tabId: activeInfo.tabId });
          chrome.action.setBadgeBackgroundColor({ color: color, tabId: activeInfo.tabId });
        });
      }
    });
  });
})();
