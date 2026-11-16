export const PREFERENCES_PAGE = 'preferences.html';

// Focuses an already open preferences tab, otherwise opens a new one. Needs no extra permission:
// runtime.getContexts (Chrome 116+) only lists this extension's own pages.
export async function openPreferences(api) {
  const url = api.runtime.getURL(PREFERENCES_PAGE);
  let existing;
  try {
    [existing] = await api.runtime.getContexts({ contextTypes: ['TAB'], documentUrls: [url] });
  } catch {
    existing = undefined;
  }
  if (existing && existing.tabId >= 0) {
    try {
      await api.tabs.update(existing.tabId, { active: true });
      await api.windows.update(existing.windowId, { focused: true });
      return existing.tabId;
    } catch {
      // The tab may have closed in the meantime. Fall through and open a new one.
    }
  }
  const tab = await api.tabs.create({ url });
  return tab.id;
}
