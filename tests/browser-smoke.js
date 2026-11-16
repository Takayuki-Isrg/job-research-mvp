// Integration harness: test-only permissions and intercepted fixtures never access real RA pages.
// Native context-menu selection and the production activeTab grant remain manual checks.
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFile, mkdir, cp, writeFile, mkdtemp, appendFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const base = fileURLToPath(new URL('../', import.meta.url));
const results = path.join(base, 'test-results');
await mkdir(results, { recursive: true });

const temp = await mkdtemp(path.join(tmpdir(), 'job-research-test-'));
const extension = path.join(temp, 'extension');
await cp(path.join(base, 'extension'), extension, { recursive: true });

// テスト用にlocalhostと、横取りするRA検証URLへのアクセス権限を追加
const manifestPath = path.join(extension, 'manifest.json');
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
manifest.host_permissions = ['http://127.0.0.1/*', 'https://mypage.r-agent.com/*'];
await writeFile(manifestPath, JSON.stringify(manifest));

await appendFile(path.join(extension, 'background.js'), '\nglobalThis.__captureJob = captureJob;\n');

const server = createServer(async (req, res) => {
  const route = new URL(req.url, 'http://localhost').pathname;
  let name = { '/detail': 'detail', '/structured': 'structured', '/list': 'list', '/article': 'article' }[route];

  if (route === '/pending') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end('<main><h1>開発エンジニア募集</h1><h2>応募資格</h2><p>開発経験</p></main>');
    return;
  }
  if (!name) {
    res.writeHead(404);
    res.end();
    return;
  }

  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(await readFile(path.join(base, 'tests', 'fixtures', `${name}.html`)));
});

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
let context;
const errors = [];
const network = [];
const raFixtureUrl = 'https://mypage.r-agent.com/joboffers/9000000001';
const raSectionsUrl = 'https://mypage.r-agent.com/joboffers/9000000002';
const raFixtures = new Map([
  [raFixtureUrl, 'ra-header.html'],
  [raSectionsUrl, 'ra-sections.html'],
]);

try {
  context = await chromium.launchPersistentContext(path.join(temp, 'profile'), {
    channel: 'chromium',
    headless: true,
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
  });

  await context.route('https://mypage.r-agent.com/**', async (route) => {
    const fixtureName = raFixtures.get(route.request().url());
    if (!fixtureName) return route.abort();
    await route.fulfill({
      status: 200,
      contentType: 'text/html; charset=utf-8',
      body: await readFile(path.join(base, 'tests', 'fixtures', fixtureName), 'utf8'),
    });
  });

  context.on('page', (page) => page.on('pageerror', (error) => errors.push(error.message)));
  context.on('request', (request) => {
    if (/^https?:/.test(request.url()) && !request.url().startsWith(origin) && !raFixtures.has(request.url()))
      network.push(request.url());
  });

  const worker = context.serviceWorkers()[0] || (await context.waitForEvent('serviceworker'));
  const extensionOrigin = `chrome-extension://${new URL(worker.url()).host}`;
  const reviewPages = [];

  async function capture(route) {
    const source = await context.newPage();
    await source.goto(route.startsWith('https://') ? route : `${origin}${route}`);

    const sourceUrl = source.url();
    await worker.evaluate(async (sourceUrl) => {
      for (let i = 0; i < 50; i++) {
        const tab = (await chrome.tabs.query({})).find((t) => t.url === sourceUrl);
        if (tab?.status === 'complete') return;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      throw new Error('Source tab did not finish loading');
    }, sourceUrl);

    const pagePromise = context.waitForEvent('page', {
      predicate: (page) => page.url().startsWith(extensionOrigin + '/review.html'),
    });
    pagePromise.catch(() => {});

    const record = await worker.evaluate(async (sourceUrl) => {
      const tabs = await chrome.tabs.query({});
      const tab = tabs.find((t) => t.url === sourceUrl);
      return globalThis.__captureJob(chrome, tab, sourceUrl);
    }, sourceUrl);
    assert.equal(record.status, 'ready', JSON.stringify(record));

    const review = await pagePromise;
    await review.waitForSelector('#result:not([hidden])');
    reviewPages.push(review);

    return { source, review, record };
  }

  const detail = await capture('/detail');

  assert.equal(await detail.review.locator('#status').textContent(), '求人票');
  assert.equal(await detail.review.locator('#field-company').inputValue(), 'サンプル株式会社');
  assert.match(await detail.review.locator('#missing').textContent(), /勤務地.*給与/);
  assert.equal(await detail.review.locator('#company-original').textContent(), 'サンプル株式会社');
  assert.equal(await detail.review.locator('#company-override').textContent(), '修正なし');
  assert.equal(await detail.review.locator('#company-adopted').textContent(), 'サンプル株式会社');

  await detail.review.locator('#field-company').fill('修正後の株式会社');
  // Unsaved edits must not be presented as already adopted by the assessment.
  assert.equal(await detail.review.locator('#company-adopted').textContent(), 'サンプル株式会社');
  await detail.review.locator('#recheck').click();
  await detail.review.waitForFunction(
    () => document.querySelector('#company-adopted').textContent === '修正後の株式会社',
  );
  assert.equal(await detail.review.locator('#company-original').textContent(), 'サンプル株式会社');
  assert.equal(await detail.review.locator('#company-override').textContent(), '修正後の株式会社');
  assert.match(await detail.review.locator('#company-adopted-source').textContent(), /利用者の修正値/);

  const savedCompany = await worker.evaluate(
    async (id) => (await chrome.storage.session.get(`job:${id}`))[`job:${id}`],
    detail.record.id,
  );
  assert.equal(savedCompany.snapshot.fields.company.value, 'サンプル株式会社');
  assert.equal(savedCompany.overrides.company, '修正後の株式会社');
  assert.equal(savedCompany.assessment.values.company, '修正後の株式会社');

  await detail.review.reload();
  await detail.review.waitForSelector('#result:not([hidden])');
  assert.equal(await detail.review.locator('#company-original').textContent(), 'サンプル株式会社');
  assert.equal(await detail.review.locator('#company-adopted').textContent(), '修正後の株式会社');
  await detail.review.screenshot({ path: path.join(results, 'review-desktop.png'), fullPage: true });

  await detail.review.locator('#field-company').fill('');
  await detail.review.locator('#recheck').click();
  await detail.review.waitForFunction(
    () => document.querySelector('#company-override').textContent === '空欄に修正（企業名未指定）',
  );
  assert.equal(await detail.review.locator('#company-adopted').textContent(), '未取得（企業名未指定）');
  assert.equal(await detail.review.locator('#company-original').textContent(), 'サンプル株式会社');
  await detail.review.locator('#reset').click();
  await detail.review.waitForFunction(() => document.querySelector('#company-override').textContent === '修正なし');
  assert.equal(await detail.review.locator('#company-adopted').textContent(), 'サンプル株式会社');
  assert.match(await detail.review.locator('#company-adopted-source').textContent(), /元ページの抽出値/);

  const pending = await capture('/pending');
  assert.equal(await pending.review.locator('#status').textContent(), '判定保留');
  await pending.review.locator('#field-description').fill('社内の業務改善システムを開発します。');
  await pending.review.locator('#field-company').fill('<img src=x onerror="window.injected=true">サンプル株式会社');
  await pending.review.locator('#recheck').click();
  await pending.review.waitForFunction(() => document.querySelector('#status').textContent === '求人票');
  assert.match(await pending.review.locator('label[for="field-company"]').textContent(), /利用者修正/);
  assert.equal(await pending.review.locator('#fields img').count(), 0);
  assert.equal(await pending.review.evaluate(() => window.injected), undefined);
  assert.equal(await pending.review.locator('#company-original').textContent(), '未取得');
  assert.match(await pending.review.locator('#company-override').textContent(), /<img/);
  assert.match(await pending.review.locator('#company-adopted').textContent(), /<img/);
  assert.equal(await pending.review.locator('.company-values img').count(), 0);

  await pending.review.reload();
  await pending.review.waitForSelector('#result:not([hidden])');
  assert.match(await pending.review.locator('#field-company').inputValue(), /<img/);
  await pending.review.setViewportSize({ width: 390, height: 844 });
  await pending.review.screenshot({ path: path.join(results, 'review-mobile.png'), fullPage: true });

  await pending.review.locator('#reset').click();
  await pending.review.waitForFunction(() => document.querySelector('#status').textContent === '判定保留');
  assert.equal(await pending.review.locator('#field-company').inputValue(), '');

  for (const route of ['/list', '/article', '/structured']) {
    const { review } = await capture(route);
    assert.equal(await review.locator('#status').textContent(), route === '/structured' ? '求人票' : '対象外');
  }

  const ra = await capture(raFixtureUrl);
  assert.equal(await ra.review.locator('#company-original').textContent(), '検証用サンプル株式会社');
  assert.equal(
    await ra.review.locator('#field-title').inputValue(),
    '【AI活用推進】社内の業務改善を担当するエンジニア',
  );
  assert.equal(await ra.review.locator('#status').textContent(), '判定保留');
  assert.match(await ra.review.locator('#evidence-company').textContent(), /RA個別求人/);
  await ra.review.locator('#field-company').fill('RA修正後の検証株式会社');
  await ra.review.locator('#recheck').click();
  await ra.review.waitForFunction(
    () => document.querySelector('#company-adopted').textContent === 'RA修正後の検証株式会社',
  );
  assert.equal(await ra.review.locator('#company-original').textContent(), '検証用サンプル株式会社');
  await ra.review.locator('#reset').click();
  await ra.review.waitForFunction(
    () => document.querySelector('#company-adopted').textContent === '検証用サンプル株式会社',
  );
  assert.equal(await ra.review.locator('#company-override').textContent(), '修正なし');

  const raSections = await capture(raSectionsUrl);
  assert.match(await raSections.review.locator('#field-qualifications').inputValue(), /業務プロセスの改善経験/);
  assert.match(await raSections.review.locator('#field-location').inputValue(), /検証オフィス/);
  assert.doesNotMatch(await raSections.review.locator('#field-location').inputValue(), /配属先|転勤|残業|面接/);
  assert.doesNotMatch(await raSections.review.locator('#missing').textContent(), /応募資格|勤務地/);

  // Closing one result must not delete another result's session data.
  await detail.review.close();
  await worker.evaluate(async (id) => {
    const key = `job:${id}`;
    for (let i = 0; i < 30; i++) {
      if (!(await chrome.storage.session.get(key))[key]) return;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error('Closed result was not deleted');
  }, detail.record.id);
  assert.equal(await pending.review.locator('#status').textContent(), '判定保留');
  assert.deepEqual(errors, []);
  assert.deepEqual(network, []);

  const report = {
    passed: true,
    fixtures: 7,
    checks: [
      'extract/classify',
      'edit/reclassify',
      'reset',
      'session reload',
      'tab isolation',
      'close cleanup',
      'HTML displayed as text',
      'RA header extraction/edit/reset using intercepted fixture',
      'RA qualifications/location section boundaries using intercepted fixture',
      'only localhost and intercepted RA fixture requests',
    ],
    nativeContextMenuAndActiveTab: 'manual check required',
    browser: context.browser().version(),
  };
  await writeFile(path.join(results, 'browser-report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} finally {
  if (context) await context.close();
  await new Promise((resolve) => server.close(resolve));
}
