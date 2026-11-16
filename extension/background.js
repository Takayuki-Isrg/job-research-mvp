import { captureJob, reviseJob } from './workflow.js';
import { openPreferences } from './open-preferences.js';

let menuRegistration;

function registerMenu() {
  // Installation and startup can overlap. Share the entire remove/create operation.
  if (!menuRegistration) {
    menuRegistration = (async () => {
      // Callbacks also work on the minimum supported Chrome version (116).
      await new Promise((resolve, reject) => {
        chrome.contextMenus.removeAll(() => {
          const error = chrome.runtime.lastError;
          if (error) reject(new Error(error.message));
          else resolve();
        });
      });
      await new Promise((resolve, reject) => {
        chrome.contextMenus.create(
          {
            id: 'inspect-job',
            title: 'この求人を調べる',
            contexts: ['page', 'selection', 'link', 'image'],
            documentUrlPatterns: ['http://*/*', 'https://*/*'],
          },
          () => {
            const error = chrome.runtime.lastError;
            if (error) reject(new Error(error.message));
            else resolve();
          },
        );
      });
    })().finally(() => {
      menuRegistration = undefined;
    });
  }
  return menuRegistration;
}

chrome.runtime.onInstalled.addListener(() => {
  registerMenu().catch(console.error);
});
chrome.runtime.onStartup.addListener(() => {
  registerMenu().catch(console.error);
});
// 右クリックメニューから求人情報を取得する
chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === 'inspect-job') captureJob(chrome, tab, info.pageUrl).catch(console.error);
});

// ツールバーアイコンの左クリックで希望条件の管理画面を開く（開いていれば前面に出す）
chrome.action.onClicked.addListener(() => {
  openPreferences(chrome).catch(console.error);
});

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (
    sender.id !== chrome.runtime.id ||
    !sender.url?.startsWith(chrome.runtime.getURL('review.html')) ||
    message?.type !== 'revise'
  )
    return false;

  reviseJob(chrome, message.id, message.overrides)
    .then((record) => respond({ ok: true, record }))
    .catch((error) => respond({ ok: false, error: error.message }));
  return true;
});

// Results belong to their review tab and never become a permanent browsing history.
chrome.tabs.onRemoved.addListener(async (tabId) => {
  try {
    const all = await chrome.storage.session.get(null);
    const keys = Object.entries(all)
      .filter(([key, value]) => key.startsWith('job:') && value.reviewTabId === tabId)
      .map(([key]) => key);
    if (keys.length) await chrome.storage.session.remove(keys);
  } catch (error) {
    console.error(error);
  }
});
