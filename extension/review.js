import { FIELD_LABELS } from './classify.js';
import { keyFor } from './workflow.js';
import { initializeAnalysis } from './analysis-view.js';

const id = new URL(location.href).searchParams.get('id');
const validId = /^[\da-f-]{36}$/.test(id ?? '');
const key = validId ? keyFor(id) : null;
const $ = (selector) => document.querySelector(selector);
const notice = $('#notice');
let current;
let busy = false;
let analysisLocked = false;
const analysisView = initializeAnalysis({
  id,
  key,
  getRecord: () => current,
  onRecord: render,
  hasUnsavedEdits: () =>
    [...document.querySelectorAll('#edit-form textarea')].some(
      (input) => input.value.trim() !== current.assessment.values[input.name],
    ),
  setLocked: (locked) => {
    analysisLocked = busy = locked;
    document.querySelectorAll('#edit-form textarea, #recheck, #reset').forEach((element) => {
      element.disabled = locked;
    });
  },
});

function message(text, error = false) {
  notice.textContent = text;
  notice.dataset.error = String(error);
}

function render(record) {
  current = record;

  if (!record) {
    $('#result').hidden = true;
    message(
      '取得結果がありません。セッション終了または確認画面の閉鎖で削除された可能性があります。元ページの右クリックから再取得してください。',
      true,
    );
    return;
  }

  if (record.status !== 'ready') {
    $('#result').hidden = true;
    message(record.status === 'error' ? record.error : '求人票の情報を取得しています…', record.status === 'error');
    return;
  }

  const { snapshot, assessment, overrides } = record;
  $('#result').hidden = false;
  $('#page-title').textContent = snapshot.source.title || 'タイトルなし';
  $('#page-url').textContent = snapshot.source.url;
  $('#captured-at').textContent = `取得時刻：${new Date(snapshot.source.capturedAt).toLocaleString('ja-JP')}`;

  $('#status').textContent = assessment.status;
  $('#status').dataset.status = assessment.status;
  $('#reasons').replaceChildren(
    ...assessment.reasons.map((reason) => {
      const li = document.createElement('li');
      li.textContent = reason;
      return li;
    }),
  );

  $('#company-state').textContent = `企業名の状態：${assessment.companyState}`;
  const companyModified = Object.hasOwn(overrides, 'company');
  $('#company-original').textContent = snapshot.fields.company?.value || '未取得';
  $('#company-override').textContent = companyModified ? overrides.company || '空欄に修正（企業名未指定）' : '修正なし';
  $('#company-adopted').textContent = assessment.values.company || '未取得（企業名未指定）';
  $('#company-adopted-source').textContent = `採用元：${companyModified ? '利用者の修正値' : '元ページの抽出値'}`;

  $('#research-state').textContent = assessment.researchState;
  $('#missing').textContent = `未取得項目：${assessment.missing.map((key) => FIELD_LABELS[key]).join('、') || 'なし'}`;
  $('#required').textContent =
    `確認が必要な項目：${assessment.required.join('、') || 'なし（企業の同一性は外部未確認）'}`;

  $('#fields').replaceChildren();
  for (const [name, labelText] of Object.entries(FIELD_LABELS)) {
    const original = snapshot.fields[name];
    const modified = Object.hasOwn(overrides, name);

    const block = document.createElement('div');
    block.className = 'field';
    const label = document.createElement('label');
    label.htmlFor = `field-${name}`;
    label.textContent = `${labelText}${modified ? ' · 利用者修正' : ''}`;

    const input = document.createElement('textarea');
    input.id = `field-${name}`;
    input.name = name;
    input.maxLength = 6000;
    input.rows = ['description', 'qualifications'].includes(name) ? 4 : 2;
    input.value = assessment.values[name];
    input.placeholder = '未取得';

    const provenance = document.createElement('p');
    provenance.className = 'evidence';
    provenance.textContent = `取得元：${original.source ?? '未取得'}${original.evidence ? `\n根拠：${original.evidence}` : ''}`;
    input.setAttribute('aria-describedby', `evidence-${name}`);
    provenance.id = `evidence-${name}`;
    block.append(label, input, provenance);

    if (modified) {
      const before = document.createElement('details');
      const summary = document.createElement('summary');
      summary.textContent = '元の抽出値';
      const text = document.createElement('p');
      text.className = 'original';
      text.textContent = original.value ?? '未取得';
      before.append(summary, text);
      block.append(before);
    }
    $('#fields').append(block);
  }

  document.querySelectorAll('#edit-form textarea, #recheck, #reset').forEach((element) => {
    element.disabled = analysisLocked;
  });
  analysisView.render(record);
  message('内容を確認し、必要に応じて修正して再判定してください。LLM分析は下のボタンから手動で実行します。');
}

async function save(reset = false) {
  if (busy || current?.status !== 'ready') return;

  busy = true;
  $('#recheck').disabled = $('#reset').disabled = true;

  try {
    const overrides = reset ? {} : Object.fromEntries(new FormData($('#edit-form')));
    const response = await chrome.runtime.sendMessage({ type: 'revise', id, overrides });
    if (!response?.ok) throw new Error(response?.error || '再判定できませんでした。');

    render(response.record);
    message(reset ? '修正をリセットし、元の抽出値で再判定しました。' : '修正値を保存し、再判定しました。');
    window.scrollTo({ top: 0, behavior: 'smooth' });
  } catch (error) {
    message(error.message, true);
  } finally {
    busy = false;
    $('#recheck').disabled = $('#reset').disabled = false;
  }
}

$('#edit-form').addEventListener('submit', (event) => {
  event.preventDefault();
  save();
});
$('#reset').addEventListener('click', () => save(true));

let version = 0;
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'session' && key && Object.hasOwn(changes, key)) {
    version++;
    if (!busy) render(changes[key].newValue);
  }
});

try {
  if (!key) throw new Error('取得結果の識別子がありません。元ページの右クリックから開始してください。');
  const initialVersion = version;
  const data = await chrome.storage.session.get(key);
  if (version === initialVersion) render(data[key]);
} catch (error) {
  message(error.message, true);
}
