'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const tick = () => new Promise(resolve => setImmediate(resolve));
const initialView = { view: 'grid', onlyChanges: true, onlyFields: true, query: '', page: 0 };
function harness() {
  const posted = [], emitted = [], storage = new Map();
  let events, hold = Promise.resolve();
  const pending = new Map();
  const snapshot = { generation: 1, sources: ['old.csv', 'new.csv'], xlsx: false };
  const window = { dispatchEvent: event => emitted.push(event.data) };
  const context = { window, URLSearchParams, location: { hash: '', pathname: '/s/test/' }, performance, AbortSignal,
    Worker: class { constructor() { throw new Error('native transport must not start a Worker'); } },
    MessageEvent: class { constructor(_type, { data }) { this.data = data; } },
    EventSource: class { constructor() { events = this; } close() {} },
    sessionStorage: { getItem: key => storage.get(key), setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) },
    document: { querySelector: () => null, getElementById: () => ({ hidden: true, textContent: '' }) },
    setInterval: () => 1, clearInterval: () => {}, queueMicrotask,
    fetch: async (endpoint, options) => {
      if (endpoint === 'snapshot') { await hold; return { status: 200, ok: true, json: async () => ({ ...snapshot }) }; }
      assert.equal(endpoint, 'compare');
      const message = JSON.parse(options.body); posted.push(message);
      return new Promise(resolve => { pending.set(message.id, resolve); });
    }
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../media/browser.js'), 'utf8'), context);
  return { posted, emitted, host: window.gridiffHost,
    newSnapshot(next, barrier = Promise.resolve()) { snapshot.generation = next; hold = barrier; events.onmessage({ data: String(next) }); },
    deliver(message, error, status = error ? 400 : 200, settings = {}) {
      const resolve = pending.get(message.id); assert.ok(resolve, 'comparison request is pending'); pending.delete(message.id);
      resolve({ status, ok: status === 200, json: async () => error ? { error, generation: snapshot.generation } :
        { id: message.id, data: { type: 'comparison', generation: message.generation, presentation: message.id,
          revision: 1, viewState: message.view, settings, result: null, error: '', sources: snapshot.sources, options: {}, sheets: [] } } });
    }
  };
}

test('a failed native comparison does not strand the latest queued view', async () => {
  const h = harness();
  h.host.postMessage({ action: 'ready', view: initialView }); await tick();
  h.deliver(h.posted[0]); await tick();
  h.host.postMessage({ action: 'swap' }); await tick();
  h.host.postMessage({ action: 'view', view: { ...initialView, query: 'latest' } });
  h.deliver(h.posted[1], 'forced native failure'); await tick(); await tick();
  assert.equal(h.posted[2].action, 'view');
  assert.equal(h.posted[2].view.query, 'latest');
});

test('snapshot replacement discards stale results but preserves input typed during fetch', async () => {
  const h = harness();
  h.host.postMessage({ action: 'ready', view: initialView }); await tick();
  h.deliver(h.posted[0]); await tick();
  h.host.postMessage({ action: 'swap' }); await tick();
  let release;
  const barrier = new Promise(resolve => { release = resolve; });
  h.newSnapshot(2, barrier);
  h.deliver(h.posted[1]); await tick();
  h.host.postMessage({ action: 'view-pending', view: { ...initialView, query: 'new-input' } });
  h.newSnapshot(2, barrier); // A reconnect notification must not reset the same in-flight generation.
  release(); await tick();
  assert.equal(h.posted[2].action, 'load');
  assert.equal(h.posted[2].generation, 2);
  assert.equal(Object.hasOwn(h.posted[2], 'snapshot'), false);
  assert.equal(h.posted[2].view.query, 'new-input');
  assert.ok(h.emitted.some(message => message.type === 'snapshot-replacing'));
  assert.equal(h.emitted.filter(message => message.type === 'comparison' && !message.busy).length, 1);
  h.deliver(h.posted[2]); await tick();
  assert.equal(h.emitted.at(-1).generation, 2);
});

test('HTTP 409 reloads the newest snapshot instead of showing a stale response', async () => {
  const h = harness();
  h.host.postMessage({ action: 'ready', view: initialView }); await tick();
  h.deliver(h.posted[0]); await tick();
  h.host.postMessage({ action: 'swap' }); await tick();
  h.newSnapshot(2);
  h.deliver(h.posted[1], 'comparison replaced', 409); await tick(); await tick();
  assert.equal(h.posted[2].action, 'load');
  assert.equal(h.posted[2].generation, 2);
  h.deliver(h.posted[2]); await tick();
  assert.equal(h.emitted.at(-1).generation, 2);
});


test('stale view responses retain accepted swap settings for the next request', async () => {
  const h = harness();
  h.host.postMessage({ action: 'ready', view: initialView }); await tick();
  h.deliver(h.posted[0]); await tick();
  h.host.postMessage({ action: 'swap' }); await tick();
  h.host.postMessage({ action: 'view', view: { ...initialView, query: 'latest' } });
  h.deliver(h.posted[1], null, 200, { swapped: true, options: { alignment: 'position' } }); await tick(); await tick();
  assert.equal(h.posted[2].action, 'view');
  assert.equal(h.posted[2].view.query, 'latest');
  assert.deepEqual(h.posted[2].settings, { swapped: true, options: { alignment: 'position' } });
});
