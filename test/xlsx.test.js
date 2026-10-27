'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { readWorkbook, worksheetTable } = require('../src/xlsx');
const { compareTables } = require('../src/diff');
const { workbook, rewriteZip } = require('./xlsx-fixtures');

async function table(rows, edit, options) {
  return worksheetTable((await readWorkbook(await workbook({ Data: rows }, edit)))[0], options);
}

test('XLSX preserves text IDs, typed values, display formats and source row numbers', async () => {
  const t = await table([['id', 'n', 'date', 'bool', 'error', 'rich'],
    ['001234567890123456789', 0.25, new Date('2026-10-27T12:30:00Z'), false, { error: '#DIV/0!' }, { richText: [{ text: 'hello' }, { text: '世界' }] }],
    [], ['002', 3]], b => { b.getWorksheet(1).getCell('B2').numFmt = '0.0%'; b.getWorksheet(1).getCell('C2').numFmt = 'yyyy-mm-dd hh:mm'; });
  assert.deepEqual(t.rows[0].values, ['001234567890123456789', '25.0%', '2026-10-27 12:30', 'FALSE', '#DIV/0!', 'hello世界']);
  assert.equal(t.rows[0].metadata[1].raw, 0.25);
  assert.equal(t.rows[0].metadata[2].raw, '2026-10-27T12:30:00.000Z');
  assert.equal(t.rows[1].record, 4); assert.equal(t.skippedBlankRows, 1);
});

test('XLSX compares cached values and types independently of formula expressions and display text', async () => {
  const before = await table([['id', 'typed', 'rounded', 'formula'], [1, 1, 1.234, { formula: '1+1', result: 2 }]], b => {
    b.getWorksheet(1).getCell('A2').numFmt = '000'; b.getWorksheet(1).getCell('C2').numFmt = '0.0';
  });
  const after = await table([['id', 'typed', 'rounded', 'formula'], [1, '1', 1.235, { formula: '2*1', result: 2 }]], b => { b.getWorksheet(1).getCell('C2').numFmt = '0.0'; });
  const diff = compareTables(before, after);
  assert.equal(diff.counts.modified, 1); assert.equal(diff.counts.cells, 2);
  assert.equal(diff.rows[0].cells[0].changed, false, 'formatted keys align by raw value');
  assert.equal(diff.rows[0].cells[1].before, diff.rows[0].cells[1].after);
  assert.equal(diff.rows[0].cells[1].beforeMeta.type, 'number');
  assert.equal(diff.rows[0].cells[1].afterMeta.type, 'string');
  assert.equal(diff.rows[0].cells[2].before, diff.rows[0].cells[2].after);
  assert.equal(diff.rows[0].cells[3].changed, false);
  assert.equal(diff.rows[0].cells[3].afterMeta.formula, undefined);
});

test('XLSX only-format changes are ignored, text and numeric keys remain distinct', async () => {
  const before = await table([['id', 'n'], [1, 12.3]]);
  const after = await table([['id', 'n'], [1, 12.3]], b => { b.getWorksheet(1).getCell('B2').numFmt = '0.0000'; });
  assert.equal(compareTables(before, after).counts.modified, 0);
  const textKey = await table([['id', 'n'], ['1', 12.3]]);
  const diff = compareTables(before, textKey);
  assert.equal(diff.counts.added, 1); assert.equal(diff.counts.removed, 1);
});

test('formula results compare like literal values, including zero, false and errors', async () => {
  const before = await table([['id', 'value'],
    ['1', { formula: '1+1', result: 2 }], ['2', { formula: '1-1', result: 0 }],
    ['3', { formula: 'FALSE()', result: false }], ['4', { formula: '1/0', result: { error: '#DIV/0!' } }]]);
  const after = await table([['id', 'value'], ['1', 2], ['2', 0], ['3', false], ['4', { error: '#DIV/0!' }]]);
  assert.equal(compareTables(before, after).counts.modified, 0);
  const changed = await table([['id', 'value'],
    ['1', { formula: '1+2', result: 3 }], ['2', 0], ['3', false], ['4', { error: '#DIV/0!' }]]);
  assert.equal(compareTables(before, changed).counts.modified, 1);
});

test('XLSX date display is stable across date systems and cached date formulas', async () => {
  const rows = [['id', 'date', 'formula'], ['1', new Date('2026-10-27T00:00:00Z'), { formula: 'DATE(2026,10,27)', result: new Date('2026-10-27T00:00:00Z') }]];
  const edit = b => { b.getWorksheet(1).getCell('B2').numFmt = b.getWorksheet(1).getCell('C2').numFmt = 'yyyy-mm-dd'; };
  const a = await table(rows, edit);
  const b = await table(rows, book => { edit(book); book.properties.date1904 = true; });
  assert.equal(a.rows[0].values[1], '2026-10-27'); assert.equal(a.rows[0].values[2], '2026-10-27');
  assert.equal(compareTables(a, b).counts.modified, 0);
});

test('XLSX handles shared formulas, missing caches, empty results, and merged cells once', async () => {
  const t = await table([['id', 'v'], ['1', { formula: '1+2', result: 3 }], ['2', { sharedFormula: 'B2', result: 3 }],
    ['3', { formula: 'TODAY()' }], ['4', { formula: 'IF(TRUE,"",1)', result: '' }], ['5', 'merged']], b => {
    b.getWorksheet(1).mergeCells('B6:C6');
  });
  assert.equal(t.rows[1].values[1], '3');
  assert.equal(t.rows[1].metadata[1].formula, undefined);
  assert.equal(t.rows[2].values[1], '');
  assert.equal(t.rows[2].metadata[1].raw, null);
  assert.equal(t.rows[3].values[1], '');
  assert.equal(t.fields.length, 2); assert.equal(t.rows[4].values[1], 'merged');
  const key = await table([['id', 'v'], [{ formula: '1+1' }, 'missing cache']]);
  assert.throws(() => compareTables(key, key), /缺少主键值/);
});

test('XLSX reuses Mova and custom headers while ignoring styled empty cells', async () => {
  const t = await table([['all', 'all'], ['int', 'string'], ['id', 'name'], ['编号', '名称'], [1, 'hello', 'ignored']], b => {
    b.getWorksheet(1).getCell('XFD1000').font = { bold: true };
  });
  assert.equal(t.format, 'mova'); assert.deepEqual(t.rows[0].values, ['1', 'hello']);
  assert.equal(t.rows[0].record, 5);
  const custom = await table([['说明'], ['id', 'v'], [], ['k', 'value']], undefined, { format: 'custom', headerRow: 2, dataStartRow: 4 });
  assert.equal(custom.rows[0].record, 4);
});

test('XLSX Mova vertical tables align by name and compare formula results', async () => {
  const before = await table([[], ['all', 'int32', 'None', '无', 0], ['all', 'int32', 'All', '所有单位', { formula: '1+1', result: 2 }]]);
  const after = await table([[], ['all', 'int32', 'None', '无', '0'], ['all', 'int32', 'All', '所有单位', { formula: '2*1', result: 2 }], ['all', 'int32', 'Near_1', '最近的1个单位', 10]]);
  const diff = compareTables(before, after);
  assert.deepEqual(diff.formats, ['mova-vertical', 'mova-vertical']);
  assert.deepEqual(diff.keys, ['name']);
  assert.deepEqual(diff.rows.map(r => r.afterRecord), [2, 3, 4]);
  assert.equal(diff.counts.modified, 1); assert.equal(diff.counts.added, 1);
  assert.equal(diff.rows[0].cells[4].beforeMeta.type, 'number');
  assert.equal(diff.rows[0].cells[4].afterMeta.type, 'string');
  assert.equal(diff.rows[1].cells[4].changed, false);
  assert.equal(diff.rows[1].cells[4].afterMeta.formula, undefined);
});

test('XLSX accepts UTF-8/UTF-16 custom XML across byte boundaries without changing worksheet values', async t => {
  const yauzl = require('yauzl'), open = yauzl.fromBufferPromise;
  t.mock.method(yauzl, 'fromBufferPromise', async buffer => {
    const zip = await open(buffer), read = zip.openReadStreamPromise.bind(zip);
    zip.openReadStreamPromise = async entry => {
      const stream = await read(entry);
      if (entry.fileName !== 'customXml/item1.xml') return stream;
      return (async function* () {
        for await (const chunk of stream) for (const byte of chunk) yield Buffer.from([byte]);
      })();
    };
    return zip;
  });
  const base = await workbook({ Data: [['id', 'value'], ['001', '子弹配置']] });
  const expected = await readWorkbook(base);
  for (const [encoding, bigEndian] of [['utf8', false], ['utf16le', false], ['utf16le', true]]) {
    const encoded = Buffer.from(`\uFEFF<?xml version="1.0" encoding="${encoding === 'utf8' ? 'UTF-8' : 'UTF-16'}"?><config>附加信息🧩</config>`, encoding);
    if (bigEndian) encoded.swap16();
    const bytes = await rewriteZip(base, async zip => zip.file('customXml/item1.xml', encoded));
    assert.deepEqual(await readWorkbook(bytes), expected);
  }
});

test('UTF-16 XML still rejects DTDs, malformed documents and truncated code units', async () => {
  const base = await workbook({ Data: [['id'], ['1']] });
  for (const bigEndian of [false, true]) {
    for (const [xml, error] of [
      ['<!DOCTYPE x [<!ENTITY a "test">]><x/>', /DTD/],
      ['<x><unclosed></x>', /close tag/]
    ]) {
      const encoded = Buffer.from('\uFEFF' + xml, 'utf16le');
      if (bigEndian) encoded.swap16();
      const bytes = await rewriteZip(base, async zip => zip.file('customXml/item1.xml', encoded));
      await assert.rejects(readWorkbook(bytes), error);
    }
    const encoded = Buffer.from('\uFEFF<x/>', 'utf16le');
    if (bigEndian) encoded.swap16();
    const truncated = await rewriteZip(base, async zip => zip.file('customXml/item1.xml', Buffer.concat([encoded, Buffer.from([0x20])])));
    await assert.rejects(readWorkbook(truncated), /encoded data|encoding/i);
  }
});

test('XLSX rejects unsafe numbers, oversized ranges and malformed archives', async () => {
  await assert.rejects(table([['id'], [Number.MAX_SAFE_INTEGER + 1]]), /安全精度/);
  await assert.rejects(readWorkbook(Buffer.alloc(8 * 1024 * 1024 + 1)), /8 MiB/);
  await assert.rejects(readWorkbook(Buffer.from('not a workbook')), /无法读取 XLSX/);
  const base = await workbook({ Data: [['id'], ['1']] });
  const huge = await rewriteZip(base, async zip => {
    const path = 'xl/worksheets/sheet1.xml';
    zip.file(path, (await zip.file(path).async('string')).replace(/A2/g, 'XFD1048576').replace('r="2"', 'r="1048576"'));
  });
  await assert.rejects(readWorkbook(huge), /100 万单元格/);
  const invalid = await rewriteZip(base, async zip => {
    const path = 'xl/worksheets/sheet1.xml';
    zip.file(path, (await zip.file(path).async('string')).replace(/A2/g, 'XFE2'));
  });
  await assert.rejects(readWorkbook(invalid), /坐标无效/);
  const dtd = await rewriteZip(base, async zip => zip.file('extra.xml', '<!DOCTYPE x [<!ENTITY a "test">]><x/>'));
  await assert.rejects(readWorkbook(dtd), /DTD/);
  const size = Buffer.from(base);
  size.writeUInt32LE(128 * 1024 * 1024 + 1, size.indexOf(Buffer.from('504b0102', 'hex')) + 24);
  await assert.rejects(readWorkbook(size), /128 MiB/);
});

test('XLSX reads only workbook-order first sheet, including hidden sheets and cross-sheet caches', async t => {
  const yauzl = require('yauzl'), open = yauzl.fromBufferPromise, opened = [];
  t.mock.method(yauzl, 'fromBufferPromise', async (...args) => {
    const zip = await open(...args), read = zip.openReadStreamPromise.bind(zip);
    zip.openReadStreamPromise = entry => { opened.push(entry.fileName); return read(entry); };
    return zip;
  });
  const input = await rewriteZip(await workbook({
    Ignored: [['id'], ['bad']],
    First: [['id', 'value'], ['001', { formula: 'Ignored!A2', result: 42 }]]
  }, book => { book.getWorksheet('First').state = 'hidden'; book.views = [{ activeTab: 0 }]; }), async zip => {
    const xml = await zip.file('xl/workbook.xml').async('string');
    const sheets = xml.match(/<sheet\s[^>]+\/>/g);
    zip.file('xl/workbook.xml', xml.replace(sheets.join(''), [...sheets].reverse().join('')));
    // A damaged ignored payload must not reach either validator or ExcelJS.
    zip.file('xl/worksheets/sheet1.xml', '<worksheet><broken>');
    zip.file('xl/worksheets/_rels/sheet1.xml.rels', '<broken>');
  });
  const sheets = await readWorkbook(input, { mode: 'first' });
  assert.deepEqual(sheets.map(sheet => sheet.name), ['First']);
  assert.deepEqual(sheets[0].values, [['id', 'value'], ['001', '42']]);
  assert.deepEqual(sheets[0].metadata[1][1], { type: 'number', raw: 42 });
  assert.ok(!opened.some(name => name.includes('sheet1.xml')), 'unused worksheet is never decompressed by the validator');
});

test('XLSX does not fall back to a later worksheet when first-sheet relationships are invalid', async () => {
  const input = await workbook({ First: [['id'], ['1']], Second: [['id'], ['2']] });
  for (const edit of [
    zip => zip.remove('xl/worksheets/sheet1.xml'),
    zip => zip.remove('xl/_rels/workbook.xml.rels'),
    async zip => {
      const name = 'xl/_rels/workbook.xml.rels';
      zip.file(name, (await zip.file(name).async('string')).replace('Target="worksheets/sheet1.xml"', 'TargetMode="External" Target="https://example.com/sheet.xml"'));
    },
    zip => zip.file('xl/worksheets/sheet1.xml', '<worksheet><broken>')
  ]) await assert.rejects(readWorkbook(await rewriteZip(input, edit), { mode: 'first' }), /XLSX/);
});

test('XLSX first-sheet selection accepts Strict OOXML and explicit internal relationships', async () => {
  const input = await workbook({ First: [['id', 'value'], ['1', 'kept']], Ignored: [['id'], ['other']] });
  const expected = await readWorkbook(input, { mode: 'first' });
  for (const strict of [false, true]) {
    const changed = await rewriteZip(input, async zip => {
      for (const name of ['xl/workbook.xml', 'xl/_rels/workbook.xml.rels']) {
        let text = (await zip.file(name).async('string')).replace(/ Target=/g, ' TargetMode="Internal" Target=');
        if (strict) text = text.replaceAll('http://schemas.openxmlformats.org/spreadsheetml/2006/main', 'http://purl.oclc.org/ooxml/spreadsheetml/main').replaceAll('http://schemas.openxmlformats.org/officeDocument/2006/relationships', 'http://purl.oclc.org/ooxml/officeDocument/relationships');
        zip.file(name, text);
      }
    });
    assert.deepEqual(await readWorkbook(changed, { mode: 'first' }), expected);
  }
});

test('XLSX rejects path aliases and an unrecognized first-sheet namespace', async () => {
  const input = await workbook({ First: [['id'], ['1']], Ignored: [['id'], ['2']] });
  const alias = await rewriteZip(input, zip => zip.file('xl/worksheets/./sheet1.xml', '<worksheet/>'));
  await assert.rejects(readWorkbook(alias, { mode: 'first' }), /路径/);
  const unknown = await rewriteZip(input, async zip => {
    const name = 'xl/workbook.xml';
    zip.file(name, (await zip.file(name).async('string')).replace('<sheet ', '<sheet xmlns="urn:unknown" '));
  });
  await assert.rejects(readWorkbook(unknown, { mode: 'first' }), /命名空间/);
});

test('XLSX bounds actual metadata bytes before buffering or XML parsing', async t => {
  const yauzl = require('yauzl'), open = yauzl.fromBufferPromise;
  const input = await workbook({ Data: [['id'], ['1']] });
  let chunksRead = 0, stopped = false;
  t.mock.method(yauzl, 'fromBufferPromise', async (...args) => {
    const zip = await open(...args), read = zip.openReadStreamPromise.bind(zip);
    zip.openReadStreamPromise = async entry => {
      if (entry.fileName !== 'xl/workbook.xml') return read(entry);
      // Simulate a decompressor whose actual output exceeds the small ZIP-directory declaration.
      return (async function* () {
        const chunk = Buffer.alloc(1024 * 1024, 32);
        try { for (let i = 0; i < 256; i++) { chunksRead++; yield chunk; } }
        finally { stopped = true; }
      })();
    };
    return zip;
  });
  await assert.rejects(readWorkbook(input, { mode: 'first' }), /128 MiB/);
  assert.equal(chunksRead, 129);
  assert.equal(stopped, true);
});
