// The extension's service worker: a starting point. Chrome starts it when the extension needs it and stops it when
// idle, so keep no state in variables: use chrome.storage (the storage permission) for anything that must last.
// Network calls go only through productAction() from ./platform.js.

chrome.runtime.onInstalled.addListener(() => {
  // With the contextMenus permission, add a right-click item for selected text here, for example
  //   chrome.contextMenus.create({ id: "send-selection", title: "Send to the product", contexts: ["selection"] });
  // and handle chrome.contextMenus.onClicked below, where info.selectionText is the selected text.
});

export {};
