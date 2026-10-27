'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createComparison } = require('../src/comparison');
const { readWorkbookData } = require('../src/xlsx-core');
const { Workbook } = require('exceljs');
const { workbook } = require('./xlsx-fixtures');

test('opt-in phase measurements preserve results and contain no table values', async () => {
  const metrics = [], inputs = ['id,value\n1,private_old', 'id,value\n1,private_new'];
  const plain = createComparison(), measured = createComparison({ onMetric: metric => metrics.push(metric) });
  assert.deepEqual(await measured.load(inputs), await plain.load(inputs));
  assert.deepEqual(metrics.map(metric => metric.phase), ['csv.parse', 'table.compare']);
  const bytes = await workbook({ PrivateSheet: [['id', 'value'], ['1', 'private_cell']] });
  const reader = input => readWorkbookData(Workbook, input, metric => metrics.push(metric));
  const xlsx = createComparison({ xlsx: true, workbookReader: reader, onMetric: metric => metrics.push(metric) });
  assert.equal((await xlsx.load([bytes, bytes])).error, '');
  for (const phase of ['xlsx.load', 'xlsx.normalize', 'table.prepare', 'table.compare']) assert.ok(metrics.some(metric => metric.phase === phase));
  for (const metric of metrics) {
    assert.ok(Number.isFinite(metric.ms) && metric.ms >= 0);
    for (const [key, value] of Object.entries(metric)) if (key !== 'phase') assert.equal(typeof value, 'number');
  }
  assert.ok(!JSON.stringify(metrics).includes('private'));
  assert.ok(!JSON.stringify(metrics).includes('PrivateSheet'));
});

test('sparse XLSX empty metadata stays shared across the worker structured clone', () => {
  const { readTableRows } = require('../src/csv');
  const { compareTables } = require('../src/diff');
  const values = [['id', 'empty'], ['1', ''], ['2', '']];
  const table = () => readTableRows(values, {}, [[], [{ type: 'string', raw: '1' }], [{ type: 'string', raw: '2' }]]);
  const diff = compareTables(table(), table());
  const cloned = structuredClone(diff);
  const first = cloned.rows[0].cells[1], second = cloned.rows[1].cells[1];
  assert.deepEqual(first.beforeMeta, { type: 'empty', raw: null });
  assert.strictEqual(first.beforeMeta, first.afterMeta);
  assert.strictEqual(first.beforeMeta, second.beforeMeta);
  assert.equal(first.changed, false);
  assert.ok(Object.isFrozen(diff.rows[0].cells[1].beforeMeta));
});
