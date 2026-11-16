import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { extractPage } from '../extension/extract-page.js';
import { classify, sanitizeOverrides } from '../extension/classify.js';

const fixture = (name) => readFileSync(new URL(`fixtures/${name}.html`, import.meta.url), 'utf8');

export function extract(html) {
  const dom = new JSDOM(html, { url: 'https://example.test/jobs/42', runScripts: 'outside-only' });
  try {
    return JSON.parse(JSON.stringify(dom.window.eval(`(${extractPage.toString()})()`)));
  } finally {
    dom.window.close();
  }
}

const ld = (objects) => `<script type="application/ld+json">${JSON.stringify(objects)}</script>`;
const job = (title = '業務改善エンジニア') => ({
  '@type': 'JobPosting',
  title,
  description: '社内システムの改善と業務効率化を担当します。',
  hiringOrganization: { name: 'サンプル株式会社' },
});

test('JSON-LD @graphの単一求人を表示内容と照合し、給与と所在地を抽出', () => {
  const result = extract(fixture('structured'));

  assert.equal(classify(result).status, '求人票');
  assert.equal(result.fields.company.source, '構造化データ');
  assert.match(result.fields.company.evidence, /@graph/);
  assert.equal(result.fields.location.value, '東京都 港区');
  assert.match(result.fields.salary.value, /4500000〜7000000/);
});
test('構造化データなし、給与・勤務地なしでも本文から求人票を判定', () => {
  const result = extract(fixture('detail'));
  const assessment = classify(result);

  assert.equal(assessment.status, '求人票');
  assert.equal(result.fields.company.value, 'サンプル株式会社');
  assert.deepEqual(assessment.missing, ['location', 'salary']);
  assert.equal(result.fields.company.source, '本文');
});
test('給与・勤務地が両方なくても応募導線のみの補助で求人票になる', () => {
  const result = extract(
    '<main><h1>開発エンジニア</h1><h2>仕事内容</h2><p>社内向けの開発を担当します。</p><button>応募する</button></main>',
  );
  assert.equal(classify(result).status, '求人票');
});
test('企業名が不明・非公開なら求人票のまま企業調査保留', () => {
  for (const company of ['', '非公開企業']) {
    const result = extract(fixture('detail').replace('サンプル株式会社', company));
    const assessment = classify(result);
    assert.equal(assessment.status, '求人票');
    assert.equal(assessment.companyState, '未特定');
    assert.match(assessment.researchState, /保留/);
  }
});
test('求人一覧は対象外。会社名の修正だけで求人票に変わらない', () => {
  const result = extract(fixture('list'));
  assert.equal(classify(result).status, '対象外');
  assert.equal(classify(result, { company: 'サンプル株式会社' }).status, '対象外');
});
test('記事・会社概要・応募ボタンだけのページは対象外', () => {
  const pages = [
    fixture('article'),
    '<h1>会社概要</h1><p>会社名：サンプル株式会社</p><p>所在地：東京都</p>',
    '<h1>サービス紹介</h1><button>応募する</button>',
  ];
  for (const html of pages) assert.equal(classify(extract(html)).status, '対象外');
});
test('記事中の関連JobPostingだけで求人票にはしない', () => {
  const result = extract(fixture('article') + ld(job()));
  assert.equal(result.signals.structuredMatched, false);
  assert.notEqual(classify(result).status, '求人票');
  assert.equal(result.fields.company.value, null);
});
test('複数JobPostingで主対象不明なら保留、h1と本文に一意対応すれば確定', () => {
  const objects = [job(), job('営業マネージャー')];
  const unclear = extract(`<h1>採用情報</h1><p>仕事内容を紹介します。</p>${ld(objects)}`);
  assert.equal(classify(unclear).status, '判定保留');

  const clear = extract(`<h1>業務改善エンジニア</h1><p>${job().description}</p>${ld(objects)}`);
  assert.equal(classify(clear).status, '求人票');
});
test('同じ職種・仕事内容で複数企業なら保留、完全重複データは重複除去', () => {
  const html = `<h1>業務改善エンジニア</h1><p>${job().description}</p>`;
  assert.equal(
    classify(extract(html + ld([job(), { ...job(), hiringOrganization: { name: '別企業' } }]))).status,
    '判定保留',
  );
  assert.equal(classify(extract(html + ld([job(), job()]))).status, '求人票');
});
test('本文と構造化データの企業名が異なる場合は保留', () => {
  const result = extract(fixture('detail') + ld({ ...job(), hiringOrganization: { name: '異なる会社' } }));
  assert.equal(classify(result).status, '判定保留');
  assert.deepEqual(result.signals.conflicts, ['企業名']);

  const revised = classify(result, { company: '異なる会社' });
  assert.equal(revised.status, '求人票');
  assert.match(revised.reasons.join(''), /利用者の修正値/);
});
test('壊れたJSON-LDでも本文抽出を継続', () => {
  const result = extract(fixture('detail') + '<script type="application/ld+json">{invalid</script>');
  assert.equal(classify(result).status, '求人票');
  assert.match(result.warnings.join(''), /構文が不正/);
});
test('本文不足を保留にし、修正で再判定。原抽出値を維持', () => {
  const result = extract('<main><h1>開発エンジニア募集</h1><h2>応募資格</h2><p>開発経験</p></main>');
  const original = JSON.stringify(result);
  assert.equal(classify(result).status, '判定保留');

  const edits = sanitizeOverrides(result, {
    description: '社内向けシステムを開発します。',
    company: 'サンプル株式会社',
  });
  const assessment = classify(result, edits);

  assert.equal(assessment.status, '求人票');
  assert.equal(assessment.missing.includes('company'), false);
  assert.equal(assessment.externalActionsAllowed, false);
  assert.equal(JSON.stringify(result), original);
  assert.equal(classify(result, {}).status, '判定保留');
});
test('非表示・ナビ・サイトブランドを求人情報として混入させない', () => {
  const result = extract(
    '<header><p>会社名：求人媒体株式会社</p></header><main><h1>一般記事</h1><div hidden><h2>仕事内容</h2><p>隠された求人内容</p></div><div style="display:none"><p>会社名：秘密株式会社</p></div></main>',
  );
  assert.equal(result.fields.company.value, null);
  assert.equal(result.fields.description.value, null);
  assert.equal(classify(result).status, '対象外');
});
test('h2セクション・table・divラベルの本文抽出', () => {
  const result = extract(
    '<main><h1>開発エンジニア</h1><h2>仕事内容</h2><p>社内システムの開発</p><h2>応募資格</h2><p>開発経験</p><table><tr><th>会社名</th><td>サンプル株式会社</td></tr></table><div><span>雇用形態</span><span>正社員</span></div></main>',
  );
  assert.equal(result.fields.description.value, '社内システムの開発');
  assert.equal(result.fields.company.value, 'サンプル株式会社');
  assert.equal(result.fields.employmentType.value, '正社員');
  assert.equal(classify(result).status, '求人票');
});
test('修正値の消去は未取得扱い。不正な項目と過大入力を処理', () => {
  const result = extract(fixture('detail'));
  const overrides = sanitizeOverrides(result, { company: '', title: result.fields.title.value, unknown: 'ignored' });
  assert.deepEqual(overrides, { company: '' });
  assert.equal(classify(result, overrides).companyState, '未特定');
  assert.throws(() => sanitizeOverrides(result, { company: 'x'.repeat(6001) }));
});
