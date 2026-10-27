'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { workbook, rewriteZip } = require('./xlsx-fixtures');
const { readWorkbook } = require('../src/xlsx');
const { startComparisonServer } = require('./browser-server.cjs');
(async () => {
  assert.ok(process.env.CODEX_AGENT_TMP, 'Run through agent-tmp-run');
  const file = path.join(process.env.CODEX_AGENT_TMP, 'cached-values.xlsx');
  const long = 'SUM(A1:A20)+'.repeat(1000) + '0';
  for (const date1904 of [false, true]) {
    let input = await workbook({ Data: [['id','value'],
      ['number', { formula: long, result: 2 }], ['zero', { formula: long, result: 0 }],
      ['boolean', { formula: long, result: false }], ['text', { formula: long, result: '文本' }],
      ['error', { formula: long, result: { error: '#DIV/0!' } }], ['missing', { formula: long }],
      ['empty', { formula: long, result: '' }], ['date', { formula: long, result: new Date('2026-10-27T00:00:00Z') }],
      ['shared', { sharedFormula: 'B2', result: 3 }], ['array', { formula: long, shareType: 'array', ref: 'B11:B11', result: 4 }]],
      Other: [['id','raw'], ['1', '<f>literal</f>']] }, book => {
      book.properties.date1904 = date1904;
      book.getWorksheet('Data').getCell('B9').numFmt = 'yyyy-mm-dd';
      book.getWorksheet('Data').getCell('B2').numFmt = '0.00';
    });
    input = await rewriteZip(input, async zip => {
      const name = 'xl/worksheets/sheet1.xml', xml = await zip.file(name).async('string');
      zip.file(name, xml.replace('</sheetData>', '<row r="100"><c r="D100"><f><![CDATA[A1+1]]></f></c><c r="E100"><f><![CDATA[A1]]><![CDATA[+1]]></f></c><c r="F100"><f><![CDATA[A1]]>+1</f><v>7</v></c></row></sheetData>'));
    });
    const original = Buffer.from(input);
    await fs.writeFile(file, input);
    const server = await startComparisonServer({ files: ['/dev/null', file] });
    try {
      const snapshot = await (await fetch(server.url + 'snapshot')).json();
      assert.equal(snapshot.error, undefined);
      const compact = Buffer.from(snapshot.inputs[1], 'base64');
      assert.ok(compact.length < original.length, 'formula-heavy snapshot must shrink');
      assert.deepEqual(await readWorkbook(compact, { mode: 'first' }), await readWorkbook(original, { mode: 'first' }), 'cached values, types, ranges and date systems must match');
      assert.deepEqual(await fs.readFile(file), original, 'source remains untouched');
    } finally { await server.close(); }
  }
  console.log('XLSX snapshots preserve cached values/types, dates, styles, shared/array formulas and missing caches; source bytes unchanged.');
})().catch(error => { console.error(error); process.exitCode = 1; });
