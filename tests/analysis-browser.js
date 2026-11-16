import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFile, cp, mkdtemp, appendFile, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const base = fileURLToPath(new URL('../', import.meta.url));
const temp = await mkdtemp(path.join(tmpdir(), 'job-analysis-test-'));
const extension = path.join(temp, 'extension');
await cp(path.join(base, 'extension'), extension, { recursive: true });
await appendFile(path.join(extension, 'background.js'), '\nglobalThis.__captureJob = captureJob;\n');
const server = createServer(async (req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(await readFile(path.join(base, 'tests/fixtures/detail.html')));
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const sourceUrl = `http://127.0.0.1:${server.address().port}/detail`;
let context;
const calls = [],
  errors = [];
let failGeneration = false;
let invalidEvidence = false;
try {
  context = await chromium.launchPersistentContext(path.join(temp, 'profile'), {
    channel: 'chromium',
    headless: true,
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
  });
  context.setDefaultTimeout(15000);
  await context.route('http://127.0.0.1:11434/**', async (route) => {
    const request = route.request();
    calls.push({ url: request.url(), body: request.postDataJSON() });
    if (request.url().endsWith('/tags'))
      return route.fulfill({
        json: { models: ['gemma3:4b', 'gemma3:12b'].map((name) => ({ name, details: { format: 'gguf' } })) },
      });
    if (request.url().endsWith('/show'))
      return route.fulfill({
        json: {
          details: { format: 'gguf' },
          model_info: { 'general.architecture': 'gemma3' },
          capabilities: ['completion'],
        },
      });
    if (failGeneration) return route.fulfill({ status: 503, body: 'unavailable' });
    const sent = request.postDataJSON();
    const input = JSON.parse(sent.messages[1].content);
    const result = {
      evaluations: input.criteria.map((criterion) => ({
        criterionId: criterion.id,
        status: '要確認',
        reason: '<img src=x onerror=alert(1)>担当範囲を確認',
        evidenceIds: [invalidEvidence ? 'unknown:999' : 'company:0'],
        question: '担当範囲を確認してください。',
      })),
    };

    return route.fulfill({
      contentType: 'application/x-ndjson',
      body: JSON.stringify({ message: { content: JSON.stringify(result) }, done: true, done_reason: 'stop' }) + '\n',
    });
  });
  context.on('page', (page) => page.on('pageerror', (error) => errors.push(error.message)));
  const worker = context.serviceWorkers()[0] || (await context.waitForEvent('serviceworker'));
  const source = await context.newPage();
  await source.goto(sourceUrl);
  await worker.evaluate(async (url) => {
    for (let i = 0; i < 50; i++) {
      if ((await chrome.tabs.query({})).find((tab) => tab.url === url)?.status === 'complete') return;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }, sourceUrl);
  const pagePromise = context.waitForEvent('page', { predicate: (page) => page.url().includes('/review.html?id=') });
  pagePromise.catch(() => {});
  const record = await worker.evaluate(async (url) => {
    const tab = (await chrome.tabs.query({})).find((tab) => tab.url === url);
    return globalThis.__captureJob(chrome, tab, url);
  }, sourceUrl);
  assert.equal(record.status, 'ready');
  console.log('analysis: captured fixture');
  const review = await pagePromise;
  await review.waitForSelector('#result:not([hidden])');
  assert.equal(calls.length, 0);
  await review.locator('#load-models').click();
  await review.waitForFunction(() => document.querySelector('#analysis-model').value === 'gemma3:4b');
  console.log('analysis: models loaded');
  await review.locator('#analysis-model').selectOption('gemma3:12b');
  await review.waitForFunction(
    async () => (await chrome.storage.local.get('localLlmModel')).localLlmModel === 'gemma3:12b',
  );
  await review.locator('#load-models').click();
  await review.waitForFunction(() => !document.querySelector('#load-models').disabled);
  assert.equal(await review.locator('#analysis-model').inputValue(), 'gemma3:12b');
  await review
    .locator('#analysis-preferences')
    .fill('除外：客先常駐を中心とする仕事\nハード：年収437万円以上\n外部調査：口コミを検索');
  await review.locator('#analyze').click();
  await review.waitForFunction(() => document.querySelector('#analysis-status').textContent.includes('分析結果を保存'));
  console.log('analysis: generated result');
  assert.match(await review.locator('#analysis-facts').textContent(), /サンプル株式会社/);
  assert.equal(await review.locator('#analysis-result img').count(), 0);
  assert.equal(await review.locator('#analysis-stale').isVisible(), false);
  assert.match(await review.locator('#analysis-status').textContent(), /秒/);
  const chat = calls.find((call) => call.url.endsWith('/chat'));
  const input = JSON.parse(chat.body.messages[1].content);
  assert.equal(input.sources.find((source) => source.field === 'company').evidence, 'サンプル株式会社');
  assert.equal(input.criteria.length, 3);
  assert.equal(input.criteria[0].category, '除外');
  assert.equal(input.sourceUrl, undefined);
  await mkdir(path.join(base, 'test-results'), { recursive: true });
  await review.screenshot({ path: path.join(base, 'test-results/analysis-desktop.png'), fullPage: true });
  assert.equal(await review.locator('#analysis-evaluations tr').count(), 3);
  assert.match(await review.locator('#analysis-evaluations').textContent(), /未調査/);
  assert.match(await review.locator('#analysis-evaluations').textContent(), /company:0/);
  assert.match(await review.locator('#analysis-questions li').first().textContent(), /除外/);
  await review.locator('#analysis-evaluations details').first().locator('summary').click();
  assert.match(await review.locator('#analysis-evaluations').textContent(), /元ページ抽出/);
  await review.locator('.evaluation-scroll').screenshot({ path: path.join(base, 'test-results/analysis-table.png') });
  const generated = calls.filter((call) => call.url.endsWith('/chat')).length;
  await review.locator('#field-company').fill('修正後の株式会社');
  await review.locator('#analyze').click();
  await review.waitForFunction(() => document.querySelector('#analysis-status').textContent.includes('未反映の編集'));
  assert.equal(calls.filter((call) => call.url.endsWith('/chat')).length, generated);
  await review.locator('#recheck').click();
  await review.waitForFunction(() => document.querySelector('#company-adopted').textContent === '修正後の株式会社');
  assert.equal(await review.locator('#analysis-stale').isVisible(), true);
  await review.locator('#analyze').click();
  await review.waitForFunction(() => document.querySelector('#analysis-status').textContent.includes('分析結果を保存'));
  assert.match(await review.locator('#analysis-facts').textContent(), /利用者修正/);
  assert.match(await review.locator('#analysis-facts').textContent(), /修正後の株式会社/);
  assert.match(await review.locator('#analysis-facts').textContent(), /サンプル株式会社/);
  const saved = await worker.evaluate(async (key) => (await chrome.storage.session.get(key))[key], `job:${record.id}`);
  assert.equal(saved.snapshot.fields.company.value, 'サンプル株式会社');
  assert.equal(saved.analysis.input.provenance.company.origin, '利用者修正');
  assert.equal(saved.analysis.input.fields.company, '修正後の株式会社');
  invalidEvidence = true;
  await review.locator('#analyze').click();
  await review.waitForFunction(() => document.querySelector('#analysis-status').textContent.includes('根拠ID'));
  assert.match(await review.locator('#analysis-facts').textContent(), /修正後の株式会社/);
  invalidEvidence = false;
  failGeneration = true;
  await review.locator('#analyze').click();
  await review.waitForFunction(() =>
    document.querySelector('#analysis-status').textContent.includes('分析できませんでした'),
  );
  assert.equal(await review.locator('#field-company').inputValue(), '修正後の株式会社');
  assert.match(await review.locator('#analysis-facts').textContent(), /サンプル株式会社/);
  await review.locator('#field-company').fill('未保存の編集');
  await review.reload();
  await review.waitForSelector('#result:not([hidden])');
  await review.waitForFunction(() => document.querySelector('#analysis-model').value === 'gemma3:12b');
  assert.equal(await review.locator('#analysis-result').isVisible(), true);
  assert.equal(await review.locator('#analysis-stale').isVisible(), false);
  const callsBeforeNewTab = calls.length;
  const secondReview = await context.newPage();
  await secondReview.goto(review.url());
  await secondReview.waitForFunction(() => document.querySelector('#analysis-model').value === 'gemma3:12b');
  assert.equal(calls.length, callsBeforeNewTab);
  assert.deepEqual(errors, []);
  const report = {
    passed: true,
    ollama: 'mocked; no real job data sent',
    checks: [
      'manual-only analysis',
      'saved adopted values',
      'evidence display and source provenance',
      'condition table and priority questions',
      'invalid evidence rejected without overwriting previous analysis',
      'corrections used by analysis while extraction remains unchanged',
      'unsaved edits blocked',
      'stale results marked',
      'failure preserves extraction',
      'session reload',
      'model selection persists and survives list refresh',
      'new review tab restores model without network requests',
      'HTML rendered as text',
    ],
  };
  await mkdir(path.join(base, 'test-results'), { recursive: true });
  await writeFile(path.join(base, 'test-results/analysis-report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  if (context) {
    console.log(
      JSON.stringify({
        errors,
        pages: await Promise.all(
          context.pages().map(async (page) => ({
            url: page.url(),
            text: await page
              .locator('body')
              .innerText()
              .catch(() => ''),
          })),
        ),
      }),
    );
  }
  throw error;
} finally {
  if (context) await context.close();
  await new Promise((resolve) => server.close(resolve));
}
