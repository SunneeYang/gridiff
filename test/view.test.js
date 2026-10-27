'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { selectView } = require('../media/view');
const { readTable } = require('../src/csv');
const { compareTables } = require('../src/diff');
const state = { query: '', onlyChanges: false, onlyFields: true, page: 0 };

test('paged projection searches the entire model and preserves its global column union', () => {
  const before = 'id,name,value,rare\n' + Array.from({ length: 205 }, (_, i) => `${i},name${i},same,old`).join('\n');
  const after = before.replace('0,name0,same', '0,name0,new').replace('204,name204,same,old', '204,name204,same,new');
  const model = compareTables(readTable(before), readTable(after));
  const first = selectView(model, state);
  assert.equal(first.rows.length, 100);
  assert.deepEqual(first.pageInfo.fieldIndexes, [2, 3]);
  const searched = selectView(model, { ...state, query: 'name204' });
  assert.equal(searched.rows.length, 1);
  assert.equal(searched.rows[0].identity, '204');
  assert.deepEqual(searched.pageInfo.fieldIndexes, [2, 3]);
  assert.equal(searched.rows[0].cells[1].after, 'name204', 'hidden name remains available for the row label');
  const combined = [0, 1, 2].flatMap(page => selectView(model, { ...state, page }).rows);
  assert.deepEqual(combined, model.rows);
  assert.equal(selectView(model, { ...state, onlyChanges: true }).rows.length, 2);
  assert.equal(selectView(model, { ...state, query: 'missing', page: 100 }).pageInfo.page, 0);
});

test('deleted-only fields and added/modified union retain the original rules', () => {
  const before = readTable('id,a,b,empty\n1,old,stay,\n2,delete,only-deleted,');
  const after = readTable('id,a,b,empty\n1,new,stay,\n3,added,,');
  assert.deepEqual(selectView(compareTables(before, after), state).pageInfo.fieldIndexes, [0, 1]);
  assert.deepEqual(selectView(compareTables(before, readTable('')), state).pageInfo.fieldIndexes, [0, 1, 2]);
});

test('wide projections clamp page size and page number without dropping records', () => {
  const header = Array.from({ length: 400 }, (_, i) => `f${i}`).join(',');
  const csv = header + '\n' + Array.from({ length: 20 }, (_, i) => `${i},${'v,'.repeat(398)}v`).join('\n');
  const model = compareTables(readTable(''), readTable(csv));
  const selected = selectView(model, { ...state, onlyFields: false, page: 99 });
  assert.equal(selected.pageInfo.pageSize, 7);
  assert.equal(selected.pageInfo.page, 2);
  assert.equal(selected.rows.length, 6);
});
