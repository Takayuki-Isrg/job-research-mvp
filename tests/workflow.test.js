import { test } from 'node:test';
import assert from 'node:assert/strict';
import { captureJob, reviseJob, keyFor } from '../extension/workflow.js';

function event() {
  const listeners = new Set();
  return {
    addListener: (f) => listeners.add(f),
    removeListener: (f) => listeners.delete(f),
    fire: (...args) => listeners.forEach((f) => f(...args)),
    get size() {
      return listeners.size;
    },
  };
}

function fakeApi() {
  const records = {};
  const sourceUrl = 'https://example.test/job/1';
  const snapshot = {
    source: { url: sourceUrl, title: '求人票', capturedAt: '2026-11-07T00:00:00Z' },
    fields: {
      title: { value: '開発エンジニア' },
      description: { value: 'システム開発' },
      employmentType: { value: '正社員' },
    },
    signals: {
      isList: false,
      ambiguousStructured: false,
      conflicts: [],
      structuredMatched: false,
      recruitmentHint: true,
      hasApply: false,
      structuredCount: 0,
    },
    warnings: [],
  };

  const api = {
    runtime: { getURL: (path) => `chrome-extension://test/${path}` },
    storage: {
      session: {
        set: async (data) => Object.assign(records, structuredClone(data)),
        get: async (key) => (key === null ? structuredClone(records) : { [key]: structuredClone(records[key]) }),
        remove: async (key) => {
          delete records[key];
        },
      },
    },
    tabs: {
      onUpdated: event(),
      onRemoved: event(),
      create: async () => ({ id: 99 }),
      get: async (id) => ({ id, url: sourceUrl, status: 'complete' }),
    },
    scripting: {
      executeScript: async (request) =>
        request.target.documentIds
          ? [{ frameId: 0, documentId: 'doc-1', result: sourceUrl }]
          : [{ frameId: 0, documentId: 'doc-1', result: snapshot }],
    },
  };

  return { api, records, sourceUrl, snapshot };
}
test('起動元タブを使い、結果をセッション保存して画面に渡す', async () => {
  const { api, records, sourceUrl } = fakeApi();
  const record = await captureJob(api, { id: 1, url: sourceUrl }, sourceUrl);

  assert.equal(record.status, 'ready');
  assert.equal(record.assessment.status, '求人票');
  assert.equal(record.reviewTabId, 99);
  assert.equal(records[keyFor(record.id)].snapshot.source.url, sourceUrl);
  assert.equal(api.tabs.onUpdated.size, 0);
});
test('取得中に確認タブを閉じても結果を再作成しない', async () => {
  const { api, records, sourceUrl } = fakeApi();
  const get = api.tabs.get;
  api.tabs.get = async (id) => {
    if (id === 99) throw new Error('tab closed');
    return get(id);
  };

  const record = await captureJob(api, { id: 1, url: sourceUrl }, sourceUrl);
  assert.equal(records[keyFor(record.id)], undefined);
});
test('別ページへの遷移・同URL再読み込み・閉鎖を成功扱いにしない', async () => {
  for (const action of ['navigate', 'reload', 'close', 'documentChanged']) {
    const { api, sourceUrl } = fakeApi();
    const real = api.scripting.executeScript;
    api.scripting.executeScript = async (request) => {
      if (request.target.documentIds && action === 'documentChanged') throw new Error('document gone');
      if (!request.target.documentIds) {
        if (action === 'navigate') api.tabs.onUpdated.fire(1, { url: 'https://other.test' });
        if (action === 'reload') api.tabs.onUpdated.fire(1, { status: 'loading' });
        if (action === 'close') api.tabs.onRemoved.fire(1);
      }
      return real(request);
    };

    const record = await captureJob(api, { id: 1, url: sourceUrl }, sourceUrl);
    assert.equal(record.status, 'error', action);
    assert.equal(record.snapshot, undefined);
  }
});
test('権限不足・内部ページは対象外判定と区別してエラーを表示', async () => {
  for (const restricted of [false, true]) {
    const { api, sourceUrl } = fakeApi();
    if (!restricted)
      api.scripting.executeScript = async () => {
        throw new Error('permission denied');
      };
    const record = await captureJob(api, { id: 1, url: sourceUrl }, restricted ? 'chrome://extensions' : sourceUrl);
    assert.equal(record.status, 'error');
    assert.equal(record.assessment, undefined);
    assert.match(record.error, /再実行/);
  }
});
test('複数の取得と修正はID単位で独立し、元の値を維持する', async () => {
  const { api, sourceUrl } = fakeApi();
  const [a, b] = await Promise.all([
    captureJob(api, { id: 1, url: sourceUrl }, sourceUrl),
    captureJob(api, { id: 2, url: sourceUrl }, sourceUrl),
  ]);

  assert.notEqual(a.id, b.id);

  const updated = await reviseJob(api, a.id, { company: 'サンプル株式会社' });
  assert.equal(updated.assessment.values.company, 'サンプル株式会社');
  assert.equal(updated.snapshot.fields.company, undefined);
  assert.equal((await api.storage.session.get(keyFor(b.id)))[keyFor(b.id)].assessment.values.company, '');

  const reset = await reviseJob(api, a.id, {});
  assert.equal(reset.assessment.values.company, '');
  await assert.rejects(reviseJob(api, 'not-valid', {}));
});
