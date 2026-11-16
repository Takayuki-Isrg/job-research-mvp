import { FIELD_LABELS } from './classify.js';
import { loadSharedPreferences } from './preferences-store.js';
import { analysisInput, analysisSignature, listLocalModels, analyzeLocal, OLLAMA_ORIGIN } from './local-llm.js';

import {
  criteriaWarnings,
  directInformation,
  emptyCriteriaMessage,
  parseCriteria,
  verifyEvidence,
} from './analysis-evaluation.js';

export function initializeAnalysis({ id, key, getRecord, onRecord, hasUnsavedEdits, setLocked }) {
  const $ = (selector) => document.querySelector(selector);
  const status = $('#analysis-status');
  let running = false;
  let selectedModel = '';
  let selectionChanged = false;
  const modelSettingKey = 'localLlmModel';
  let preferencesInitialized = false;
  let preferencesEdited = false;
  // Read-only here: this screen never writes the shared preferences.
  const sharedPreferences = loadSharedPreferences(chrome.storage.local);
  sharedPreferences.catch(() => {});

  function message(text) {
    status.textContent = text;
  }
  function preferencesSource(text) {
    $('#analysis-preferences-source').textContent = text;
  }
  async function applySharedPreferences(loading, { replace = false } = {}) {
    let text;
    try {
      ({ text } = await loading);
    } catch {
      preferencesSource('共通の希望条件を読み込めませんでした。この画面で入力して分析できます。');
      return;
    }
    if (running || (!replace && preferencesEdited)) return;
    if (!text) {
      preferencesSource('共通の希望条件は未保存です。ツールバーの拡張アイコンから登録できます。');
      return;
    }
    $('#analysis-preferences').value = text;
    preferencesEdited = false;
    preferencesSource(
      '共通の希望条件を読み込みました。ここでの変更はこの画面の分析だけに使い、共通の希望条件は変わりません。',
    );
    previewCriteria();
    render(getRecord());
  }
  function render(record) {
    if (!record || record.status !== 'ready') return;
    if (!preferencesInitialized) {
      preferencesInitialized = true;
      // A job that was already analyzed keeps the conditions of that analysis; the shared ones are only a default.
      if (record.analysis) {
        $('#analysis-preferences').value = record.analysis.input?.preferences || '';
        preferencesSource('この求人で前回分析したときの希望条件です（共通の希望条件は読み込んでいません）。');
      } else {
        $('#analysis-preferences').value = '';
        applySharedPreferences(sharedPreferences);
      }
      previewCriteria();
    }
    $('#analyze').disabled = running || !$('#analysis-model').value || record.assessment.status !== '求人票';
    const analysis = record.analysis;
    $('#analysis-result').hidden = !analysis;
    if (!analysis) return;
    if (analysis.version !== 2) {
      $('#analysis-legacy').hidden = false;
      $('#analysis-v2').hidden = true;
      return;
    }
    $('#analysis-legacy').hidden = true;
    $('#analysis-v2').hidden = false;
    let same = false;
    try {
      same =
        analysisSignature(analysis.input) ===
        analysisSignature(analysisInput(record.assessment.values, $('#analysis-preferences').value, record));
    } catch {
      /* Edited conditions may be invalid until the next analysis. */
    }
    $('#analysis-meta').textContent =
      `モデル：${analysis.model} / 分析時刻：${new Date(analysis.generatedAt).toLocaleString('ja-JP')} / 所要時間：${analysis.elapsedSeconds}秒`;
    $('#analysis-stale').hidden = same;
    $('#analysis-record').textContent =
      `分析対象ID：${analysis.input.recordId || '未確認'} / 元ページ取得時刻：${analysis.input.capturedAt || '未確認'}`;
    $('#analysis-facts').replaceChildren(
      ...directInformation(analysis.input).map((item) => {
        const block = element('div', '', 'field');
        block.append(
          element('strong', FIELD_LABELS[item.field]),
          element('p', item.value || '未取得'),
          element('p', `採用元：${item.origin}（内容の事実性は未検証）`, 'muted'),
        );
        const details = element('details');
        details.append(
          element('summary', '抽出値・修正値・採用値を確認'),
          element(
            'p',
            `元の抽出値：${item.originalValue ?? '未確認'}\n利用者修正値：${item.overrideValue ?? '修正なし'}\n分析に使用した採用値：${item.value || '未取得'}\n抽出元：${item.source}\n抽出時の根拠：${item.extractionEvidence || 'なし'}`,
            'evidence',
          ),
        );
        block.append(details);
        return block;
      }),
    );
    $('#analysis-evaluations').replaceChildren(
      ...analysis.result.evaluations.map((row) => {
        const tr = element('tr');
        const condition = element('td', `${row.criterion.id} / ${row.criterion.category}\n${row.criterion.text}`);
        const decision = element('td', `${row.status}\n${row.method}`);
        // Results saved before corrections were tracked have no `correction` field.
        if (row.correction) {
          const details = element('details');
          details.append(
            element('summary', `補正前：${row.correction.originalStatus}`),
            element(
              'p',
              `補正理由：${row.correction.reasons.join(' ')}\nLLMの元の理由：${row.correction.originalReason || 'なし'}\nLLMの元の質問：${row.correction.originalQuestion || 'なし'}`,
              'evidence',
            ),
          );
          decision.append(details);
        }
        const reason = element('td', row.reason);
        const references = element('td');
        for (const source of row.evidence) {
          try {
            verifyEvidence(source, analysis.input);
          } catch {
            references.append(element('p', '不正な根拠参照です。再分析してください。'));
            continue;
          }
          const details = element('details');
          details.append(
            element('summary', `${source.id} / ${FIELD_LABELS[source.field]} / ${source.origin}`),
            element(
              'p',
              source.origin === '元ページ抽出'
                ? '元ページからの抽出箇所（原ページと照合してください）'
                : '分析に使用した採用値の該当箇所（求人原文として未確認）',
              'muted',
            ),
            element('p', source.evidence, 'evidence'),
          );
          if (source.origin === '利用者修正')
            details.append(
              element(
                'p',
                `元の抽出値：${analysis.input.provenance[source.field].originalValue || '未取得'}`,
                'evidence',
              ),
            );
          references.append(details);
        }
        if (!row.evidence.length)
          references.append(
            element(
              'p',
              row.status === '未調査' ? '外部情報源は未調査' : '根拠箇所なし。分析時点の採用情報では確定できません。',
            ),
          );
        tr.append(condition, decision, reason, references);
        return tr;
      }),
    );
    $('#analysis-questions').replaceChildren(
      ...(analysis.result.questions.length
        ? analysis.result.questions
        : [{ priority: '', criterionId: '', status: '', text: '追加の確認事項なし' }]
      ).map((item) => element('li', `${item.priority} ${item.criterionId} ${item.status}：${item.text}`)),
    );
  }

  function element(tag, text = '', className = '') {
    const node = document.createElement(tag);
    node.textContent = text;
    if (className) node.className = className;
    return node;
  }

  function previewCriteria() {
    const text = $('#analysis-preferences').value;
    const notice = $('#analysis-criteria-notice');
    notice.hidden = true;
    try {
      const { criteria } = parseCriteria(text);
      const warnings = criteriaWarnings(criteria);
      $('#analysis-criteria').replaceChildren(
        ...criteria.map((item) => {
          const li = element(
            'li',
            `${item.id} / ${item.category}${item.external ? ' / 外部未調査' : ''}：${item.text}`,
          );
          const own = warnings.filter((warning) => warning.criterionId === item.id);
          if (own.length) {
            const list = element('ul', '', 'criterion-warnings');
            list.append(...own.map((warning) => element('li', `注意：${warning.message}`)));
            li.append(list);
          }
          return li;
        }),
      );
      if (!criteria.length && text.trim()) {
        notice.textContent = emptyCriteriaMessage(text);
        notice.hidden = false;
      } else if (warnings.length) {
        const lines = new Set(warnings.map((warning) => warning.criterionId)).size;
        notice.textContent = `${lines}行に確認事項があります。「比較する条件を確認」で内容を確認し、必要なら入力を修正してください。修正しなくても分析は実行できます。`;
        notice.hidden = false;
      }
    } catch (error) {
      $('#analysis-criteria').textContent = error.message;
    }
  }

  const settingsReady = chrome.storage.local
    .get(modelSettingKey)
    .then((settings) => {
      if (selectionChanged || !settings[modelSettingKey]) return;
      selectedModel = settings[modelSettingKey];
      const option = new Option(selectedModel, selectedModel);
      $('#analysis-model').replaceChildren(option);
      render(getRecord());
    })
    .catch(() => message('モデル設定を読み込めませんでした。一覧から選択してください。'));

  async function saveModel() {
    selectionChanged = true;
    selectedModel = $('#analysis-model').value;
    try {
      await chrome.storage.local.set({ [modelSettingKey]: selectedModel });
    } catch {
      message('モデル設定を保存できませんでした。');
    }
    render(getRecord());
  }

  $('#load-models').addEventListener('click', async () => {
    $('#load-models').disabled = true;
    message('PC上のOllamaモデルを取得しています…');
    try {
      await settingsReady;
      const models = await listLocalModels();
      $('#analysis-model').replaceChildren(
        ...models.map((name) => {
          const option = document.createElement('option');
          option.value = name;
          option.textContent = name;
          return option;
        }),
      );
      const preferred = selectedModel || (models.includes('gemma3:4b') ? 'gemma3:4b' : models[0]);
      if (models.includes(preferred)) {
        $('#analysis-model').value = preferred;
        await saveModel();
      } else if (selectedModel) {
        $('#analysis-model').prepend(new Option(`保存モデルは未導入：${selectedModel}`, '', true, true));
      }
      message(
        models.length
          ? 'モデルを選び、必要なら希望条件を入力して分析してください。'
          : '利用可能なローカルGGUFモデルがありません。',
      );
      render(getRecord());
    } catch (error) {
      message(error.message);
    } finally {
      $('#load-models').disabled = false;
    }
  });
  $('#analysis-model').addEventListener('change', saveModel);
  $('#load-shared-preferences').addEventListener('click', async () => {
    if (running) return;
    const loading = loadSharedPreferences(chrome.storage.local);
    let text;
    try {
      ({ text } = await loading);
    } catch {
      preferencesSource('共通の希望条件を読み込めませんでした。');
      return;
    }
    const current = $('#analysis-preferences').value;
    if (current && current !== text && !confirm('この画面の希望条件を、共通の希望条件で置き換えます。よろしいですか？'))
      return;
    await applySharedPreferences(loading, { replace: true });
  });
  $('#analysis-preferences').addEventListener('input', () => {
    preferencesEdited = true;
    previewCriteria();
    render(getRecord());
  });
  $('#analyze').addEventListener('click', async () => {
    const record = getRecord();
    if (running || record?.status !== 'ready') return;
    if (record.assessment.status !== '求人票') {
      message('求人票の判定を確認してから分析してください。');
      return;
    }
    if (hasUnsavedEdits()) {
      message('未反映の編集があります。先に「修正して再判定」を押してください。');
      return;
    }
    let input;
    try {
      input = analysisInput(record.assessment.values, $('#analysis-preferences').value, record);
    } catch (error) {
      message(error.message);
      return;
    }
    running = true;
    setLocked(true);
    $('#analyze').disabled =
      $('#load-models').disabled =
      $('#analysis-model').disabled =
      $('#analysis-preferences').disabled =
      $('#load-shared-preferences').disabled =
        true;
    const startedAt = performance.now();
    let generating = false;
    const updateProgress = () =>
      message(
        `${generating ? '分析結果を生成中' : 'モデルを確認・読み込み中'}（${Math.floor((performance.now() - startedAt) / 1000)}秒経過）。`,
      );
    updateProgress();
    const progressTimer = setInterval(updateProgress, 1000);
    try {
      const analysis = await analyzeLocal(input, $('#analysis-model').value, fetch, () => {
        generating = true;
      });
      const latest = (await chrome.storage.session.get(key))[key];
      if (
        !latest ||
        latest.id !== id ||
        analysisSignature(analysisInput(latest.assessment.values, input.preferences, latest)) !==
          analysisSignature(input)
      )
        throw new Error('分析中に求人情報が変更・削除されました。結果は採用せず再実行してください。');
      await chrome.storage.session.set({ [key]: { ...latest, analysis } });
      onRecord({ ...latest, analysis });
      message(`分析結果を保存しました（${analysis.elapsedSeconds}秒）。解釈と根拠を確認してください。`);
    } catch (error) {
      message(`分析できませんでした。${error.message} 抽出・修正結果は保持されています。`);
      console.error('求人分析に失敗しました。', error.details || error);
    } finally {
      clearInterval(progressTimer);
      running = false;
      setLocked(false);
      $('#load-models').disabled =
        $('#analysis-model').disabled =
        $('#analysis-preferences').disabled =
        $('#load-shared-preferences').disabled =
          false;
      render(getRecord());
    }
  });
  $('#analysis-origin').textContent = `接続先：${OLLAMA_ORIGIN} / 拡張Origin：${location.origin}`;
  return { render };
}
