/**
 * background.js — MV3 service worker
 *
 * PHASE 2 SEAM: Google Tasks auth/polling would live here. On extension
 * startup, if a stored OAuth token exists, begin a sync polling loop and
 * merge remote todos into local storage via lib/storage.js with source: 'google'.
 */

// Open the side panel when the user clicks the toolbar icon.
chrome.action.onClicked.addListener((tab) => {
  chrome.sidePanel.open({ windowId: tab.windowId });
});

// Relay TOODLY_OPEN_PANEL from content scripts (which can't call sidePanel.open
// directly — they have no windowId context).
chrome.runtime.onMessage.addListener((message, sender) => {
  if (message.type === 'TOODLY_OPEN_PANEL' && sender.tab?.windowId) {
    chrome.sidePanel.open({ windowId: sender.tab.windowId });
  }
});
