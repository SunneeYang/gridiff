'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { readWorkbook } = require('../src/xlsx');
const { createComparison } = require('../src/comparison');
const { workbook, rewriteZip } = require('./xlsx-fixtures');

test('XLSX accepts a formula-heavy worksheet above 64 MiB and retains only cached values', async () => {
  const formula = '1+'.repeat(4094) + '1';
  const count = 8300;
  const rows = Array.from({ length: count }, (_, i) => `<row r="${i + 1}"><c r="A${i + 1}"><f>${formula}</f><v>4095</v></c></row>`).join('');
  const xml = `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${rows}</sheetData></worksheet>`;
  assert.ok(Buffer.byteLength(xml) > 64 * 1024 * 1024);
  const input = await rewriteZip(await workbook({ Data: [] }), zip => zip.file('xl/worksheets/sheet1.xml', xml));
  const [sheet] = await readWorkbook(input);
  assert.equal(sheet.values.length, count);
  assert.equal(sheet.values[count - 1][0], '4095');
  assert.equal(sheet.metadata[count - 1][0].formula, undefined);
  assert.equal(sheet.metadata[count - 1][0].raw, 4095);
});

test('XLSX parses sides sequentially so two expanded workbook models do not overlap', async () => {
  let active = 0, peak = 0, calls = 0;
  const comparison = createComparison({ xlsx: true, workbookReader: async () => {
    calls++; peak = Math.max(peak, ++active);
    await new Promise(resolve => setImmediate(resolve));
    active--;
    return [{ name: 'Data', values: [['id', 'value'], ['1', 'same']], metadata: [[], [{ type: 'string', raw: '1' }, { type: 'string', raw: 'same' }]] }];
  } });
  const result = await comparison.load([Buffer.from('a'), Buffer.from('b')]);
  assert.equal(result.error, '');
  assert.equal(result.result.counts.unchanged, 1);
  assert.equal(calls, 2);
  assert.equal(peak, 1);
});
