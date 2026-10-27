'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { sheetSelection } = require('../src/sheets');
const { readWorkbook } = require('../src/xlsx');
const { createComparison } = require('../src/comparison');
const { workbook, rewriteZip } = require('./xlsx-fixtures');

test('sheet ranges validate exact names and reject empty or conflicting selections', () => {
  assert.deepEqual(sheetSelection(), { mode: 'all' });
  assert.deepEqual(sheetSelection({ mode: 'named', names: [' A,表 ', 'B', ' A,表 '] }), { mode: 'named', names: [' A,表 ', 'B'] });
  for (const value of [null, 'first', {}, { mode: 'unknown' }, { mode: 'named' }, { mode: 'named', names: [''] }, { mode: 'named', names: [1] }, { mode: 'all', names: ['A'] }, { mode: 'first', extra: true }]) assert.throws(() => sheetSelection(value), /工作表|named/);
});

test('XLSX defaults to all sheets; first and named ranges preserve workbook order and cached values', async () => {
  const bytes = await workbook({ Z: [['id'], ['1']], '中文, table': [['id', 'v'], ['2', { formula: 'Z!A2', result: 42 }]], A: [['id'], ['3']] }, book => { book.getWorksheet('中文, table').state = 'hidden'; });
  assert.deepEqual((await readWorkbook(bytes)).map(s => s.name), ['Z', '中文, table', 'A']);
  assert.deepEqual((await readWorkbook(bytes, { mode: 'first' })).map(s => s.name), ['Z']);
  const selected = await readWorkbook(bytes, { mode: 'named', names: ['A', '中文, table', 'A'] });
  assert.deepEqual(selected.map(s => s.name), ['中文, table', 'A']);
  assert.equal(selected[0].metadata[1][1].raw, 42);
  assert.deepEqual(await readWorkbook(bytes, { mode: 'named', names: ['missing'] }), []);
});

test('unselected damaged worksheet payloads are skipped, selected and all-mode payloads are checked', async () => {
  const bytes = await rewriteZip(await workbook({ Good: [['id'], ['1']], Bad: [['id'], ['2']] }), zip => zip.file('xl/worksheets/sheet2.xml', '<worksheet><broken>'));
  assert.deepEqual((await readWorkbook(bytes, { mode: 'named', names: ['Good'] })).map(s => s.name), ['Good']);
  await assert.rejects(readWorkbook(bytes), /XLSX/);
  await assert.rejects(readWorkbook(bytes, { mode: 'named', names: ['Bad'] }), /XLSX/);
});

test('only first mode pairs by position; all and named compare sheet names even for single sheets', async () => {
  const inputs = [await workbook({ Before: [['id', 'v'], ['1', 'old']] }), await workbook({ After: [['id', 'v'], ['1', 'new']] })];
  const comparison = createComparison({ xlsx: true, workbookReader: readWorkbook });
  for (const selection of [{ mode: 'all' }, { mode: 'named', names: ['Before', 'After'] }]) {
    const state = await comparison.load(inputs, selection);
    assert.equal(state.error, '');
    assert.deepEqual(state.sheets.map(s => [s.name, s.status]), [['After', 'added'], ['Before', 'removed']]);
  }
  const first = await comparison.load(inputs, { mode: 'first' });
  assert.deepEqual(first.sheets.map(s => [s.name, s.status]), [['After', 'common']]);
  assert.equal(first.result.counts.modified, 1);
  const added = await comparison.load(inputs, { mode: 'named', names: ['After'] });
  assert.equal(added.result.counts.added, 1);
  assert.equal(comparison.swap().result.counts.removed, 1);
  for (const names of [['missing'], ['After', 'missing']]) {
    const bad = await comparison.load(inputs, { mode: 'named', names });
    assert.match(bad.error, /两侧均找不到.*missing/); assert.equal(bad.result, null);
  }
});
