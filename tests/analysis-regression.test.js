import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  analysisInput,
  directInformation,
  evidenceSources,
  validateAnalysis,
} from '../extension/analysis-evaluation.js';
import { classify } from '../extension/classify.js';
import { reviseJob, keyFor } from '../extension/workflow.js';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/technopro-analysis.json', import.meta.url), 'utf8'));
function record() {
  const snapshot = {
    source: {
      url: 'https://example.test/redacted-job',
      title: '回帰検証用の求人抜粋',
      capturedAt: '2026-11-08T00:00:00Z',
    },
    fields: Object.fromEntries(
      Object.entries(fixture.values).map(([field, value]) => [
        field,
        { value, source: '本文', evidence: `共有抜粋：${field}` },
      ]),
    ),
    signals: {
      isList: false,
      ambiguousStructured: false,
      conflicts: [],
      structuredMatched: false,
      recruitmentHint: true,
      hasApply: true,
      structuredCount: 0,
    },
    warnings: [],
  };
  return {
    id: '12345678-1234-1234-1234-123456789abc',
    status: 'ready',
    snapshot,
    overrides: {},
    assessment: classify(snapshot),
  };
}
function modelRows(input) {
  return {
    evaluations: input.criteria.map((criterion) => ({
      criterionId: criterion.id,
      status: '不一致',
      reason: '短納期の可能性。年収360万円〜720万円。残業20時間以内。',
      evidenceIds: ['description:0'],
      question: '一般的な質問',
    })),
  };
}

test('テクノプロ回帰：年収の創作・残業の上限化・未記載の短納期推測を表示しない', () => {
  const job = record();
  const input = analysisInput(job.assessment.values, fixture.preferences, job);
  const output = validateAnalysis(modelRows(input), input);
  const facts = directInformation(input);
  assert.equal(facts.find((item) => item.field === 'salary').value, fixture.values.salary);
  assert.ok(facts.find((item) => item.field === 'description').value.includes('残業20時間/'));
  assert.equal(JSON.stringify(output).includes('360万円'), false);
  assert.equal(JSON.stringify(output).includes('残業20時間以内'), false);
  assert.equal(output.evaluations[0].status, '不一致');
  assert.match(output.evaluations[0].reason, /顧客先にて案件アサイン/);
  assert.equal(output.evaluations[1].status, '要確認');
  assert.equal(output.evaluations[2].status, '提示額次第');
  assert.equal(output.evaluations[3].status, '要確認');
  assert.equal(output.evaluations[4].status, '未調査');
  assert.equal(output.questions[0].criterionId, 'c2');
  assert.equal(output.questions[0].priority, '除外');
});

test('テクノプロ回帰：修正した採用値で再評価し、元の抽出値と前回入力を維持する', async () => {
  const job = record();
  const before = structuredClone(job.snapshot);
  const key = keyFor(job.id);
  const records = { [key]: job };
  const api = {
    storage: {
      session: {
        get: async (key) => ({ [key]: structuredClone(records[key]) }),
        set: async (data) => Object.assign(records, structuredClone(data)),
      },
    },
  };
  const originalInput = analysisInput(job.assessment.values, fixture.preferences, job);
  const revised = await reviseJob(api, job.id, {
    salary: '年収500万円〜600万円',
    description: '自社内のシステム改善を担当します。',
  });
  const input = analysisInput(revised.assessment.values, fixture.preferences, revised);
  const rows = modelRows(input);
  rows.evaluations[0] = {
    ...rows.evaluations[0],
    status: '要確認',
    reason: '客先勤務の記載がなく勤務実態を要確認',
    question: '勤務実態を確認',
  };
  const output = validateAnalysis(rows, input);
  assert.equal(output.evaluations[2].status, '一致');
  assert.equal(output.evaluations[0].status, '要確認');
  assert.deepEqual(revised.snapshot, before);
  assert.equal(originalInput.fields.salary, fixture.values.salary);
  assert.equal(input.provenance.salary.originalValue, fixture.values.salary);
  assert.equal(input.provenance.salary.overrideValue, '年収500万円〜600万円');
  assert.equal(input.provenance.salary.origin, '利用者修正');
  assert.equal(output.evaluations[2].evidence[0].origin, '利用者修正');
  assert.equal(output.evaluations[2].evidence[0].evidence, '年収500万円〜600万円');
  assert.throws(
    () => analysisInput({ ...revised.assessment.values, salary: '勝手な変更' }, fixture.preferences, revised),
    /対応/,
  );
});

test('テクノプロ回帰：ルール判定で置き換わる項目でも、不正な根拠IDは拒否する', () => {
  const job = record();
  const input = analysisInput(job.assessment.values, fixture.preferences, job);
  const raw = modelRows(input);
  raw.evaluations[0].evidenceIds = ['description:999'];
  assert.throws(() => validateAnalysis(raw, input), /根拠ID/);
});

test('月給から年収を補完せず、明示範囲と固定残業の明確な数値だけを比較する', () => {
  const job = record();
  for (const [salary, expected] of [
    ['月給30万円〜60万円', '要確認'],
    ['年収450万円〜600万円', '一致'],
    ['年収300万円〜400万円', '不一致'],
    ['年収600万円〜300万円', '要確認'],
  ]) {
    const input = analysisInput({ ...job.assessment.values, salary }, 'ハード：年収437万円以上');
    assert.equal(
      validateAnalysis({ evaluations: [{ ...modelRows(input).evaluations[0], evidenceIds: ['salary:0'] }] }, input)
        .evaluations[0].status,
      expected,
    );
  }
  for (const [salary, expected] of [
    ['固定残業代（30時間分）を含む', '不一致'],
    ['固定残業代（20時間分）を含む', '一致'],
    ['固定残業代の記載なし', '要確認'],
  ]) {
    const input = analysisInput({ ...job.assessment.values, salary }, 'ハード：固定残業代30時間分以上は不一致');
    assert.equal(validateAnalysis(modelRows(input), input).evaluations[0].status, expected);
  }
});

test('条件が異なれば同じ根拠でも別の判定を保持し、質問は条件優先順になる', () => {
  const input = analysisInput(fixture.values, '注意：研修の内容\nハード：勤務曜日\n除外：職種の実態');
  const raw = {
    evaluations: input.criteria.map((criterion) => ({
      criterionId: criterion.id,
      status: '要確認',
      reason: '情報が不足',
      evidenceIds: [],
      question: criterion.text,
    })),
  };
  const output = validateAnalysis(raw, input);
  assert.deepEqual(
    output.questions.map((item) => item.criterionId),
    ['c3', 'c2', 'c1'],
  );
  assert.equal(
    evidenceSources(input).some((source) => source.id === 'description:0'),
    true,
  );
  const boundary = analysisInput(
    { ...fixture.values, description: '前'.repeat(297) + '顧客先にて案件アサインします。' },
    '除外：案件アサイン型の仕事',
  );
  const judged = validateAnalysis(modelRows(boundary), boundary).evaluations[0];
  assert.equal(judged.status, '不一致');
  assert.equal(judged.evidence.length, 2);
});
