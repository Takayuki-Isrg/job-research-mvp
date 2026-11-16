import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analysisInput, criteriaWarnings, parseCriteria, validateAnalysis } from '../extension/analysis-evaluation.js';

const values = {
  company: '検証株式会社',
  title: '開発エンジニア',
  description: '社内システムの開発と業務改善',
  salary: '月給30万円〜40万円',
  employmentType: '正社員',
};
// c1:リモート勤務（非外部・非給与） c2:月給35万円以上（給与だがルール非該当） c3:外部調査
const input = analysisInput(values, 'リモート勤務\n月給35万円以上\n外部調査：口コミを検索');
const row = (criterionId, status, evidenceIds = [], extra = {}) => ({
  criterionId,
  status,
  reason: `${criterionId}のLLM理由`,
  evidenceIds,
  question: `${criterionId}のLLM質問`,
  ...extra,
});
const validate = (rows) => validateAnalysis({ evaluations: rows }, input).evaluations;

test('外部調査でない条件の「未調査」は要確認へ補正し、元の判定・理由・質問と補正理由を残す', () => {
  const [c1] = validate([row('c1', '未調査', ['description:0']), row('c2', '要確認'), row('c3', '未調査')]);
  assert.equal(c1.status, '要確認');
  assert.equal(c1.method, '判定区分補正');
  assert.match(c1.reason, /「未調査」はこの条件には使用できない/);
  assert.deepEqual(c1.correction, {
    originalStatus: '未調査',
    originalReason: 'c1のLLM理由',
    originalQuestion: 'c1のLLM質問',
    reasons: ['外部調査の対象でない条件に「未調査」が返されました。'],
  });
  assert.deepEqual(
    c1.evidence.map((source) => source.id),
    ['description:0'],
  );
  assert.match(c1.question, /採用情報と照合して確認してください：リモート勤務/);
});

test('給与以外の「提示額次第」は要確認へ補正し、給与条件の「提示額次第」は補正しない', () => {
  const [c1, c2] = validate([
    row('c1', '提示額次第', ['description:0']),
    row('c2', '提示額次第', ['salary:0'], { question: '' }),
    row('c3', '未調査'),
  ]);
  assert.equal(c1.status, '要確認');
  assert.equal(c1.method, '判定区分補正');
  assert.equal(c1.correction.originalStatus, '提示額次第');
  assert.deepEqual(c1.correction.reasons, ['給与条件以外に「提示額次第」が返されました。']);
  assert.equal(c2.status, '提示額次第');
  assert.equal(c2.method, 'LLM評価');
  assert.equal(c2.correction, null);
});

test('根拠不足補正は従来の判定・理由のまま、補正前の判定を追跡できる', () => {
  const [c1] = validate([row('c1', '一致'), row('c2', '要確認'), row('c3', '未調査')]);
  assert.equal(c1.status, '要確認');
  assert.equal(c1.method, '根拠不足補正');
  assert.equal(c1.reason, 'LLMが確定判定を返しましたが、根拠IDがないため確定せず要確認にしました。');
  assert.deepEqual(c1.evidence, []);
  assert.deepEqual(c1.correction.reasons, ['確定判定に根拠IDがありません。']);
  assert.equal(c1.correction.originalStatus, '一致');
});

test('給与以外の「提示額次第」で根拠もない場合は、両方の補正理由を残す', () => {
  const [c1] = validate([row('c1', '提示額次第'), row('c2', '要確認'), row('c3', '未調査')]);
  assert.equal(c1.method, '判定区分補正');
  assert.deepEqual(c1.correction.reasons, [
    '給与条件以外に「提示額次第」が返されました。',
    '確定判定に根拠IDがありません。',
  ]);
});

test('補正しない行・ルール照合の行は correction が null', () => {
  const evaluations = validate([row('c1', '要確認'), row('c2', '一致', ['salary:0']), row('c3', '一致')]);
  assert.deepEqual(
    evaluations.map((item) => [item.status, item.method, item.correction]),
    [
      ['要確認', 'LLM評価', null],
      ['一致', 'LLM評価', null],
      ['未調査', 'ルール照合', null],
    ],
  );
});

test('対応関係を保証できない誤りや区分外の値は補正せず、全体を拒否する', () => {
  const ok = [row('c1', '要確認'), row('c2', '要確認'), row('c3', '未調査')];
  for (const rows of [
    [ok[0], ok[0], ok[2]], // 重複・欠落
    [ok[0], ok[1]], // 件数不足
    [row('c9', '要確認'), ok[1], ok[2]], // 未知ID
    [row('c1', '判定保留'), ok[1], ok[2]], // 区分外
    [row('c1', '一致', ['description:999']), ok[1], ok[2]], // 存在しない根拠ID
  ])
    assert.throws(() => validateAnalysis({ evaluations: rows }, input));
});

test('箇条書き接頭辞の警告は分類・優先順位を説明し、LLMが読み取れないとは断定しない', () => {
  const warnings = criteriaWarnings(
    parseCriteria('・除外：客先常駐\n・外部調査：企業の評判\n除外条件\n・除外：短納期').criteria,
  );
  assert.deepEqual(
    warnings.map((warning) => warning.criterionId),
    ['c1', 'c2'],
  );
  assert.match(warnings[0].message, /分類と優先順位は「希望」になります/);
  assert.match(warnings[0].message, /意図が読み取られる場合もあります/);
  assert.doesNotMatch(warnings[0].message, /扱われません。|伝わりません|読み取れません/);
  assert.match(warnings[1].message, /外部調査の対象としても扱われません/);
});
