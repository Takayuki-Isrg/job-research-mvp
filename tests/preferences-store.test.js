import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SHARED_PREFERENCES_KEY,
  IMPORT_MAX_BYTES,
  createAutoSaver,
  decodeImportedText,
  exportBlob,
  exportFileName,
  loadSharedPreferences,
  saveSharedPreferences,
} from '../extension/preferences-store.js';
import { openPreferences } from '../extension/open-preferences.js';

function memoryStorage(initial = {}) {
  const data = { ...initial };
  return {
    data,
    get: async (key) => (Object.hasOwn(data, key) ? { [key]: structuredClone(data[key]) } : {}),
    set: async (items) => Object.assign(data, structuredClone(items)),
  };
}

function manualTimers() {
  let next = 1;
  const pending = new Map();
  return {
    setTimeout: (fn) => (pending.set(next, fn), next++),
    clearTimeout: (id) => pending.delete(id),
    count: () => pending.size,
    runAll: () => {
      const fns = [...pending.values()];
      pending.clear();
      fns.forEach((fn) => fn());
    },
  };
}
const settle = () => new Promise((resolve) => setImmediate(resolve));

test('保存した原文をそのまま復元し、未保存なら空、不正な保存値は空扱いにせずエラー', async () => {
  const storage = memoryStorage();
  assert.deepEqual(await loadSharedPreferences(storage), { text: '', updatedAt: null });
  const original = '  除外条件\r\n・除外：客先常駐、短納期\n\n希望：年収450万円以上 😀  ';
  const saved = await saveSharedPreferences(storage, original, new Date('2026-11-11T01:02:03Z'));
  assert.deepEqual(storage.data[SHARED_PREFERENCES_KEY], {
    version: 1,
    text: original,
    updatedAt: '2026-11-11T01:02:03.000Z',
  });
  assert.equal(saved.text, original);
  assert.deepEqual(await loadSharedPreferences(storage), { text: original, updatedAt: '2026-11-11T01:02:03.000Z' });
  // 求人ごとの記録・モデル設定とはキーが別。
  assert.notEqual(SHARED_PREFERENCES_KEY, 'localLlmModel');
  assert.ok(!SHARED_PREFERENCES_KEY.startsWith('job:'));
  for (const broken of [null, 'text', { text: 1 }])
    await assert.rejects(loadSharedPreferences(memoryStorage({ [SHARED_PREFERENCES_KEY]: broken })), /形式/);
  await assert.rejects(saveSharedPreferences(storage, undefined), /文字列/);
});

test('インポートはUTF-8だけを受け付け、BOMだけを除いて原文を保つ', () => {
  const text = '除外：客先常駐\r\n希望：リモート可、副業可\n';
  const utf8 = new TextEncoder().encode(text);
  assert.equal(decodeImportedText(utf8.buffer), text);
  const withBom = new Uint8Array([0xef, 0xbb, 0xbf, ...utf8]);
  assert.equal(decodeImportedText(withBom.buffer), text);
  // 「除外」をShift_JISで表したバイト列はUTF-8として不正。
  assert.throws(() => decodeImportedText(new Uint8Array([0x8f, 0x9c, 0x8a, 0x4f]).buffer), /UTF-8/);
  assert.throws(() => decodeImportedText(new Uint8Array([0x41, 0x00, 0x42]).buffer), /テキストファイル/);
  assert.throws(() => decodeImportedText(new ArrayBuffer(IMPORT_MAX_BYTES + 1)), /大きすぎます/);
  assert.equal(decodeImportedText(new ArrayBuffer(0)), '');
});

test('エクスポートはUTF-8テキストで、内容を変えない', async () => {
  const text = '除外：客先常駐\n希望：AI活用 😀';
  const blob = exportBlob(text);
  assert.equal(blob.type, 'text/plain;charset=utf-8');
  assert.deepEqual(new Uint8Array(await blob.arrayBuffer()), new TextEncoder().encode(text));
  assert.equal(exportFileName(new Date(2026, 10, 11, 9, 5)), '希望条件_20261111-0905.txt');
});

test('自動保存は入力停止後に最新の内容だけを保存し、状態を通知する', async () => {
  const timers = manualTimers();
  const saves = [];
  const states = [];
  const saver = createAutoSaver({
    timers,
    save: async (text) => (saves.push(text), { text, updatedAt: 'now' }),
    onStatus: ({ state }) => states.push(state),
  });
  saver.schedule('あ');
  saver.schedule('あい');
  saver.schedule('あいう');
  assert.equal(timers.count(), 1, '入力のたびに待ち時間をやり直す');
  assert.equal(saver.hasUnsaved(), true);
  assert.deepEqual(saves, []);
  timers.runAll();
  await settle();
  assert.deepEqual(saves, ['あいう']);
  assert.deepEqual(states, ['dirty', 'dirty', 'dirty', 'saving', 'saved']);
  assert.equal(saver.hasUnsaved(), false);
});

test('保存失敗では入力を保持して再試行でき、保存中の新しい入力は後から保存する', async () => {
  const timers = manualTimers();
  const saves = [];
  const states = [];
  let fail = true;
  let release;
  let blocked = false;
  const saver = createAutoSaver({
    timers,
    save: async (text) => {
      saves.push(text);
      if (blocked) await new Promise((resolve) => (release = resolve));
      if (fail) throw new Error('QUOTA_BYTES quota exceeded');
      return { text, updatedAt: 'now' };
    },
    onStatus: ({ state, error }) => states.push(error ? `${state}:${error.message}` : state),
  });
  saver.schedule('保存したい文');
  await saver.flush();
  assert.equal(states.at(-1), 'error:QUOTA_BYTES quota exceeded');
  assert.equal(saver.hasUnsaved(), true, '失敗した内容は未保存として残る');
  fail = false;
  await saver.flush();
  assert.deepEqual(saves, ['保存したい文', '保存したい文']);
  assert.equal(states.at(-1), 'saved');

  blocked = true;
  saver.schedule('一回目');
  const first = saver.flush();
  await settle();
  saver.schedule('二回目');
  const second = saver.flush();
  blocked = false;
  release();
  await Promise.all([first, second]);
  assert.deepEqual(saves.slice(-2), ['一回目', '二回目'], '保存は直列で、最後の入力が最後に保存される');
  assert.equal(saver.hasUnsaved(), false);
});

test('アイコンのクリックは開いている管理画面を前面に出し、なければ新しいタブで開く', async () => {
  const calls = [];
  const api = (contexts, { updateFails = false, getContextsFails = false } = {}) => ({
    runtime: {
      getURL: (path) => `chrome-extension://id/${path}`,
      getContexts: async (filter) => {
        calls.push(['getContexts', filter]);
        if (getContextsFails) throw new Error('unsupported');
        return contexts;
      },
    },
    tabs: {
      update: async (tabId, props) => {
        calls.push(['update', tabId, props]);
        if (updateFails) throw new Error('No tab');
      },
      create: async (props) => (calls.push(['create', props]), { id: 99 }),
    },
    windows: { update: async (windowId, props) => calls.push(['window', windowId, props]) },
  });
  assert.equal(await openPreferences(api([{ tabId: 5, windowId: 2 }])), 5);
  assert.deepEqual(calls, [
    ['getContexts', { contextTypes: ['TAB'], documentUrls: ['chrome-extension://id/preferences.html'] }],
    ['update', 5, { active: true }],
    ['window', 2, { focused: true }],
  ]);
  calls.length = 0;
  assert.equal(await openPreferences(api([])), 99);
  assert.deepEqual(calls.at(-1), ['create', { url: 'chrome-extension://id/preferences.html' }]);
  assert.equal(await openPreferences(api([{ tabId: 5, windowId: 2 }], { updateFails: true })), 99);
  assert.equal(await openPreferences(api([], { getContextsFails: true })), 99);
});
