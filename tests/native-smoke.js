// Interactive check of the production manifest: choose the context menu in this test window.
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFile, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const base = fileURLToPath(new URL('../', import.meta.url));
const extension = path.join(base, 'extension');
const html = await readFile(path.join(base, 'tests/fixtures/detail.html'));

const server = createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(html);
});

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
let context;

try {
  const profile = await mkdtemp(path.join(tmpdir(), 'job-native-test-'));
  context = await chromium.launchPersistentContext(profile, {
    channel: 'chromium',
    headless: false,
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
  });

  const worker = context.serviceWorkers()[0] || (await context.waitForEvent('serviceworker'));
  const source = context.pages()[0];
  await source.goto(origin + '/detail');
  console.log('NATIVE CHECK READY: right-click the sample page and choose この求人を調べる.');

  const review = await context.waitForEvent('page', {
    timeout: 240000,
    predicate: (p) => p.url().includes('/review.html?id='),
  });
  await review.waitForSelector('#result:not([hidden])', { timeout: 15000 });

  assert.equal(await review.locator('#status').textContent(), '求人票');
  assert.equal(await review.locator('#field-company').inputValue(), 'サンプル株式会社');

  const permissions = await worker.evaluate(() => chrome.runtime.getManifest().permissions);
  const manifest = await worker.evaluate(() => chrome.runtime.getManifest());
  assert.deepEqual(manifest.host_permissions, ['http://127.0.0.1/*']);
  assert.deepEqual(permissions, ['contextMenus', 'activeTab', 'scripting', 'storage']);

  const results = path.join(base, 'test-results');
  await mkdir(results, { recursive: true });
  await review.screenshot({ path: path.join(results, 'native-review.png'), fullPage: true });
  await writeFile(
    path.join(results, 'native-report.json'),
    JSON.stringify(
      {
        passed: true,
        productionManifest: true,
        nativeContextMenu: true,
        activeTab: true,
        browser: context.browser().version(),
      },
      null,
      2,
    ),
  );
  console.log('NATIVE CHECK PASSED: production permissions + context menu + extraction + review.');

  // Keep the result visible briefly for desktop inspection.
  await new Promise((resolve) => setTimeout(resolve, 20000));
} finally {
  if (context) await context.close();
  await new Promise((resolve) => server.close(resolve));
}
