'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function harness() {
  const local = deferred(), helpers = [], reads = [];
  class Worker {
    constructor() { helpers.push(this); }
    postMessage(message, transfer) { this.message = structuredClone(message, { transfer }); }
    terminate() { this.stopped = true; }
  }
  const context = { self: { location: { href: 'http://localhost/worker.js' } }, Worker, performance, Uint8Array, ArrayBuffer,
    require(name) {
      if (name === '../src/comparison') return { MAX_BYTES: 8 * 1024 * 1024 };
      if (name === '../src/xlsx-core') return { readWorkbookData: (_Workbook, bytes) => { reads.push(bytes); return local.promise; } };
      return {};
    }
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../media/worker-entry.js'), 'utf8') + '\nglobalThis.readPair = workbookPairReader;', context);
  return { local, helpers, reads, read: inputs => context.readPair(inputs) };
}

test('both parsers start before either finishes, transfer bytes, and keep left/right order', async () => {
  const h = harness(), left = new Uint8Array([1]), right = new Uint8Array([2]);
  const pending = h.read([left, right]);
  assert.equal(h.reads.length, 1);
  assert.equal(h.helpers.length, 1);
  const helper = h.helpers[0];
  assert.equal(right.byteLength, 0, 'right bytes transferred, not copied');
  assert.deepEqual(new Uint8Array(helper.message.input), new Uint8Array([2]));
  helper.onmessage({ data: { data: { workbook: ['right'] } } });
  assert.equal(helper.stopped, true, 'helper exits as soon as its result arrives');
  h.local.resolve(['left']);
  assert.equal(JSON.stringify(await pending), '[["left"],["right"]]');
});

test('helper failure waits for local parser before recovery and cleans up the worker', async () => {
  const h = harness();
  let completed = false;
  const pending = h.read([new Uint8Array([1]), new Uint8Array([2])]);
  const checked = assert.rejects(pending, /remote failure/).then(() => { completed = true; });
  h.helpers[0].onmessage({ data: { error: 'remote failure' } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(completed, false, 'must not allow next request to overlap a still-running local parser');
  h.local.resolve(['left']);
  await checked;
  assert.equal(h.helpers[0].stopped, true);
});

test('local failure and worker startup/clone failures never leave a helper alive', async () => {
  for (const failure of ['local', 'startup', 'clone']) {
    const h = harness();
    const pending = h.read([new Uint8Array([1]), new Uint8Array([2])]);
    const checked = assert.rejects(pending, /local failure|辅助解析/);
    if (failure === 'local') {
      h.local.reject(new Error('local failure'));
      h.helpers[0].onmessage({ data: { data: { workbook: ['right'] } } });
    } else {
      if (failure === 'startup') h.helpers[0].onerror({ preventDefault() {} });
      else h.helpers[0].onmessageerror();
      h.local.resolve(['left']);
    }
    await checked;
    assert.equal(h.helpers[0].stopped, true);
  }
});

test('one empty side uses no helper and preserves side position', async () => {
  for (const empty of [0, 1]) {
    const h = harness(), inputs = [new Uint8Array([1]), new Uint8Array([2])];
    inputs[empty] = new Uint8Array();
    const pending = h.read(inputs);
    h.local.resolve(['content']);
    const result = await pending;
    assert.equal(result[empty].length, 0);
    assert.deepEqual(result[1-empty], ['content']);
    assert.equal(h.helpers.length, 0);
    assert.equal(h.reads.length, 1);
  }
});

test('failed Go snapshots retain the requested worksheet range', async () => {
  const context = { self: {}, performance, require(name) { return require(path.resolve(__dirname, '../media', name)); } };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../media/worker-entry.js'), 'utf8') + '\nglobalThis.handle = handle;', context);
  for (const sheetSelection of [{ mode: 'first' }, { mode: 'all' }, { mode: 'named', names: ['中文, table'] }]) {
    const result = await context.handle({ action: 'load', snapshot: { sources: ['old.xlsx', 'new.xlsx'],
      xlsx: true, sheetSelection, error: '无法读取 XLSX' } });
    assert.deepEqual(result.sheetSelection, sheetSelection);
    assert.equal(result.error, '无法读取 XLSX');
  }
});
