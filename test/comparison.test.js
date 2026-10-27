'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createComparison: createSession, MAX_BYTES } = require('../src/comparison');
const { readWorkbook } = require('../src/xlsx');
const createComparison = options => createSession({ workbookReader: readWorkbook, ...options });
const { workbook } = require('./xlsx-fixtures');

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

test('XLSX sessions isolate errors, retain per-sheet options and preserve formula metadata', async () => {
  const comparison = createComparison({ xlsx: true });
  const old = await workbook({ Good: [['id', 'value'], ['1', { formula: '1+1', result: 2 }]], Duplicate: [['id', 'value'], ['1', 1], ['1', 2]], Removed: [['id'], ['9']] });
  const next = await workbook({ Good: [['id', 'value'], ['1', { formula: '2*1', result: 2 }]], Duplicate: [['id', 'value'], ['1', 1], ['1', 2]], Added: [['id'], ['8']] });
  const state = await comparison.load([old, next]);
  assert.deepEqual(state.sheets.map(sheet => [sheet.name, sheet.status]), [['Good', 'common'], ['Duplicate', 'common'], ['Added', 'added'], ['Removed', 'removed']]);
  assert.equal(state.sheetName, 'Good');
  assert.equal(state.result.counts.modified, 1);
  assert.deepEqual(state.result.rows[0].cells[1].beforeMeta, { type: 'number', raw: 2, formula: '1+1' });
  assert.equal(state.result.rows[0].cells[1].afterMeta.formula, '2*1');
  assert.match(comparison.selectSheet('Duplicate').error, /重复/);
  assert.equal(comparison.update({ alignment: 'position' }).error, '');
  assert.equal(comparison.selectSheet('Good').result.alignment, 'key');
  assert.equal(comparison.selectSheet('Duplicate').result.alignment, 'position');
  assert.equal(comparison.selectSheet('Removed').result.counts.removed, 1);
  assert.equal(comparison.swap().result.counts.added, 1);
  assert.equal(comparison.selectSheet('unknown').sheetName, 'Removed');
  await comparison.load([next, old]);
  assert.equal(comparison.selectSheet('Duplicate').result.alignment, 'position');
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
    require: name => name === './csv' ? { readTableRows: () => ({ fields: [{ name: 'id' }], rows: { length: 300000 } }) } : name === './diff' ? {
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
