'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { gunzipSync } = require('node:zlib');
const { chromium } = require('playwright');
const { createComparison } = require('../src/comparison');
const { readWorkbook } = require('../src/xlsx');
const { workbook } = require('./xlsx-fixtures');

const root = path.resolve(__dirname, '..');
const packed = path.join(root, 'cli/assets/worker.js.gz');
assert.ok(fs.existsSync(packed), 'Run npm run build:cli to prepare the browser worker');
const code = gunzipSync(fs.readFileSync(packed));
const comparable = value => Object.fromEntries(['result', 'error', 'options', 'xlsx', 'sheets', 'sheetName', 'skipped', 'keyFields'].filter(key => value[key] !== undefined).map(key => [key, value[key]]));

(async () => {
  const server = http.createServer((request, response) => {
    if (request.url === '/worker.js') { response.setHeader('Content-Type', 'text/javascript'); response.end(code); }
    else { response.setHeader('Content-Type', 'text/html'); response.end('<!doctype html><title>Worker parity test</title>'); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({ headless: true, channel: process.env.PLAYWRIGHT_CHANNEL || 'chrome' });
  const page = await browser.newPage();
  try {
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    const start = () => page.evaluate(() => { window.testWorker?.terminate(); window.testWorker = new Worker('worker.js', { type: 'module' }); window.requestId = 0; });
    const send = message => page.evaluate(message => new Promise((resolve, reject) => {
      const id = ++window.requestId;
      const timer = setTimeout(() => reject(new Error('Worker timed out')), 20000);
      const listener = event => {
        if (event.data.id !== id) return;
        clearTimeout(timer); window.testWorker.removeEventListener('message', listener);
        resolve(event.data);
      };
      window.testWorker.addEventListener('message', listener);
      window.testWorker.onerror = event => { clearTimeout(timer); reject(new Error(event.message)); };
      window.testWorker.postMessage({ ...message, id });
    }), message);
    const compare = async (inputs, xlsx = false) => {
      const node = createComparison({ xlsx, workbookReader: readWorkbook });
      await node.load(inputs);
      const snapshot = { sources: ['before', 'after'], title: 'after', xlsx, inputs: inputs.map(value => xlsx ? value.toString('base64') : value) };
      await start();
      const initial = await send({ action: 'load', snapshot });
      assert.equal(initial.error, undefined);
      assert.deepEqual(comparable(initial.data), comparable(node.snapshot()));
      return { node, snapshot, initial: initial.data };
    };

    const csv = await compare([
      'group,key,value\ng,a,001\ng,b,9999999999999999999',
      'group,key,value\ng,a,002\ng,b,9999999999999999998'
    ]);
    csv.node.update({ keyColumns: ['group', 'key'], format: 'csv' });
    const keyed = await send({ action: 'options', options: { keyColumns: ['group', 'key'], format: 'csv' } });
    assert.deepEqual(comparable(keyed.data), comparable(csv.node.snapshot()));
    csv.node.swap();
    const swapped = await send({ action: 'swap' });
    assert.deepEqual(comparable(swapped.data), comparable(csv.node.snapshot()));
    assert.equal(swapped.data.title, 'before');
    await start();
    const restored = await send({ action: 'load', snapshot: csv.snapshot, settings: swapped.data.settings });
    assert.deepEqual(comparable(restored.data), comparable(csv.node.snapshot()));
    assert.deepEqual(restored.data.sources, ['after', 'before']);
    csv.node.swap();
    const swappedBack = await send({ action: 'swap' });
    assert.deepEqual(comparable(swappedBack.data), comparable(csv.node.snapshot()));
    assert.equal(swappedBack.data.title, 'after');
    assert.deepEqual(swappedBack.data.sources, ['before', 'after']);

    const date = new Date('2025-02-03T04:05:06.000Z');
    const make = (changed, date1904) => workbook({
      Data: [['id', 'date', 'formula', 'cached', 'text', 'boolean', 'error'], ['001', date, { formula: changed ? '2*2' : '2+2', result: 4 }, { formula: 'NOW()', result: date }, changed ? 1 : '1', true, { error: '#N/A' }]],
      Other: [['id', 'value'], ['1', changed ? 'next' : 'old']],
      Duplicate: [['id', 'value'], ['1', 1], ['1', 2]]
    }, book => {
      book.properties.date1904 = date1904;
      book.getWorksheet('Data').getCell('B2').numFmt = 'yyyy-mm-dd hh:mm:ss';
      book.getWorksheet('Data').getCell('D2').numFmt = 'yyyy-mm-dd';
    });
    const xlsx = await compare([await make(false, false), await make(true, true)], true);
    xlsx.node.selectSheet('Other');
    assert.deepEqual(comparable((await send({ action: 'sheet', name: 'Other' })).data), comparable(xlsx.node.snapshot()));
    xlsx.node.selectSheet('Duplicate');
    assert.deepEqual(comparable((await send({ action: 'sheet', name: 'Duplicate' })).data), comparable(xlsx.node.snapshot()));
    xlsx.node.update({ alignment: 'position' });
    const perSheet = await send({ action: 'options', options: { alignment: 'position' } });
    assert.deepEqual(comparable(perSheet.data), comparable(xlsx.node.snapshot()));
    await start();
    const restoredSheet = await send({ action: 'load', snapshot: xlsx.snapshot, settings: perSheet.data.settings });
    assert.deepEqual(comparable(restoredSheet.data), comparable(xlsx.node.snapshot()));
    await compare([Buffer.alloc(0), await workbook({ Added: [['id'], ['1']] })], true);
    await compare([await workbook({ Unsafe: [['id', 'value'], ['1', 9007199254740992]] }), Buffer.alloc(0)], true);
    await compare(['all,int32,None,无,0\nall,int32,All,所有,1', 'all,int32,None,无,0\ngo,int32,All,所有,2']);

    await start();
    const failed = await send({ action: 'load', snapshot: { sources: ['before', 'after'], title: 'bad.xlsx', xlsx: true, inputs: [], error: 'XLSX XML 不允许包含 DTD。' } });
    assert.match(failed.data.error, /DTD/);
    assert.equal(failed.data.result, null);
    const malformed = await send({ action: 'options', options: { keyColumns: [null] } });
    assert.match(malformed.error, /主键设置/);
    console.log('Browser worker matches Node for CSV keys/swap/reload, XLSX types/dates/formulas/sheets, per-sheet preferences, empty sides, unsafe numbers, Mova vertical and validation errors.');
  } finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
})().catch(error => { console.error(error); process.exitCode = 1; });
