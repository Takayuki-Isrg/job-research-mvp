import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  analysisInput,
  evidenceSources,
  analyzeLocal,
  listLocalModels,
  validateAnalysis,
  OLLAMA_ORIGIN,
} from '../extension/local-llm.js';
import {
  parseCriteria,
  directInformation,
  verifyEvidence,
  analysisSignature,
} from '../extension/analysis-evaluation.js';

const values = {
  company: '検証株式会社',
  title: '開発エンジニア',
  description: '社内システムの開発と業務改善',
  employmentType: '正社員',
};
const input = analysisInput(values, 'ハード：正社員');
const row = {
  criterionId: 'c1',
  status: '一致',
  reason: '正社員の記載があります。',
  evidenceIds: ['employmentType:0'],
  question: '',
};
const result = { evaluations: [row] };
const local = { name: 'gemma3:4b', details: { format: 'gguf' } };

function mock(options = {}) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    assert.ok(url.startsWith(OLLAMA_ORIGIN + '/api/'));
    assert.equal(init.redirect, 'error');
    assert.equal(init.credentials, 'omit');
    if (options.status) return new Response('', { status: options.status });
    if (url.endsWith('/tags')) return Response.json({ models: options.models ?? [local] });
    if (url.endsWith('/show'))
      return Response.json(
        options.details ?? {
          details: { format: 'gguf' },
          model_info: { 'general.architecture': 'gemma3' },
          capabilities: ['completion'],
        },
      );
    const text = JSON.stringify(options.result ?? result);
    const content =
      JSON.stringify({ message: { content: text.slice(0, 17) } }) +
      '\n' +
      JSON.stringify({ message: { content: text.slice(17) }, done: true, done_reason: options.reason ?? 'stop' }) +
      '\n';
    const bytes = new TextEncoder().encode(content);
    return new Response(
      new ReadableStream({
        start(controller) {
          for (let i = 0; i < bytes.length; i += 7) controller.enqueue(bytes.slice(i, i + 7));
          controller.close();
        },
      }),
    );
  };
  return { calls, fetchImpl };
}

test('分析入力は7項目と希望条件・出所。URL等を追加せず、文字数超過を切り捨てない', () => {
  const input = analysisInput({ ...values, sourceUrl: 'https://secret.test/?id=x' }, ' 業務改善を重視 ');
  assert.equal(input.preferences, '業務改善を重視');
  assert.equal(Object.keys(input.fields).length, 7);
  assert.equal(JSON.stringify(input).includes('secret.test'), false);
  assert.throws(() => analysisInput({ title: '職種だけ' }));
  assert.throws(() => analysisInput(values, 'x'.repeat(2001)));
  assert.throws(() => analysisInput({ ...values, description: 'x'.repeat(6001) }));
});

test('モデル一覧はローカルGGUFを選び、クラウドを除外', async () => {
  const { fetchImpl } = mock({
    models: [
      local,
      { ...local, name: 'cloud:cloud' },
      { ...local, name: 'remote', remote_host: 'cloud' },
      { name: 'no-format' },
    ],
  });
  assert.deepEqual(await listLocalModels(fetchImpl), ['gemma3:4b']);
});

test('日本語・分割NDJSONと条件ID・根拠参照を復元。履歴はモデルへ送らない', async () => {
  const { calls, fetchImpl } = mock();
  const output = await analyzeLocal(input, 'gemma3:4b', fetchImpl);
  assert.equal(output.result.evaluations[0].status, '一致');
  assert.equal(output.result.evaluations[0].evidence[0].evidence, '正社員');
  assert.equal(output.input.fields.company, values.company);
  const body = JSON.parse(calls.at(-1).init.body);
  assert.equal(body.stream, true);
  assert.equal(body.tools, undefined);
  const sent = JSON.parse(body.messages[1].content);
  assert.equal(sent.sources.find((source) => source.field === 'company').evidence, values.company);
  assert.equal(sent.criteria[0].text, 'ハード：正社員');
  assert.equal(sent.provenance, undefined);
  assert.equal(output.version, 2);
});

test('リモートのモデル・存在しないモデルには求人を送らない', async () => {
  const remote = mock({ details: { remote_host: 'https://cloud.test' } });
  await assert.rejects(analyzeLocal(input, 'gemma3:4b', remote.fetchImpl), /クラウドモデル/);
  assert.equal(
    remote.calls.some((call) => call.url.endsWith('/chat')),
    false,
  );
  const missing = mock();
  await assert.rejects(analyzeLocal(input, 'unavailable', missing.fetchImpl), /一覧から/);
  assert.equal(missing.calls.length, 1);
});

test('不正ID・空項目への引用・条件欠落を拒否し、根拠なし確定は要確認にする', () => {
  for (const change of [
    { evidenceIds: ['salary:0'] },
    { evidenceIds: ['description:999'] },
    { status: '判定保留' },
    { criterionId: 'unknown' },
  ])
    assert.throws(() => validateAnalysis({ evaluations: [{ ...row, ...change }] }, input));
  assert.throws(() => validateAnalysis({ evaluations: [] }, input));
  assert.throws(() => validateAnalysis({ evaluations: [row, row] }, input));
  assert.throws(() => validateAnalysis({ ...result, summary: '捏造年収' }, input));
  assert.equal(validateAnalysis({ evaluations: [{ ...row, evidenceIds: [] }] }, input).evaluations[0].status, '要確認');
  assert.throws(() => validateAnalysis({ evaluations: [row, row] }, analysisInput(values, '正社員\n社内開発')));
});

test('403・停止中・出力上限・不正形式・空条件を成功扱いにしない', async () => {
  await assert.rejects(listLocalModels(mock({ status: 403 }).fetchImpl), /OLLAMA_ORIGINS/);
  await assert.rejects(
    listLocalModels(async () => {
      throw new TypeError('Failed to fetch');
    }),
    /起動状態/,
  );
  await assert.rejects(analyzeLocal(input, 'gemma3:4b', mock({ reason: 'length' }).fetchImpl), /上限/);
  await assert.rejects(analyzeLocal(analysisInput(values), 'gemma3:4b', mock().fetchImpl), /希望条件/);
  assert.throws(() => validateAnalysis({ evaluations: 'invalid' }, input));
});

test('26件中23種類の返答で重複・欠落IDをまとめて診断する', () => {
  const many = analysisInput(values, Array.from({ length: 26 }, (_, i) => `条件${i + 1}`).join('\n'));
  const ids = [...Array.from({ length: 20 }, (_, i) => `c${i + 1}`), 'c23', 'c24', 'c25', 'c23', 'c24', 'c25'];
  assert.throws(
    () => validateAnalysis({ evaluations: ids.map((criterionId) => ({ ...row, criterionId })) }, many),
    (error) => {
      assert.equal(error.name, 'AnalysisValidationError');
      assert.equal(error.details.stage, 'validateAnalysis');
      assert.equal(error.details.expectedCount, 26);
      assert.equal(error.details.receivedCount, 26);
      assert.deepEqual(error.details.duplicateIds, ['c23', 'c24', 'c25']);
      assert.deepEqual(error.details.missingIds, ['c21', 'c22', 'c26']);
      assert.deepEqual(error.details.unknownIds, []);
      assert.match(error.message, /期待26件／受信26件/);
      assert.match(error.message, /重複ID：c23, c24, c25/);
      assert.match(error.message, /欠落ID：c21, c22, c26/);
      return true;
    },
  );
});

test('件数不一致でも行の不正・未知IDを収集し、本文を診断に含めない', () => {
  assert.throws(
    () =>
      validateAnalysis(
        {
          evaluations: [
            null,
            { ...row, criterionId: 'unknown', status: 'invalid', reason: '', evidenceIds: ['missing'] },
          ],
        },
        input,
      ),
    (error) => {
      assert.equal(error.details.expectedCount, 1);
      assert.equal(error.details.receivedCount, 2);
      assert.deepEqual(error.details.missingIds, ['c1']);
      assert.deepEqual(error.details.unknownIds, ['unknown']);
      assert.match(error.message, /evaluations\[0\]/);
      assert.match(error.message, /\.status/);
      assert.match(error.message, /\.reason/);
      assert.match(error.message, /存在しない根拠ID/);
      assert.ok(!JSON.stringify(error.details).includes(values.description));
      return true;
    },
  );
  for (const evaluations of [undefined, 'invalid']) {
    assert.throws(
      () => validateAnalysis({ evaluations }, input),
      (error) => {
        assert.equal(error.details.receivedCount, null);
        assert.match(error.message, /配列ではありません/);
        return true;
      },
    );
  }
  assert.equal(
    validateAnalysis({ evaluations: [{ ...row, status: '不一致', evidenceIds: [] }] }, input).evaluations[0].status,
    '要確認',
  );
});

test('根拠ID・範囲・入力の同一性を照合し、長い日本語・絵文字を欠落させない', () => {
  const long = analysisInput({ ...values, description: 'あ'.repeat(650) + '😀末尾' });
  const sources = evidenceSources(long).filter((source) => source.field === 'description');
  assert.equal(sources.map((source) => source.evidence).join(''), long.fields.description);
  assert.deepEqual(verifyEvidence(sources.at(-1), long), sources.at(-1));
  for (const change of [{ evidence: '書き換え' }, { field: 'salary' }, { start: 1 }, { origin: '元ページ抽出' }])
    assert.throws(() => verifyEvidence({ ...sources[0], ...change }, long), /一致/);
  const changed = structuredClone(long);
  changed.fields.description = '別の採用値';
  assert.throws(() => verifyEvidence(sources[0], changed), /一致/);
});

test('見出し・優先順位・プロフィールを分離し、全行の比較対象を確認できる', () => {
  const parsed = parseCriteria(
    '除外条件\n客先常駐\nハード条件\n正社員\nあなたのプロフィールとして照合している内容\n実務経験：Java\n希望条件\n業務改善\n口コミで照合',
  );
  assert.equal(parsed.criteria.length, 4);
  assert.equal(parsed.criteria[0].priority, 0);
  assert.equal(parsed.criteria[1].priority, 1);
  assert.equal(parsed.profile, '実務経験：Java');
  assert.equal(parsed.criteria.at(-1).external, true);
  assert.throws(() => parseCriteria(Array(41).fill('条件').join('\n')), /40行/);
});

test('求人票内の不足は要確認、外部照合の未実施は未調査に区別する', () => {
  const input = analysisInput(values, 'ハード：リモート勤務\n外部調査：口コミを検索');
  const output = validateAnalysis(
    {
      evaluations: [
        { ...row, status: '要確認', reason: '記載不足', evidenceIds: [] },
        { ...row, criterionId: 'c2', status: '一致', reason: '口コミ良好', evidenceIds: [] },
      ],
    },
    input,
  );
  assert.deepEqual(
    output.evaluations.map((row) => row.status),
    ['要確認', '未調査'],
  );
  assert.equal(output.questions[0].criterionId, 'c1');
  // 外部調査でない条件への「未調査」は拒否せず、要確認へ補正して元の判定を残す（詳細は analysis-correction.test.js）。
  const corrected = validateAnalysis(
    { evaluations: [{ ...row, status: '未調査', evidenceIds: [] }] },
    analysisInput(values, 'リモート勤務'),
  ).evaluations[0];
  assert.equal(corrected.status, '要確認');
  assert.equal(corrected.correction.originalStatus, '未調査');
});

test('採用元未確認の直接表示も求人原文の事実としては扱わない', () => {
  assert.equal(directInformation(input)[0].origin, '採用元未確認');
  const reordered = Object.fromEntries(Object.entries(input).reverse());
  reordered.fields = Object.fromEntries(Object.entries(input.fields).reverse());
  assert.equal(analysisSignature(input), analysisSignature(reordered));
  reordered.provenance = { ...input.provenance, company: { ...input.provenance.company, origin: '利用者修正' } };
  assert.notEqual(analysisSignature(input), analysisSignature(reordered));
});
