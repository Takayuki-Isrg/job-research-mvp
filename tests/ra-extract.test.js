import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { extractPage } from '../extension/extract-page.js';
import { classify } from '../extension/classify.js';

const header = readFileSync(new URL('fixtures/ra-header.html', import.meta.url), 'utf8');
const sections = readFileSync(new URL('fixtures/ra-sections.html', import.meta.url), 'utf8');
const detailUrl = 'https://mypage.r-agent.com/joboffers/9000000001';
const company = '検証用サンプル株式会社';
const title = '【AI活用推進】社内の業務改善を担当するエンジニア';

function extract(html = header, url = detailUrl) {
  const dom = new JSDOM(html, { url, runScripts: 'outside-only' });
  try {
    return JSON.parse(JSON.stringify(dom.window.eval(`(${extractPage.toString()})()`)));
  } finally {
    dom.window.close();
  }
}

test('RA個別求人：ラベルのない企業名とh1の職種を分離し、2項目だけなら判定保留', () => {
  const result = extract();
  assert.equal(result.fields.company.value, company);
  assert.equal(result.fields.title.value, title);
  assert.equal(result.fields.company.source, '本文');
  assert.match(result.fields.company.evidence, /RA.*JobInformation_corpName__/);
  assert.equal(classify(result).status, '判定保留');
  assert.equal(result.fields.description.value, null);
});

test('RA抽出は正しいHTTPSホストと個別求人パスに限定する', () => {
  for (const url of [
    'https://example.test/joboffers/9000000001',
    'https://mypage.r-agent.com.example.test/joboffers/9000000001',
    'http://mypage.r-agent.com/joboffers/9000000001',
    'https://mypage.r-agent.com/joboffers',
    'https://mypage.r-agent.com/joboffers/search',
    'https://mypage.r-agent.com/articles/9000000001',
  ]) {
    assert.equal(extract(header, url).fields.company.value, null, url);
  }
  assert.equal(extract(header, detailUrl + '/?view=detail#job').fields.company.value, company);
});

test('RAの生成クラス名の末尾変更やクラス順序変更に依存しない', () => {
  const html = header
    .replace(
      'Typography_normalTag__UH_7W JobInformation_corpName__PSii9',
      'JobInformation_corpName__NEW Typography_normalTag__OTHER',
    )
    .replace('JobInformation_title__fh45s', 'Typography_tag__NEW JobInformation_title__NEW');
  const result = extract(html);
  assert.equal(result.fields.company.value, company);
  assert.equal(result.fields.title.value, title);
});

test('RAではサイト別の職種見出しを主見出しとして扱う', () => {
  const result = extract(header.replace('<main>', '<main><h1>マイページ</h1>'));
  assert.equal(result.fields.title.value, title);
  assert.equal(result.signals.primaryHeading, title);
});

test('RAの企業名候補が複数で異なる場合は企業名を決め打ちしない', () => {
  const extra = '<p class="JobInformation_corpName__OTHER">別の検証株式会社</p>';
  const result = extract(header.replace('</main>', `${extra}</main>`));
  assert.equal(result.fields.company.value, null);
  assert.match(result.warnings.join(''), /RA.*企業名.*複数/);
});

test('RAの非表示・関連領域は企業名候補に混ぜず、同じ値の重複は許容する', () => {
  const extra =
    '<p hidden class="JobInformation_corpName__HIDDEN">非表示株式会社</p>' +
    '<aside><p class="JobInformation_corpName__RELATED">関連求人株式会社</p></aside>' +
    `<p class="JobInformation_corpName__DUPLICATE">${company}</p>`;
  const result = extract(header.replace('</main>', `${extra}</main>`));
  assert.equal(result.fields.company.value, company);
});

test('RAの企業名クラスがなくても、求人媒体名を企業名として補完しない', () => {
  const result = extract(header.replace('JobInformation_corpName__PSii9', 'Typography_normalTag__NEW'));
  assert.equal(result.fields.company.value, null);
  assert.equal(result.fields.title.value, title);
  assert.equal(classify(result).companyState, '未特定');
});

test('RAの職種が特定できなければ、企業名だけから個別求人を組み立てない', () => {
  const result = extract(header.replace('JobInformation_title__fh45s', 'Other_title__NEW'));
  assert.equal(result.fields.company.value, null);
});

test('RAの本文と対応する構造化データは、既存の照合・矛盾検出につなぐ', () => {
  const description = '社内の業務改善システムを設計し開発します。';
  const structured = {
    '@type': 'JobPosting',
    title,
    description,
    hiringOrganization: { name: '相違のある検証株式会社' },
  };
  const html =
    header.replace('</main>', `<h2>仕事内容</h2><p>${description}</p></main>`) +
    `<script type="application/ld+json">${JSON.stringify(structured)}</script>`;
  const result = extract(html);
  assert.equal(result.signals.structuredMatched, true);
  assert.equal(result.fields.company.value, company);
  assert.deepEqual(result.signals.conflicts, ['企業名']);
  assert.equal(classify(result).status, '判定保留');
});

test('RAの求める能力・経験を応募資格へ取得し、他の区画を混入させない', () => {
  const result = extract(sections);
  assert.match(result.fields.qualifications.value, /【必須】業務プロセスの改善経験/);
  assert.match(result.fields.qualifications.value, /【歓迎】AI関連ルールの策定経験/);
  assert.match(result.fields.qualifications.value, /学歴/);
  assert.doesNotMatch(result.fields.qualifications.value, /正社員|年収|検証オフィス|面接/);
  assert.match(result.fields.qualifications.evidence, /RA個別求人: 求める能力・経験/);
  assert.equal(classify(result).missing.includes('qualifications'), false);
});

test('RAの勤務地では勤務先・住所を保持し、配属先・転勤と後続区画を除外', () => {
  const result = extract(sections);
  assert.match(result.fields.location.value, /検証オフィス/);
  assert.match(result.fields.location.value, /東京都千代田区/);
  assert.match(result.fields.location.value, /検証駅 徒歩5分/);
  assert.doesNotMatch(result.fields.location.value, /配属先|DX推進部|残業|転勤|面接|正社員|年収/);
  assert.match(result.fields.location.evidence, /section\[aria-labelledby\]/);
});

test('RAの区画抽出はReact生成IDの値やクラス名末尾に依存しない', () => {
  const html = sections.replaceAll(':test:', ':changed:').replaceAll('__TEST', '__NEW');
  const result = extract(html);
  assert.match(result.fields.qualifications.value, /業務プロセスの改善経験/);
  assert.match(result.fields.location.value, /検証オフィス/);
  assert.doesNotMatch(result.fields.location.value, /DX推進部|転勤/);
});

test('RAの見出しと親sectionの結び付きが壊れていたら広い本文で補完しない', () => {
  const html = sections
    .replace('aria-labelledby=":experience:test:"', 'aria-labelledby="different-experience"')
    .replace('aria-labelledby=":location:test:"', 'aria-labelledby="different-location"');
  const result = extract(html);
  assert.equal(result.fields.qualifications.value, null);
  assert.equal(result.fields.location.value, null);
  assert.match(result.warnings.join(''), /求める能力・経験.*本文を確認できません/);
  assert.match(result.warnings.join(''), /勤務地.*本文を確認できません/);
});

test('RAの勤務地が配属先・転勤の区画だけなら、それらを勤務地にしない', () => {
  const dom = new JSDOM(sections);
  dom.window.document.querySelector('section[aria-labelledby=":office:test:"]').remove();
  const result = extract(dom.serialize());
  dom.window.close();
  assert.equal(result.fields.location.value, null);
  assert.match(result.warnings.join(''), /勤務地.*本文を確認できません/);
});

test('RAの能力・経験の非表示区画は除外し、異なる候補が複数なら保留情報を残す', () => {
  const dom = new JSDOM(sections);
  const section = dom.window.document.querySelector('section[aria-labelledby=":experience:test:"]');
  const duplicate = section.cloneNode(true);
  duplicate.querySelector('div').textContent = '異なる要件';
  duplicate.hidden = true;
  section.after(duplicate);
  const hiddenResult = extract(dom.serialize());
  assert.match(hiddenResult.fields.qualifications.value, /業務プロセスの改善経験/);
  duplicate.hidden = false;
  const ambiguous = extract(dom.serialize());
  dom.window.close();
  assert.equal(ambiguous.fields.qualifications.value, null);
  assert.match(ambiguous.warnings.join(''), /求める能力・経験.*複数/);
});

test('RA以外には能力・経験の専用抽出を適用しない', () => {
  assert.equal(extract(sections, 'https://example.test/joboffers/9000000001').fields.qualifications.value, null);
});
