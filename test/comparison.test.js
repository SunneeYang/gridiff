'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createComparison: createSession, MAX_BYTES } = require('../src/comparison');
const { readWorkbook } = require('../src/xlsx');
const createComparison = options => createSession({ workbookReader: readWorkbook, ...options });
const { workbook } = require('./xlsx-fixtures');

test('paired workbook reader preserves shared comparisons and checks byte limits before dispatch', async () => {
  const inputs = [await workbook({ Data: [['id', 'value'], ['1', 'old']] }), await workbook({ Data: [['id', 'value'], ['1', 'new']] })];
  let calls = 0;
  const paired = createComparison({ xlsx: true, workbookPairReader: async (values, selection) => { calls++; return Promise.all(values.map(value => readWorkbook(value, selection))); } });
  const sequential = createComparison({ xlsx: true });
  assert.deepEqual(await paired.load(inputs), await sequential.load(inputs));
  assert.deepEqual(paired.swap(), sequential.swap());
  const invalid = await paired.load([Buffer.alloc(MAX_BYTES + 1), inputs[1]]);
  assert.match(invalid.error, /8 MiB/);
  assert.equal(calls, 1);
  assert.equal(invalid.result, null);
});

test('CSV snapshot can recover duplicate keys, change alignment and swap without rereading files', async () => {
  const comparison = createComparison();
  const inputs = ['id,kind,value\n1,a,old\n1,b,same', 'id,kind,value\n1,a,new\n1,b,same'];
  const initial = await comparison.load(inputs);
  assert.match(initial.error, /重复/);
  assert.deepEqual(initial.keyFields, ['id', 'kind', 'value'].map(name => ({ name, label: name })));
  const keyed = comparison.update({ keyColumns: ['id', 'kind'] });
  assert.equal(keyed.error, ''); assert.equal(keyed.result.counts.modified, 1);
  assert.deepEqual(keyed.result.keys, ['id', 'kind']);
  assert.equal(comparison.update({ alignment: 'position' }).result.alignment, 'position');
  const swapped = comparison.swap();
  assert.equal(swapped.result.rows[0].cells[2].before, 'new');
  assert.equal(swapped.result.rows[0].cells[2].after, 'old');
  assert.equal(inputs[0].includes('old'), true, 'caller snapshot order is not mutated');
  assert.ok(swapped.revision > initial.revision);
});

test('custom CSV headers and empty sides preserve field choices and skipped row counts', async () => {
  const comparison = createComparison({ options: { format: 'custom', headerRow: 2, descriptionRow: 3, dataStartRow: 4 } });
  const state = await comparison.load(['', 'notes,\nid,value\n编号,内容\n1,new\n,\n']);
  assert.equal(state.error, ''); assert.equal(state.result.counts.added, 1);
  assert.deepEqual(state.keyFields, [{ name: 'id', label: '编号' }, { name: 'value', label: '内容' }]);
  assert.deepEqual(state.skipped, [0, 1]);
  assert.equal(comparison.swap().result.counts.removed, 1);
});

test('XLSX pairs first sheets regardless of name and ignores later sheets', async () => {
  const comparison = createComparison({ xlsx: true });
  const old = await workbook({ Old: [['id', 'value'], ['1', { formula: '1+1', result: 2 }]], Ignored: [['id'], ['1'], ['1']] });
  const next = await workbook({ Renamed: [['id', 'value'], ['1', { formula: '2*1', result: 2 }]], Other: [['id'], ['8']] });
  const state = await comparison.load([old, next], { mode: 'first' });
  assert.deepEqual(state.sheets.map(sheet => [sheet.name, sheet.status]), [['Renamed', 'common']]);
  assert.equal(state.error, '');
  assert.equal(state.result.counts.modified, 0);
  assert.equal(state.result.counts.added, 0);
  assert.equal(state.result.counts.removed, 0);
  assert.deepEqual(state.result.rows[0].cells[1].beforeMeta, { type: 'number', raw: 2 });
  assert.strictEqual(comparison.selectSheet('Ignored').result, state.result);
  assert.equal(comparison.swap().sheetName, 'Old');
  const changed = await workbook({ NewFirst: [['id', 'value'], ['1', 3]], Old: [['id', 'value'], ['1', 2]] });
  const reordered = await comparison.load([old, changed], { mode: 'first' });
  assert.equal(reordered.result.counts.modified, 1, 'workbook order determines the compared data');
  assert.equal(reordered.result.rows[0].cells[1].after, '3');
});

test('an empty XLSX side represents an added or deleted workbook', async () => {
  const comparison = createComparison({ xlsx: true });
  const bytes = await workbook({ Data: [['id', 'value'], ['1', 'hello']] });
  const added = await comparison.load([Buffer.alloc(0), bytes]);
  assert.equal(added.error, ''); assert.equal(added.sheets[0].status, 'added');
  assert.equal(added.result.counts.added, 1);
  assert.equal(comparison.swap().result.counts.removed, 1);
  assert.match((await comparison.load([Buffer.alloc(0), Buffer.alloc(0)])).error, /没有工作表/);
});

test('XLSX caches first-sheet comparisons and invalidates settings, reload and swap', async () => {
  const metrics = [];
  const comparison = createComparison({ xlsx: true, onMetric: metric => metrics.push(metric) });
  const inputs = await Promise.all([false, true].map(changed => workbook({
    A: [['id', 'value'], ['1', changed ? 'new' : 'old']],
    B: [['id', 'value'], ['2', changed ? 'next' : 'before']]
  })));
  const count = () => metrics.filter(metric => metric.phase === 'table.compare').length;
  const first = await comparison.load(inputs, { mode: 'first' });
  assert.equal(count(), 1);
  metrics.length = 0;
  assert.equal(comparison.selectSheet('A').revision, first.revision);
  assert.equal(comparison.selectSheet('B').revision, first.revision);
  assert.equal(count(), 0);
  assert.strictEqual(comparison.selectSheet('A').result, first.result);
  comparison.update({ alignment: 'position' });
  assert.equal(count(), 1);
  assert.equal(comparison.snapshot().result.alignment, 'position');
  metrics.length = 0;
  comparison.update({});
  assert.equal(count(), 1, 'explicit refresh recalculates the first sheet');
  metrics.length = 0;
  const swapped = comparison.swap();
  assert.equal(count(), 1);
  assert.equal(swapped.result.rows[0].cells[1].after, 'old');
  metrics.length = 0;
  await comparison.load(inputs, { mode: 'first' });
  assert.equal(count(), 1);
  assert.equal(comparison.snapshot().result.alignment, 'position');
  comparison.fail(new Error('unavailable'));
  assert.equal(comparison.selectSheet('A').result, null);
});

test('failed reads clear stale results and remain visible until a successful reload', async () => {
  const comparison = createComparison();
  await comparison.load(['id\n1', 'id\n2']);
  const failed = comparison.fail(new Error('File not found'));
  assert.equal(failed.result, null); assert.deepEqual(failed.keyFields, []);
  assert.equal(comparison.update({}).error, 'File not found');
  assert.equal((await comparison.load(['id\n1', 'id\n1'])).error, '');
  assert.match((await comparison.load(['id', 'x'.repeat(MAX_BYTES + 1)])).error, /8 MiB/);
  assert.equal(comparison.tables, null);
  const broken = createComparison({ xlsx: true });
  assert.match((await broken.load([Buffer.from('not a workbook'), Buffer.alloc(0)])).error, /XLSX/);
});

test('combined CSV cell limit is enforced before building diff cells', async () => {
  const comparison = createComparison();
  const columns = 1001, rows = 500;
  const header = Array.from({ length: columns }, (_, index) => `c${index}`).join(',');
  const values = Array.from({ length: rows }, (_, index) => `${index},${'v,'.repeat(columns - 2)}v`).join('\n');
  const csv = `${header}\n${values}`;
  const state = await comparison.load([csv, csv]);
  assert.match(state.error, /100 万单元格/);
  assert.equal(state.result, null);
});

test('XLSX cell budgets accumulate across sheets, including sheets with alignment errors', async () => {
  const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
  const module = { exports: {} };
  const names = ['Duplicate', 'Good'];
  let compared = 0;
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/comparison.js'), 'utf8'), {
    module, TextEncoder, TextDecoder,
    require: name => name === './sheets' ? require('../src/sheets') : name === './csv' ? { readTableRows: () => ({ fields: [{ name: 'id' }], rows: { length: 300000 } }) } : name === './diff' ? {
      compareTables: () => { compared++; throw new Error('主键重复'); }
    } : require('../src/csv')
  });
  const comparison = module.exports.createComparison({ xlsx: true, workbookReader: async () => names.map(name => ({ name })) });
  const state = await comparison.load([Buffer.from('old'), Buffer.from('new')]);
  assert.match(state.error, /100 万单元格/);
  assert.equal(state.result, null);
  assert.equal(state.sheets.length, 0);
  assert.equal(compared, 1, 'the second sheet exceeds the shared budget before diff allocation');
});

test('XLSX cached sheets still count toward the budget and a settings correction recovers', async () => {
  const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
  const module = { exports: {} };
  let compared = 0;
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/comparison.js'), 'utf8'), {
    module, TextEncoder, TextDecoder,
    require: name => name === './sheets' ? require('../src/sheets') : name === './csv' ? { readTableRows: (_values, options) => ({ fields: [{ name: 'id' }], rows: { length: options.dataStartRow === 1 ? 400000 : 200000 } }) } : {
      compareTables: () => { compared++; return { rows: [], schema: [], counts: {} }; }
    }
  });
  const comparison = module.exports.createComparison({ xlsx: true, workbookReader: async () => ['A', 'B'].map(name => ({ name })) });
  assert.equal((await comparison.load([Buffer.from('old'), Buffer.from('new')])).error, '');
  assert.equal(compared, 2);
  comparison.selectSheet('B');
  assert.match(comparison.update({ dataStartRow: 1 }).error, /100 万单元格/);
  assert.equal(compared, 2, 'cached A budget must block B before allocating its diff');
  const recovered = comparison.update({ dataStartRow: 2 });
  assert.equal(recovered.error, ''); assert.equal(recovered.sheets.length, 2);
  assert.equal(compared, 4, 'a workbook-level failure releases cached results');
});

test('XLSX first-sheet settings survive changes to host defaults', async () => {
  let alignment = 'key';
  const inputs = await workbook({ A: [['id'], ['1']], B: [['id'], ['2']] });
  const comparison = createComparison({ xlsx: true, getDefaults: () => ({ alignment }) });
  await comparison.load([inputs, inputs], { mode: 'first' });
  alignment = 'position';
  assert.equal(comparison.selectSheet('B').sheetName, 'A');
  assert.equal(comparison.selectSheet('A').result.alignment, 'key');
});
