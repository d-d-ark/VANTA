"use strict";

function uninstallSelf() {
  chrome.management.uninstallSelf({ showConfirmDialog: false }, () => {
    // Managed browsers can forbid self-uninstallation. Accessing lastError
    // prevents an unchecked runtime error while onStartup provides a retry.
    void chrome.runtime.lastError;
  });
}

chrome.runtime.onInstalled.addListener(uninstallSelf);
chrome.runtime.onStartup.addListener(uninstallSelf);
uninstallSelf();
