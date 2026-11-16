// Shared preferences: one plain-text document kept in chrome.storage.local.
// The text is stored exactly as given; nothing here splits, trims or rewrites it.

export const SHARED_PREFERENCES_KEY = 'sharedPreferences';
export const IMPORT_MAX_BYTES = 1_000_000;
export const ANALYSIS_PREFERENCES_LIMIT = 2000;

export async function loadSharedPreferences(storage) {
  const value = (await storage.get(SHARED_PREFERENCES_KEY))[SHARED_PREFERENCES_KEY];
  if (value === undefined) return { text: '', updatedAt: null };
  if (!value || typeof value !== 'object' || typeof value.text !== 'string')
    throw new Error('保存済みの希望条件の形式が不正です。');
  return { text: value.text, updatedAt: typeof value.updatedAt === 'string' ? value.updatedAt : null };
}

export async function saveSharedPreferences(storage, text, now = new Date()) {
  if (typeof text !== 'string') throw new Error('希望条件は文字列で保存してください。');
  const value = { version: 1, text, updatedAt: now.toISOString() };
  await storage.set({ [SHARED_PREFERENCES_KEY]: value });
  return value;
}

// Rejects non-UTF-8 files (e.g. Shift_JIS) instead of silently garbling them. A leading BOM is dropped.
export function decodeImportedText(buffer) {
  if (buffer.byteLength > IMPORT_MAX_BYTES)
    throw new Error(`ファイルが大きすぎます（上限${IMPORT_MAX_BYTES.toLocaleString('ja-JP')}バイト）。`);
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } catch {
    throw new Error('UTF-8のテキストとして読み込めません。Shift_JIS等の場合はUTF-8で保存し直してください。');
  }
  if (text.includes('\u0000')) throw new Error('テキストファイルではない可能性があります。');
  return text;
}

export function exportFileName(date = new Date()) {
  const pad = (value) => String(value).padStart(2, '0');
  return `希望条件_${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}.txt`;
}

export function exportBlob(text) {
  return new Blob([text], { type: 'text/plain;charset=utf-8' });
}

// Debounced, serialized saver. A failed save keeps the text pending so it can be retried; it never clears input.
export function createAutoSaver({ save, delay = 800, onStatus = () => {}, timers = globalThis }) {
  let timer = null;
  let pending = null;
  let running = null;

  function schedule(text) {
    pending = text;
    if (timer !== null) timers.clearTimeout(timer);
    onStatus({ state: 'dirty' });
    timer = timers.setTimeout(() => {
      timer = null;
      flush();
    }, delay);
  }

  async function flush() {
    if (timer !== null) {
      timers.clearTimeout(timer);
      timer = null;
    }
    while (running) await running;
    if (pending === null) return;
    const text = pending;
    pending = null;
    onStatus({ state: 'saving' });
    running = (async () => {
      try {
        const saved = await save(text);
        if (pending === null) onStatus({ state: 'saved', saved });
      } catch (error) {
        if (pending === null) pending = text;
        onStatus({ state: 'error', error });
      }
    })();
    try {
      await running;
    } finally {
      running = null;
    }
  }

  return { schedule, flush, hasUnsaved: () => pending !== null || timer !== null || running !== null };
}
