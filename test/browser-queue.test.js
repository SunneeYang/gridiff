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
  let worker, events, generation = 1, hold = Promise.resolve();
  const snapshot = { generation: 1, sources: ['old.csv', 'new.csv'], xlsx: false, inputs: ['id\n1', 'id\n2'] };
  const window = { dispatchEvent: event => emitted.push(event.data) };
  const context = { window, URLSearchParams, location: { hash: '', pathname: '/s/test/' }, performance, AbortSignal,
    Worker: class { constructor() { worker = this; } postMessage(message) { posted.push(message); } terminate() {} },
    MessageEvent: class { constructor(_type, { data }) { this.data = data; } },
    EventSource: class { constructor() { events = this; } close() {} },
    sessionStorage: { getItem: key => storage.get(key), setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) },
    document: { querySelector: () => null, getElementById: () => ({ hidden: true, textContent: '' }) },
    setInterval: () => 1, clearInterval: () => {}, queueMicrotask,
    fetch: async () => { await hold; return { status: 200, ok: true, json: async () => ({ ...snapshot }) }; }
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../media/browser.js'), 'utf8'), context);
  return { posted, emitted, host: window.gridiffHost,
    newSnapshot(next, barrier = Promise.resolve()) { snapshot.generation = next; hold = barrier; events.onmessage({ data: String(next) }); },
    deliver(message, error) {
      if (!error && message.snapshot) generation = message.snapshot.generation;
      worker.onmessage({ data: error ? { id: message.id, error } : { id: message.id, data: { type: 'comparison', generation, presentation: message.id,
        revision: 1, viewState: message.view, settings: {}, result: null, error: '', sources: snapshot.sources, options: {}, sheets: [] } } });
    }
  };
}

test('a failed Worker operation does not strand the latest queued view', async () => {
  const h = harness();
  h.host.postMessage({ action: 'ready', view: initialView }); await tick();
  h.deliver(h.posted[0]); await tick();
  h.host.postMessage({ action: 'swap' }); await tick();
  h.host.postMessage({ action: 'view', view: { ...initialView, query: 'latest' } });
  h.deliver(h.posted[1], 'forced Worker failure'); await tick(); await tick();
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
  assert.equal(h.posted[2].snapshot.generation, 2);
  assert.equal(h.posted[2].view.query, 'new-input');
  assert.ok(h.emitted.some(message => message.type === 'snapshot-replacing'));
  assert.equal(h.emitted.filter(message => message.type === 'comparison' && !message.busy).length, 1);
  h.deliver(h.posted[2]); await tick();
  assert.equal(h.emitted.at(-1).generation, 2);
});
