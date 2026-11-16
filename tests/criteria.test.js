import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  analysisInput,
  criteriaWarnings,
  emptyCriteriaMessage,
  parseCriteria,
  ruleEvaluation,
} from '../extension/analysis-evaluation.js';
import { analyzeLocal } from '../extension/local-llm.js';

const values = {
  company: '検証株式会社',
  title: '開発エンジニア',
  description: '社内システムの開発と業務改善',
  salary: '年収300万円〜600万円',
  employmentType: '正社員',
};
const warningsFor = (text) => criteriaWarnings(parseCriteria(text).criteria);
const kinds = (text) => warningsFor(text).map((warning) => `${warning.criterionId}:${warning.kind}`);

test('正常な1行1条件には警告を出さない（文末の句点・数字の桁区切りを含む）', () => {
  const text =
    '除外：顧客向け案件アサイン型の仕事\nハード：年収450万円以上\n希望：AI活用・業務改善に関わりたい。\n月給300,000円以上';
  assert.deepEqual(kinds(text), []);
  assert.equal(parseCriteria(text).criteria.length, 4);
  assert.equal(emptyCriteriaMessage(text), null);
});

test('複数条件の可能性がある行は警告し、行の分割・条件文・IDは変えない', () => {
  const text = 'リモート勤務可、副業可\n口コミ評価が高い、報道で問題がない';
  const before = structuredClone(parseCriteria(text));
  assert.deepEqual(kinds(text), ['c1:multiple', 'c2:multiple']);
  assert.match(warningsFor(text)[0].message, /可能性/);
  assert.deepEqual(parseCriteria(text), before);
  assert.deepEqual(
    before.criteria.map((criterion) => [criterion.id, criterion.text]),
    [
      ['c1', 'リモート勤務可、副業可'],
      ['c2', '口コミ評価が高い、報道で問題がない'],
    ],
  );
});

test('給与・固定残業・残業のルール照合行に複数内容があれば、他の内容が評価されない可能性を警告する', () => {
  const text = '年収450万円以上、リモート可。残業20時間以内\n固定残業30時間以上は除外、転勤なし\n残業少なめ／土日休み';
  const warnings = warningsFor(text);
  assert.deepEqual(
    warnings.map((warning) => `${warning.criterionId}:${warning.kind}`),
    ['c1:ruleWithMultiple', 'c2:ruleWithMultiple', 'c3:ruleWithMultiple'],
  );
  assert.match(warnings[0].message, /給与（年収下限）/);
  assert.match(warnings[1].message, /固定残業/);
  assert.match(warnings[2].message, /残業の照合ルール/);
  // 警告の根拠：判定ロジックは変更しておらず、実際にこの行は給与ルールだけで判定される。
  const input = analysisInput(values, '年収450万円以上、リモート可。残業20時間以内');
  const rule = ruleEvaluation(input.criteria[0], input);
  assert.equal(rule.status, '提示額次第');
  assert.match(rule.reason, /年収範囲/);
});

test('箇条書き記号の後の分類接頭辞は、分類を変えずに警告する', () => {
  const text = '・除外：客先常駐\n- ハード：正社員\n1. 職種：社内SE\n除外：短納期';
  const parsed = parseCriteria(text);
  assert.deepEqual(
    parsed.criteria.map((criterion) => criterion.category),
    ['希望', '希望', '希望', '除外'],
  );
  assert.equal(parsed.criteria[0].text, '・除外：客先常駐');
  const warnings = warningsFor(text);
  assert.deepEqual(
    warnings.map((warning) => `${warning.criterionId}:${warning.kind}`),
    ['c1:bulletPrefix', 'c2:bulletPrefix', 'c3:bulletPrefix'],
  );
  assert.match(warnings[0].message, /「除外：」は分類の接頭辞として認識されません。この行の分類と優先順位は「希望」/);
});

test('見出しだけの入力は、見出しだけであることを案内する', async () => {
  for (const text of ['除外条件\nハード条件', '【希望条件】', '希望条件：']) {
    assert.equal(parseCriteria(text).criteria.length, 0);
    assert.match(emptyCriteriaMessage(text), /見出しの行だけ/);
  }
  const calls = [];
  await assert.rejects(
    analyzeLocal(analysisInput(values, '除外条件\nハード条件'), 'gemma3:4b', async (url) => {
      calls.push(url);
      throw new Error('呼ばれない想定');
    }),
    /見出しの行だけ/,
  );
  assert.equal(calls.length, 0);
});

test('プロフィールだけの入力・空入力は、それぞれの原因を案内する', async () => {
  const profileOnly = 'あなたのプロフィールとして照合している内容\n実務経験：Java 5年';
  assert.equal(parseCriteria(profileOnly).profile, '実務経験：Java 5年');
  assert.match(emptyCriteriaMessage(profileOnly), /応募者情報として扱う/);
  assert.match(emptyCriteriaMessage('ハード条件\nプロフィール\nJava'), /応募者情報として扱う/);
  assert.match(emptyCriteriaMessage(' \n\n'), /入力されていません/);
  await assert.rejects(
    analyzeLocal(analysisInput(values, profileOnly), 'gemma3:4b', async () => {
      throw new Error('呼ばれない想定');
    }),
    /応募者情報として扱う/,
  );
});
