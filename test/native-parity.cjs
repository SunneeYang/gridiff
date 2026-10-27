'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { createComparison } = require('../src/comparison');
const { readWorkbook } = require('../src/xlsx');
const { selectView } = require('../media/view');
const { workbook } = require('./xlsx-fixtures');
const { startComparisonServer } = require('./browser-server.cjs');

const fullView = { view: 'grid', onlyChanges: false, onlyFields: false, query: '', page: 0 };
const selectionArgs = selection => selection.mode === 'named'
  ? selection.names.flatMap(name => ['--sheet', name]) : ['--sheets', selection.mode];
const serializable = value => JSON.parse(JSON.stringify(value));

function referencePayload(state, view) {
  const data = Object.fromEntries(['result', 'error', 'options', 'xlsx', 'sheets', 'sheetName', 'skipped', 'keyFields']
    .filter(key => state[key] !== undefined).map(key => [key, state[key]]));
  if (state.xlsx) data.sheetSelection = state.sheetSelection;
  if (data.result) {
    const { rows, pageInfo } = selectView(data.result, view);
    const indexes = pageInfo.fieldIndexes;
    data.result = { ...data.result, fields: indexes.map(i => data.result.fields[i]),
      rows: rows.map(({ key, ...row }) => ({ ...row, cells: indexes.map(i => row.cells[i]) })) };
    data.pageInfo = { ...pageInfo, fieldIndexes: indexes.map((_, i) => i) };
  }
  return serializable(data);
}

function nativePayload(data) {
  const value = Object.fromEntries(['result', 'error', 'options', 'xlsx', 'sheets', 'sheetName', 'skipped', 'keyFields', 'pageInfo']
    .filter(key => data[key] !== undefined).map(key => [key, data[key]]));
  if (data.xlsx) value.sheetSelection = data.sheetSelection;
  if (value.result) value.result = { ...value.result, rows: value.result.rows.map(({ displayName, schemaChanged, ...row }) => row) };
  return serializable(value);
}

async function scenario(name, inputs, { xlsx = false, selection = { mode: 'first' }, options, run } = {}) {
  const directory = path.join(process.env.CODEX_AGENT_TMP, name);
  await fs.mkdir(directory, { recursive: true });
  const files = ['old', 'new'].map(name => path.join(directory, name + (xlsx ? '.xlsx' : '.csv')));
  await Promise.all(files.map((file, i) => fs.writeFile(file, inputs[i])));
  const node = createComparison({ xlsx, workbookReader: readWorkbook });
  await node.load(inputs, selection);
  const server = await startComparisonServer({ files, args: selectionArgs(selection) });
  let id = 0, view = { ...fullView }, response;
  const metadata = await (await fetch(server.url + 'snapshot')).json();
  assert.equal(Object.hasOwn(metadata, 'inputs'), false, name + ': browser must not receive source inputs');
  assert.equal(metadata.xlsx, xlsx);
  assert.deepEqual(metadata.sheetSelection, selection);
  const send = async (message, expectedStatus = 200) => {
    const result = await fetch(server.url + 'compare', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: ++id, generation: metadata.generation, view, settings: response?.settings, ...message }) });
    assert.equal(result.status, expectedStatus, name + ': compare response status');
    const body = await result.json();
    if (expectedStatus !== 200) return body;
    assert.equal(body.id, id);
    assert.equal(body.error, undefined, name + ': transport-level error');
    assert.equal(body.data.generation, metadata.generation);
    assert.equal(Object.hasOwn(body.data, 'inputs'), false);
    assert.equal(Object.hasOwn(body.data, 'workbooks'), false);
    response = body.data;
    return body.data;
  };
  const check = (data = response, state = node.snapshot()) => {
    assert.deepEqual(nativePayload(data), referencePayload(state, view), name + ': native/Node parity');
  };
  const actions = {
    node, metadata, files, server, send, check,
    get response() { return response; },
    async update(patch) { node.update(patch); const data = await send({ action: 'options', options: patch }); check(data); return data; },
    async sheet(name) { node.selectSheet(name); view.page = 0; const data = await send({ action: 'sheet', name }); check(data); return data; },
    async swap() { node.swap(); view.page = 0; const data = await send({ action: 'swap' }); check(data); return data; },
    async view(patch) { view = { ...view, ...patch }; const data = await send({ action: 'view' }); check(data); return data; },
    async refresh() { node.update({}); view.page = 0; const data = await send({ action: 'refresh' }); check(data); return data; },
    async reload(settings = response.settings) { const data = await send({ action: 'load', settings }); check(data); return data; }
  };
  try {
    await send({ action: 'load' }); check();
    if (options) await actions.update(options);
    await run?.(actions);
    return { name, rows: response.pageInfo?.totalRows || 0, columns: response.result?.fields.length || 0,
      error: response.error || '', sheets: response.sheets?.length || 0 };
  } finally { await server.close(); }
}

(async () => {
  assert.ok(process.env.CODEX_AGENT_TMP, 'Run through agent-tmp-run');
  const results = [];
  const add = async (...args) => { if (process.env.GRIDIFF_NATIVE_CASE && !new RegExp(process.env.GRIDIFF_NATIVE_CASE).test(args[0])) return; const result = await scenario(...args); results.push(result); console.log('Native parity:', result.name); };
  await add('csv-order-schema', [
    'id,name,old,value\na,Alpha,x,1\nb,Beta,y,2\nc,Gamma,z,3\nd,Delta,x,4\ne,Epsilon,x,5',
    'value,id,name,new\n3,c,Gamma,n\n11,a,Alpha,n\n6,f,Zeta,n\n5,e,Epsilon,n'
  ], { run: async test => {
    assert.deepEqual(test.response.result.rows.map(row => row.identity), ['b', 'c', 'a', 'f', 'd', 'e']);
    await test.view({ onlyChanges: true, onlyFields: true });
    await test.view({ query: 'DELTA' });
    await test.view({ query: '', onlyChanges: false, onlyFields: false });
    await test.swap(); await test.swap();
    await test.send({ action: 'refresh', generation: test.metadata.generation + 1 }, 409);
    await test.refresh();
    await Promise.all(test.files.map(file => fs.unlink(file)));
    await test.refresh();
  } });
  await add('csv-quoted-and-long-ids', [
    '\uFEFFid,value\r\n001234567890123456789,"first\nline"\r\n"<>&\"\"",",comma"\r\n',
    'id,value\n001234567890123456789,"first\nchanged"\n"<>&\"\"",",comma"'
  ]);
  await add('csv-composite-key-recovery', [
    'group,key,value\ng,a,001\ng,b,9999999999999999999',
    'group,key,value\ng,a,002\ng,b,9999999999999999998'
  ], { options: { keyColumns: ['group', 'key'], format: 'csv' }, run: async test => {
    await test.swap(); await test.reload(); await test.swap();
  } });
  await add('csv-position', ['name,v\nA,1\nA,2\n\nB,3', 'name,v\nA,4\nA,2\nB,3'], { options: { alignment: 'position' } });
  await add('csv-custom-header', ['说明\nid,v\n编号,数值\na,1\nb,2', '说明\nid,v\n编号,数值\na,9\nc,3'],
    { options: { format: 'custom', headerRow: 2, descriptionRow: 3, dataStartRow: 4 } });
  await add('csv-headerless', ['a,1\nb,2', 'a,9\nb,2'], { options: { format: 'headerless' } });
  await add('mova-unkeyed-and-trailing', [
    'all,all,all\nint32,string,int32\nid,name,value\n编号,名称,值\n1,one,1,ignored\n,comment,2\n,comment,2\n2,two,2\n',
    'all,all,all\nint32,string,int32\nid,name,value\n编号,名称,值\n1,one,9,also ignored\n,comment,2\n,changed comment,2\n2,two,2\n'
  ]);
  await add('mova-vertical', [
    'all,int32,None,无,0\nall,int32,All,所有,1\nall,string,Text,文本,hello\nall,int32,,说明,9',
    'all,int32,None,无,0\ngo,int32,All,所有,2\nall,string,Text,文本,world\nall,int32,,说明,9'
  ]);
  await add('csv-empty-added', ['', 'id,v\na,1\nb,2']);
  await add('csv-empty-removed', ['id,v\na,1\nb,2', '']);
  await add('csv-bad-key', ['id,v\na,1\n,2', 'id,v\na,1\nb,2']);
  await add('csv-duplicate-header', ['id,id\na,b', 'id,id\na,b']);
  await add('csv-unterminated-quote', ['id,v\na,"bad', 'id,v\na,ok']);

  const sparseBefore = ['id,name,a,b,c'];
  const sparseAfter = ['id,name,a,b,c'];
  for (let i = 0; i < 235; i++) {
    sparseBefore.push(`${i},record${i},0,unchanged,stable`);
    sparseAfter.push(`${i},record${i},${i === 234 ? 1 : 0},unchanged,stable`);
  }
  await add('csv-sparse-global-columns-pagination', [sparseBefore.join('\n'), sparseAfter.join('\n')], { run: async test => {
    const sparse = await test.view({ onlyFields: true });
    assert.deepEqual(sparse.result.fields.map(field => field.name), ['a']);
    assert.equal(sparse.pageInfo.totalRows, 235); assert.equal(sparse.result.rows.length, 100);
    const last = await test.view({ page: 2 }); assert.equal(last.result.rows.length, 35);
    const searched = await test.view({ query: 'record234', page: 0 });
    assert.equal(searched.result.rows.length, 1, 'search must inspect excluded fields and records outside current page');
    assert.deepEqual(searched.result.fields.map(field => field.name), ['a']);
    await test.view({ query: '', page: 9 });
    await test.view({ onlyChanges: true, page: 0 });
    await test.send({ action: 'options', options: { keyColumns: [null] } }, 400);
    await test.refresh();
  } });

  const date = new Date('2026-10-27T12:30:00Z');
  const typed = changed => workbook({ Data: [
    ['id', 'typed', 'rounded', 'date', 'boolean', 'error', 'rich', 'formula', 'missing', 'blank'],
    ['001234567890123456789', changed ? '1' : 1, changed ? 1.235 : 1.234, date, false, { error: '#DIV/0!' },
      { richText: [{ text: 'hello' }, { text: '世界' }] }, { formula: changed ? '2*1' : '1+1', result: 2 }, { formula: 'NOW()' }, { formula: 'IF(TRUE,"",1)', result: '' }],
    [], ['002', 2, 0.25, date, true, { error: '#N/A' }, 'literal', { formula: '1-1', result: 0 }]
  ] }, book => {
    const sheet = book.getWorksheet('Data');
    sheet.getCell('C2').numFmt = '0.0'; sheet.getCell('C4').numFmt = '0.0%';
    sheet.getCell('D2').numFmt = 'yyyy-mm-dd hh:mm'; sheet.getCell('D4').numFmt = 'yyyy-mm-dd';
    sheet.getCell('XFD1000').font = { bold: true };
  });
  await add('xlsx-types-formats-formula-caches', [await typed(false), await typed(true)], { xlsx: true, run: async test => {
    await test.swap(); await test.reload(); await test.swap();
    await test.view({ onlyChanges: true, onlyFields: true });
    await test.view({ query: 'DIV/0' });
    await test.view({ query: '', onlyChanges: false, onlyFields: false });
  } });
  const makeDateSystem = date1904 => workbook({ Data: [
    ['id', 'date', 'cached'], [1, date, { formula: 'NOW()', result: date }]
  ] }, book => {
    book.properties.date1904 = date1904;
    book.getWorksheet('Data').getCell('B2').numFmt = 'yyyy-mm-dd hh:mm:ss';
    book.getWorksheet('Data').getCell('C2').numFmt = 'yyyy-mm-dd';
  });
  await add('xlsx-date-1904', [await makeDateSystem(false), await makeDateSystem(true)], { xlsx: true });
  const formats = [
    ['general-decimal', 1.2345678901, 'General'], ['general-small', 1.23456789e-9, 'General'],
    ['general-large', 1234567890123, 'General'], ['general-negative', -12.3456, 'General'],
    ['grouping', 12345.678, '#,##0.00'], ['negative-section', -12345.678, '#,##0.00;[Red](#,##0.00);"zero"'],
    ['zero-section', 0, '#,##0.00;[Red](#,##0.00);"zero"'], ['percent', 0.125, '0.00%'],
    ['scientific', 12345.678, '0.00E+00'], ['fraction', 1.25, '# ?/?'],
    ['elapsed-half-day', 0.5, '[h]:mm:ss'], ['elapsed-over-day', 1.5, '[h]:mm:ss']
  ];
  const formatted = await workbook({ Data: [['id', 'value'], ...formats.map(([id, value]) => [id, value])] }, book => {
    formats.forEach(([, , format], i) => { book.getWorksheet('Data').getCell(`B${i + 2}`).numFmt = format; });
  });
  await add('xlsx-number-format-matrix', [formatted, formatted], { xlsx: true });
  await add('xlsx-numeric-text-keys', [
    await workbook({ Data: [['id', 'v'], [1, 12.3], ['1', 4]] }, book => { book.getWorksheet('Data').getCell('A2').numFmt = '000'; }),
    await workbook({ Data: [['id', 'v'], ['1', 4], [1, 12.3]] }, book => { book.getWorksheet('Data').getCell('B3').numFmt = '0.0000'; })
  ], { xlsx: true });
  const multiBefore = await workbook({ First: [['id', 'v'], ['1', 'old']], '中文, table': [['id', 'v'], ['2', 'before']], Gone: [['id'], ['3']] });
  const multiAfter = await workbook({ Renamed: [['id', 'v'], ['1', 'new']], '中文, table': [['id', 'v'], ['2', 'after']], Added: [['id'], ['4']] });
  await add('xlsx-first-rename', [multiBefore, multiAfter], { xlsx: true, run: async test => {
    assert.equal(test.response.sheets.length, 1); await test.swap(); await test.reload(); await test.swap();
  } });
  await add('xlsx-all-name-pairing', [multiBefore, multiAfter], { xlsx: true, selection: { mode: 'all' }, run: async test => {
    assert.deepEqual(test.response.sheets.map(sheet => sheet.name), ['Renamed', '中文, table', 'Added', 'First', 'Gone']);
    await test.sheet('中文, table'); await test.sheet('Added'); await test.sheet('Gone');
    await test.reload(); await test.swap(); await test.swap();
  } });
  await add('xlsx-named-multiple', [multiBefore, multiAfter], { xlsx: true,
    selection: { mode: 'named', names: ['Added', '中文, table'] }, run: async test => {
      assert.deepEqual(test.response.sheets.map(sheet => sheet.name), ['中文, table', 'Added']);
      await test.sheet('Added'); await test.swap(); await test.reload();
    } });
  await add('xlsx-named-absent-both', [multiBefore, multiAfter], { xlsx: true, selection: { mode: 'named', names: ['中文, table', 'typo'] } });
  const shared = await workbook({ Data: [['id', 'v'], ['1', { formula: '1+2', result: 3 }],
    ['2', { sharedFormula: 'B2', result: 3 }], ['3', { formula: 'FALSE()', result: false }], ['4', { formula: '1/0', result: { error: '#DIV/0!' } }]] });
  const literal = await workbook({ Data: [['id', 'v'], ['1', 3], ['2', 3], ['3', false], ['4', { error: '#DIV/0!' }]] });
  await add('xlsx-shared-formula-vs-literal', [shared, literal], { xlsx: true });
  await add('xlsx-empty-added', [Buffer.alloc(0), literal], { xlsx: true });
  const output = process.env.GRIDIFF_NATIVE_REPORT;
  if (output) await fs.writeFile(output, JSON.stringify({ date: new Date().toISOString(), scenarios: results.length, results }, null, 2) + '\n');
  console.log(`Native Go matches Node across ${results.length} CSV/XLSX scenarios; only paged display results cross HTTP.`);
})().catch(error => { console.error(error); process.exitCode = 1; });
