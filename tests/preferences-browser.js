import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFile, cp, mkdtemp, appendFile, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const base = fileURLToPath(new URL('../', import.meta.url));
const temp = await mkdtemp(path.join(tmpdir(), 'job-preferences-test-'));
const extension = path.join(temp, 'extension');
await cp(path.join(base, 'extension'), extension, { recursive: true });
await appendFile(
  path.join(extension, 'background.js'),
  '\nglobalThis.__captureJob = captureJob;\nglobalThis.__openPreferences = () => openPreferences(chrome);\n',
);
const server = createServer(async (req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(await readFile(path.join(base, 'tests/fixtures/detail.html')));
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const sourceUrl = `http://127.0.0.1:${server.address().port}/detail`;
const KEY = 'sharedPreferences';
let context;
const errors = [];
const shared = async (worker) => worker.evaluate(async (key) => (await chrome.storage.local.get(key))[key], KEY);

try {
  context = await chromium.launchPersistentContext(path.join(temp, 'profile'), {
    channel: 'chromium',
    headless: true,
    acceptDownloads: true,
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
  });
  context.setDefaultTimeout(15000);
  context.on('page', (page) => page.on('pageerror', (error) => errors.push(error.message)));
  const worker = context.serviceWorkers()[0] || (await context.waitForEvent('serviceworker'));

  // アイコンのクリック処理：1回目は開き、2回目は同じタブを前面に出す。
  const opened = context.waitForEvent('page', { predicate: (page) => page.url().endsWith('/preferences.html') });
  const firstTab = await worker.evaluate(() => globalThis.__openPreferences());
  const prefs = await opened;
  await prefs.waitForSelector('#preferences-text:not([disabled])');
  const pagesBefore = context.pages().length;
  assert.equal(await worker.evaluate(() => globalThis.__openPreferences()), firstTab);
  assert.equal(context.pages().length, pagesBefore);
  assert.match(await prefs.locator('#save-status').textContent(), /まだ保存された希望条件はありません/);
  console.log('preferences: opened and focused');

  // 自動保存・復元
  const text = '除外条件\n客先常駐\nハード：年収450万円以上\n  希望：AI活用、業務改善  \n';
  await prefs.locator('#preferences-text').fill(text);
  assert.equal(await prefs.locator('#save-status').getAttribute('data-state'), 'dirty');
  await prefs.waitForSelector('#save-status[data-state="saved"]');
  assert.equal((await shared(worker)).text, text);
  await prefs.reload();
  await prefs.waitForSelector('#preferences-text:not([disabled])');
  assert.equal(await prefs.locator('#preferences-text').inputValue(), text);
  console.log('preferences: autosaved and restored');

  // 保存失敗：入力を消さず、再試行で保存できる
  await prefs.evaluate(() => {
    window.__set = chrome.storage.local.set;
    chrome.storage.local.set = () => Promise.reject(new Error('擬似的な保存失敗'));
  });
  const edited = `${text}希望：リモート可\n`;
  await prefs.locator('#preferences-text').fill(edited);
  await prefs.waitForSelector('#save-status[data-state="error"]');
  assert.match(await prefs.locator('#preferences-error').textContent(), /擬似的な保存失敗/);
  assert.equal(await prefs.locator('#preferences-text').inputValue(), edited);
  assert.equal(await prefs.locator('#retry').isVisible(), true);
  assert.equal((await shared(worker)).text, text, '失敗時は前回の保存内容が残る');
  await prefs.evaluate(() => (chrome.storage.local.set = window.__set));
  await prefs.locator('#retry').click();
  await prefs.waitForSelector('#save-status[data-state="saved"]');
  assert.equal((await shared(worker)).text, edited);
  assert.equal(await prefs.locator('#retry').isVisible(), false);
  console.log('preferences: save failure kept input and retry saved');

  // インポート：不正な文字コードは拒否、上書き前に確認、取り消しなら変更しない
  await prefs
    .locator('#import-file')
    .setInputFiles({ name: 'sjis.txt', mimeType: 'text/plain', buffer: Buffer.from([0x8f, 0x9c, 0x8a, 0x4f]) });
  await prefs.waitForSelector('#preferences-error:not([hidden])');
  assert.match(await prefs.locator('#preferences-error').textContent(), /UTF-8/);
  assert.equal(await prefs.locator('#preferences-text').inputValue(), edited);
  const imported = '﻿除外：客先常駐\r\n希望：社内SE、業務改善 😀\r\n';
  const file = { name: '希望条件.txt', mimeType: 'text/plain', buffer: Buffer.from(imported, 'utf8') };
  const dialogs = [];
  prefs.once('dialog', (dialog) => (dialogs.push(dialog.message()), dialog.dismiss()));
  await prefs.locator('#import-file').setInputFiles(file);
  await prefs.waitForFunction(() => document.querySelector('#save-status').textContent.includes('取り消しました'));
  assert.match(dialogs[0], /上書き/);
  assert.equal(await prefs.locator('#preferences-text').inputValue(), edited);
  assert.equal((await shared(worker)).text, edited);
  prefs.once('dialog', (dialog) => dialog.accept());
  await prefs.locator('#import-file').setInputFiles(file);
  // textarea はブラウザ仕様で改行をLFにそろえる。BOMは内容ではないので除く。
  const importedValue = '除外：客先常駐\n希望：社内SE、業務改善 😀\n';
  await prefs.waitForFunction((value) => document.querySelector('#preferences-text').value === value, importedValue);
  await prefs.waitForSelector('#save-status[data-state="saved"]');
  assert.equal((await shared(worker)).text, importedValue);
  console.log('preferences: import confirmed before overwrite');

  // エクスポート：UTF-8で表示中の内容をそのまま書き出す
  const downloading = prefs.waitForEvent('download');
  await prefs.locator('#export').click();
  const download = await downloading;
  assert.match(download.suggestedFilename(), /^希望条件_\d{8}-\d{4}\.txt$/);
  assert.equal(await readFile(await download.path(), 'utf8'), importedValue);
  console.log('preferences: exported UTF-8 text');

  // 求人確認画面：分析結果のない求人は共通条件を初期値にし、画面での変更は共通設定に書き込まない
  const source = await context.newPage();
  await source.goto(sourceUrl);
  await worker.evaluate(async (url) => {
    for (let i = 0; i < 50; i++) {
      if ((await chrome.tabs.query({})).find((tab) => tab.url === url)?.status === 'complete') return;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }, sourceUrl);
  const reviewOpened = context.waitForEvent('page', { predicate: (page) => page.url().includes('/review.html?id=') });
  const record = await worker.evaluate(async (url) => {
    const tab = (await chrome.tabs.query({})).find((tab) => tab.url === url);
    return globalThis.__captureJob(chrome, tab, url);
  }, sourceUrl);
  assert.equal(record.status, 'ready');
  const review = await reviewOpened;
  await review.waitForSelector('#result:not([hidden])');
  await review.waitForFunction(
    (value) => document.querySelector('#analysis-preferences').value === value,
    importedValue,
  );
  assert.match(await review.locator('#analysis-preferences-source').textContent(), /共通の希望条件を読み込みました/);
  assert.match(await review.locator('#analysis-criteria').textContent(), /c1 \/ 除外/);
  await review.locator('#analysis-preferences').fill('この求人だけの条件');
  await review.waitForTimeout(1500);
  assert.equal((await shared(worker)).text, importedValue, '確認画面の変更は共通設定を上書きしない');
  console.log('review: shared preferences used as default without write-back');

  // 求人ごとの条件（分析済み）は共通条件より優先し、明示操作でだけ共通条件に置き換える
  const jobKey = `job:${record.id}`;
  await worker.evaluate(
    async ({ key }) => {
      const current = (await chrome.storage.session.get(key))[key];
      await chrome.storage.session.set({
        [key]: { ...current, analysis: { version: 1, input: { preferences: '求人ごとの条件' } } },
      });
    },
    { key: jobKey },
  );
  const second = await context.newPage();
  await second.goto(review.url());
  await second.waitForSelector('#result:not([hidden])');
  await second.waitForTimeout(500);
  assert.equal(await second.locator('#analysis-preferences').inputValue(), '求人ごとの条件');
  assert.match(await second.locator('#analysis-preferences-source').textContent(), /前回分析/);
  second.once('dialog', (dialog) => dialog.accept());
  await second.locator('#load-shared-preferences').click();
  await second.waitForFunction(
    (value) => document.querySelector('#analysis-preferences').value === value,
    importedValue,
  );
  assert.equal((await shared(worker)).text, importedValue);
  const job = await worker.evaluate(async (key) => (await chrome.storage.session.get(key))[key], jobKey);
  assert.equal(job.analysis.input.preferences, '求人ごとの条件', '求人ごとの記録も書き換えない');
  console.log('review: per-job preferences take priority');

  await mkdir(path.join(base, 'test-results'), { recursive: true });
  await prefs.setViewportSize({ width: 1280, height: 900 });
  await prefs.screenshot({ path: path.join(base, 'test-results/preferences-desktop.png'), fullPage: true });
  await prefs.setViewportSize({ width: 390, height: 844 });
  await prefs.screenshot({ path: path.join(base, 'test-results/preferences-mobile.png'), fullPage: true });
  assert.ok(await prefs.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
  assert.deepEqual(errors, []);
  const report = {
    passed: true,
    checks: [
      'toolbar handler opens one preferences tab and focuses it again',
      'autosave after input stops, status display, restore on reload',
      'save failure keeps input, shows error, retry saves',
      'non-UTF-8 import rejected without changes',
      'import asks before overwriting; cancel keeps current text',
      'export downloads UTF-8 text identical to the editor',
      'review page uses shared preferences as default and never writes them',
      'per-job analyzed preferences take priority; explicit reload of shared preferences',
      'no horizontal scroll at 390px',
    ],
  };
  await writeFile(path.join(base, 'test-results/preferences-report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  console.log(JSON.stringify({ errors }));
  throw error;
} finally {
  if (context) await context.close();
  await new Promise((resolve) => server.close(resolve));
}
