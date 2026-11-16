import { test } from 'node:test';
import assert from 'node:assert/strict';

test('menu registration waits for callbacks, coalesces lifecycle events, and recovers from errors', async (t) => {
  const listeners = {};
  const removals = [];
  const creations = [];
  const errors = [];
  const event = (name) => ({ addListener: (listener) => (listeners[name] = listener) });
  const api = {
    runtime: { onInstalled: event('installed'), onStartup: event('startup'), onMessage: event('message') },
    contextMenus: {
      // Deliberately return undefined, like the callback-only API.
      removeAll: (callback) => {
        removals.push(callback);
      },
      create: (properties, callback) => {
        creations.push({ properties, callback });
        return properties.id;
      },
      onClicked: event('clicked'),
    },
    tabs: { onRemoved: event('removed') },
    action: { onClicked: event('action') },
  };
  t.mock.method(console, 'error', (error) => errors.push(error));
  const originalChrome = Object.getOwnPropertyDescriptor(globalThis, 'chrome');
  Object.defineProperty(globalThis, 'chrome', { configurable: true, value: api });
  t.after(() => {
    if (originalChrome) Object.defineProperty(globalThis, 'chrome', originalChrome);
    else delete globalThis.chrome;
  });
  await import('../extension/background.js');
  const settle = () => new Promise((resolve) => setImmediate(resolve));
  assert.equal(typeof listeners.action, 'function', 'toolbar click must open the preferences page');

  listeners.installed();
  listeners.startup();
  assert.equal(removals.length, 1);
  assert.equal(creations.length, 0);
  removals[0]();
  await settle();
  assert.equal(creations.length, 1);
  assert.equal(creations[0].properties.id, 'inspect-job');
  listeners.startup();
  assert.equal(removals.length, 1, 'creation must finish before another registration starts');
  creations[0].callback();
  await settle();
  assert.equal(errors.length, 0);

  for (const stage of ['remove', 'create']) {
    listeners.startup();
    const removal = removals.at(-1);
    const previousCreations = creations.length;
    if (stage === 'create') {
      removal();
      await settle();
    }
    api.runtime.lastError = { message: `${stage} failed` };
    if (stage === 'remove') removal();
    else creations.at(-1).callback();
    delete api.runtime.lastError;
    await settle();
    assert.equal(errors.at(-1).message, `${stage} failed`);
    if (stage === 'remove') assert.equal(creations.length, previousCreations);
  }

  listeners.startup();
  assert.equal(removals.length, 4, 'failed registrations must allow retries');
  removals.at(-1)();
  await settle();
  creations.at(-1).callback();
  await settle();
  assert.equal(errors.length, 2);
});
