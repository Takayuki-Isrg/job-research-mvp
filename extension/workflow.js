import { extractPage } from './extract-page.js';
import { classify, sanitizeOverrides } from './classify.js';

export const keyFor = (id) => `job:${id}`;

export async function captureJob(api, tab, pageUrl) {
  const id = crypto.randomUUID();
  const key = keyFor(id);
  const sourceUrl = pageUrl || tab?.url || '';
  let record = { id, status: 'loading', sourceUrl, createdAt: new Date().toISOString(), overrides: {} };

  let changed = false;
  const updated = (tabId, change) => {
    if (tabId === tab?.id && (change.status === 'loading' || change.url)) changed = true;
  };
  const removed = (tabId) => {
    if (tabId === tab?.id) changed = true;
  };
  api.tabs.onUpdated.addListener(updated);
  api.tabs.onRemoved.addListener(removed);

  try {
    await api.storage.session.set({ [key]: record });
    const review = await api.tabs.create({ url: api.runtime.getURL(`review.html?id=${id}`) });
    record.reviewTabId = review.id;
    await api.storage.session.set({ [key]: record });
    if (!tab?.id || !/^https?:\/\//i.test(sourceUrl))
      throw new Error('HTTP(S)のHTMLページで実行してください。Chrome内部ページ・PDF等は対象外です。');

    const before = await api.tabs.get(tab.id);
    if (before.url !== sourceUrl || before.status === 'loading' || changed)
      throw new Error('元のページが移動中または変更されました。表示完了後に再実行してください。');

    const results = await api.scripting.executeScript({ target: { tabId: tab.id, frameIds: [0] }, func: extractPage });
    const captured = results.find((item) => item.frameId === 0);
    if (!captured?.result?.fields || !captured.documentId)
      throw new Error('求人情報を取得できませんでした。HTMLページか確認してください。');

    const after = await api.tabs.get(tab.id);
    if (changed || after.url !== sourceUrl || after.status === 'loading' || captured.result.source.url !== sourceUrl)
      throw new Error('取得中にページが移動しました。元のページで再実行してください。');

    // The same document must still exist; a reload at the same URL must not pass.
    const check = await api.scripting.executeScript({
      target: { tabId: tab.id, documentIds: [captured.documentId] },
      func: () => location.href,
    });
    if (changed || check[0]?.documentId !== captured.documentId || check[0]?.result !== sourceUrl)
      throw new Error('取得中にページが変更されました。再実行してください。');

    record = { ...record, status: 'ready', snapshot: captured.result, assessment: classify(captured.result) };
  } catch (error) {
    record = {
      ...record,
      status: 'error',
      error: `取得に失敗しました。${error.message} 元のタブを確認して右クリックから再実行してください。`,
    };
    delete record.snapshot;
    delete record.assessment;
  } finally {
    api.tabs.onUpdated.removeListener(updated);
    api.tabs.onRemoved.removeListener(removed);
  }

  // A user may close the review while extraction is in progress. Do not resurrect it.
  if (record.reviewTabId != null) {
    try {
      await api.tabs.get(record.reviewTabId);
    } catch {
      await api.storage.session.remove(key);
      return record;
    }
  }

  await api.storage.session.set({ [key]: record });
  return record;
}

export async function reviseJob(api, id, input) {
  if (typeof id !== 'string' || !/^[\da-f-]{36}$/.test(id)) throw new Error('取得結果の識別子が不正です。');

  const key = keyFor(id);
  const record = (await api.storage.session.get(key))[key];
  if (record?.status !== 'ready') throw new Error('取得結果がありません。元ページから再取得してください。');

  const overrides = sanitizeOverrides(record.snapshot, input);
  const next = { ...record, overrides, assessment: classify(record.snapshot, overrides) };

  await api.storage.session.set({ [key]: next });
  return next;
}
