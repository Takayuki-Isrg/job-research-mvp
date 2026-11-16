import {
  ANALYSIS_PREFERENCES_LIMIT,
  SHARED_PREFERENCES_KEY,
  createAutoSaver,
  decodeImportedText,
  exportBlob,
  exportFileName,
  loadSharedPreferences,
  saveSharedPreferences,
} from './preferences-store.js';

const $ = (selector) => document.querySelector(selector);
const textarea = $('#preferences-text');
const status = $('#save-status');
const errorBox = $('#preferences-error');
let loaded = false;

function setStatus(state, text) {
  status.dataset.state = state;
  status.textContent = text;
}
function showError(text) {
  errorBox.textContent = text;
  errorBox.hidden = !text;
}
function updateCount() {
  const length = Array.from(textarea.value).length;
  const over = length > ANALYSIS_PREFERENCES_LIMIT;
  $('#char-count').dataset.over = String(over);
  $('#char-count').textContent = over
    ? `${length.toLocaleString('ja-JP')}文字：保存はできますが、求人分析は${ANALYSIS_PREFERENCES_LIMIT.toLocaleString('ja-JP')}文字までです。`
    : `${length.toLocaleString('ja-JP')}文字`;
  $('#export').disabled = !loaded || !textarea.value;
}

const saver = createAutoSaver({
  delay: 1000,
  save: (text) => saveSharedPreferences(chrome.storage.local, text),
  onStatus: ({ state, saved, error }) => {
    $('#retry').hidden = state !== 'error';
    if (state === 'dirty') setStatus('dirty', '未保存の変更があります（入力が止まると自動で保存します）');
    else if (state === 'saving') setStatus('saving', '保存中…');
    else if (state === 'saved') {
      setStatus('saved', `保存済み（${new Date(saved.updatedAt).toLocaleTimeString('ja-JP')}）`);
      showError('');
    } else if (state === 'error') {
      setStatus('error', '保存できませんでした');
      showError(
        `保存できませんでした：${error?.message || error}\n入力内容はこの画面に残っています。画面を閉じずに「もう一度保存する」を押すか、エクスポートで控えを保存してください。`,
      );
    }
  },
});

textarea.addEventListener('input', () => {
  updateCount();
  saver.schedule(textarea.value);
});
$('#retry').addEventListener('click', () => saver.flush());

$('#export').addEventListener('click', () => {
  const url = URL.createObjectURL(exportBlob(textarea.value));
  const link = document.createElement('a');
  link.href = url;
  link.download = exportFileName();
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});

$('#import').addEventListener('click', () => $('#import-file').click());
$('#import-file').addEventListener('change', async () => {
  const input = $('#import-file');
  const file = input.files?.[0];
  input.value = ''; // Allow importing the same file again.
  if (!file) return;
  let text;
  try {
    text = decodeImportedText(await file.arrayBuffer());
  } catch (error) {
    showError(`インポートできませんでした：${error.message}\n現在の希望条件は変更していません。`);
    return;
  }
  if (
    textarea.value &&
    textarea.value !== text &&
    !confirm(
      `現在の希望条件（${Array.from(textarea.value).length.toLocaleString('ja-JP')}文字）を、ファイル「${file.name}」の内容（${Array.from(text).length.toLocaleString('ja-JP')}文字）で上書きします。よろしいですか？`,
    )
  ) {
    setStatus(status.dataset.state, `${status.textContent}（インポートは取り消しました）`);
    return;
  }
  showError('');
  textarea.value = text;
  updateCount();
  saver.schedule(textarea.value);
  await saver.flush();
});

// Another preferences tab may save too. Follow it only when this tab has nothing unsaved.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !loaded || !Object.hasOwn(changes, SHARED_PREFERENCES_KEY)) return;
  const text = changes[SHARED_PREFERENCES_KEY].newValue?.text;
  if (typeof text !== 'string' || text === textarea.value) return;
  if (saver.hasUnsaved()) {
    showError('別の画面で希望条件が更新されました。この画面の内容を保存すると、その更新を上書きします。');
    return;
  }
  textarea.value = text;
  updateCount();
  setStatus('saved', '別の画面で保存された内容を反映しました');
});

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden' && saver.hasUnsaved()) saver.flush();
});
window.addEventListener('beforeunload', (event) => {
  if (!saver.hasUnsaved()) return;
  saver.flush();
  event.preventDefault();
  event.returnValue = '';
});

try {
  const { text, updatedAt } = await loadSharedPreferences(chrome.storage.local);
  textarea.value = text;
  loaded = true;
  textarea.disabled = $('#import').disabled = false;
  setStatus(
    'saved',
    updatedAt ? `保存済み（${new Date(updatedAt).toLocaleString('ja-JP')}）` : 'まだ保存された希望条件はありません',
  );
} catch (error) {
  // Keep editing disabled so an unreadable saved value is not overwritten by an empty one.
  setStatus('error', '読み込めませんでした');
  showError(`保存済みの希望条件を読み込めませんでした：${error.message}\n画面を再読み込みしてください。`);
}
updateCount();
