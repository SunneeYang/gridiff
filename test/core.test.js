'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { parseCSV, readTable } = require('../src/csv');
const { compareTables } = require('../src/diff');
const compare = (left, right, options) => compareTables(readTable(left, options), readTable(right, options), options);

test('RFC CSV: BOM, CRLF, quoted multiline, escaped quote, comma and no final newline', () => {
  assert.deepEqual(parseCSV('\uFEFFid,text\r\n001,"a,b\r\n""q"""\r\n002,'), [['id', 'text'], ['001', 'a,b\r\n"q"'], ['002', '']]);
  assert.deepEqual(parseCSV(''), []);
  assert.deepEqual(parseCSV('a,b\n'), [['a', 'b']]);
  assert.deepEqual(parseCSV('""'), [['']]);
});
test('reject broken quotes rather than silently comparing corrupted records', () => {
  for (const text of ['a,"unfinished', 'a,b"c', 'a,"b"oops']) assert.throws(() => parseCSV(text), /引号/);
});
test('empty separators preserve record positions; pad omitted trailing empty cells', () => {
  const table = readTable('id,name,x\n1,A\n,,\n\n2,B,');
  assert.equal(table.skippedBlankRows, 2);
  assert.deepEqual(table.rows.map(r => r.record), [2, 5]);
  assert.deepEqual(table.rows[0].values, ['1', 'A', '']);
  assert.equal(readTable('id,name\n1,A,,').rows[0].values.length, 2);
  assert.throws(() => readTable('id,name\n1,A,not-empty'), /超出表头/);
});
test('Mova auto format and schema changes are independent of value changes', () => {
  const fixture = name => fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8');
  const diff = compare(fixture('before.csv'), fixture('after.csv'));
  assert.deepEqual(diff.formats, ['mova', 'mova']);
  assert.deepEqual(diff.counts, { added: 1, removed: 1, modified: 3, unchanged: 1, moved: 0, cells: 4, schema: 1 });
  assert.equal(diff.schema[0].name, 'precious');
  assert.equal(diff.fields.find(f => f.name === 'price').after.label, '售卖价格');
  assert.equal(readTable('all,none\nint32,string\nid,note\n编号,备注\n1,hello').format, 'mova');
  assert.equal(readTable('all,ts\nint32,Array(int32）\nid,values\n编号,数值\n1,2').format, 'mova');
});
test('Mova ignores data beyond the header just as JSON export does', () => {
  const header = 'all,all\nint32,string\nid,name\n编号,名称\n';
  const before = header + '1,A,46021,1767024000\n2,B\n,,extra-only';
  const after = header + '1,A,46028,1767628800\n2,C,,extra';
  for (const format of ['auto', 'mova']) {
    const table = readTable(before, { format });
    assert.deepEqual(table.fields.map(field => field.name), ['id', 'name']);
    assert.deepEqual(table.rows, [{ record: 5, values: ['1', 'A'] }, { record: 6, values: ['2', 'B'] }]);
    assert.equal(table.skippedBlankRows, 1);
    const diff = compare(before, after, { format });
    assert.deepEqual(diff.counts, { added: 0, removed: 0, modified: 1, unchanged: 1, moved: 0, cells: 1, schema: 0 });
    assert.deepEqual(diff.rows[1].cells[1], { before: 'B', after: 'C', changed: true });
  }
  assert.throws(() => readTable(before, { format: 'custom', headerRow: 3, descriptionRow: 4, dataStartRow: 5 }), /超出表头/);
  assert.throws(() => readTable('all,all,none\nint32,string\nid,name\n编号,名称\n1,A'), /超出表头/);
});
test('keys and column names align independently of their physical order', () => {
  const diff = compare('id,a,b\n001,x,y\n002,z,w', 'b,id,a\nw,002,z\ny,001,changed');
  assert.equal(diff.counts.modified, 1);
  assert.equal(diff.counts.cells, 1);
  assert.equal(diff.counts.moved, 2);
  assert.equal(diff.schema[0].kind, 'order');
  assert.equal(diff.rows[1].identity, '001');
  assert.deepEqual(diff.rows[1].cells[2], { before: 'x', after: 'changed', changed: true });
});
test('inserting and removing a row/field does not imply reorder', () => {
  const diff = compare('id,a,b\n1,x,y\n2,z,w', 'new,id,b\nv,0,x\nv,1,y\nv,2,w');
  assert.equal(diff.counts.moved, 0);
  assert.equal(diff.counts.modified, 0);
  assert.deepEqual(diff.schema.map(s => s.kind), ['added', 'removed']);
});
test('deleted blocks stay by old neighbours while surviving and added rows follow the new CSV', () => {
  const csv = ids => 'id,value\n' + ids.map(id => `${id},same`).join('\n');
  for (const [before, after, expected, moved = 0] of [
    [['X', 'Y', 'A', 'D', 'E', 'B', 'T', 'U'], ['A', 'B'], ['X', 'Y', 'A', 'D', 'E', 'B', 'T', 'U']],
    [['A', 'D', 'B'], ['A', 'N', 'B'], ['A', 'N', 'D', 'B']],
    [['A', 'D'], ['A', 'N'], ['A', 'D', 'N']],
    [['A', 'B', 'D'], ['B', 'A'], ['B', 'D', 'A'], 2],
    [['A', 'B'], ['N', 'M'], ['A', 'B', 'N', 'M']],
    [['A', 'B'], [], ['A', 'B']],
    [[], ['N', 'M'], ['N', 'M']]
  ]) {
    const diff = compare(csv(before), csv(after));
    assert.deepEqual(diff.rows.map(row => row.identity), expected);
    assert.deepEqual(diff.rows.filter(row => row.status !== 'removed').map(row => row.identity), after);
    assert.equal(diff.counts.removed, before.filter(id => !after.includes(id)).length);
    assert.equal(diff.counts.added, after.filter(id => !before.includes(id)).length);
    assert.equal(diff.counts.modified, 0);
    assert.equal(diff.counts.moved, moved);
  }
});
test('missing and duplicate keys never overwrite; composite keys are unambiguous', () => {
  assert.throws(() => compare('id,v\n1,a\n1,b', ''), /重复/);
  assert.throws(() => compare('id,v\n,a', ''), /缺少主键值/);
  assert.throws(() => compare('id,v\n1,a', 'other,v\n1,a', { keyColumns: ['id'] }), /缺少主键字段/);
  const diff = compare('a,b,v\nx,y|z,1\nx|y,z,2', 'a,b,v\nx,y|z,3\nx|y,z,2', { keyColumns: ['a', 'b'] });
  assert.equal(diff.rows.length, 2);
  assert.equal(diff.counts.modified, 1);
});
test('empty sides, only headers and deleted fields retain absent versus empty', () => {
  assert.equal(compare('', '').rows.length, 0);
  assert.equal(compare('id,v\n1,', '').counts.removed, 1);
  assert.equal(compare('', 'id,v\n1,').counts.added, 1);
  assert.equal(compare('id,v', 'id,v').rows.length, 0);
  const diff = compare('id,v\n1,', 'id\n1');
  assert.deepEqual(diff.rows[0].cells[1], { before: '', after: null, changed: true });
});
test('keep whitespace, huge integers, zero and HTML as literal values', () => {
  const diff = compare('id,v\n0001,9007199254740993\n0002,0\n0003,<script>oops</script>', 'id,v\n0001,9007199254740994\n0002,\n0003, <script>oops</script>');
  assert.equal(diff.counts.modified, 3);
  assert.equal(diff.rows[0].cells[1].before, '9007199254740993');
  assert.equal(diff.rows[0].identity, '0001');
});
test('explicit headerless/custom layouts and position alignment', () => {
  const raw = readTable('all,EZone,Home,地区,1\nall,EZone,World,世界,2', { format: 'headerless' });
  assert.equal(raw.rows.length, 2);
  assert.equal(raw.fields[0].name, '列1');
  const custom = readTable('Report\nid,name\n编号,名称\n001,A', { format: 'custom', headerRow: 2, descriptionRow: 3, dataStartRow: 4 });
  assert.equal(custom.fields[1].label, '名称');
  assert.equal(compareTables(raw, raw, { alignment: 'position' }).counts.unchanged, 2);
  assert.throws(() => readTable('id,id\n1,2'), /重复/);
  assert.throws(() => readTable('id,\n1,2'), /没有字段名/);
  assert.throws(() => readTable('id,v\n1,2', { format: 'custom', headerRow: 2, dataStartRow: 2 }), /配置不合法/);
});
test('metadata changes and relative row order are reported without fake value modifications', () => {
  const a = 'all,ts\nint32,int32\nid,v\n编号,数值\n1,2\n2,3';
  const b = 'all,all\nint32,string\nid,v\n编号,说明\n2,3\n1,2';
  const diff = compare(a, b);
  assert.deepEqual(diff.schema.map(s => s.kind), ['label', 'type', 'flags']);
  assert.equal(diff.counts.cells, 0);
  assert.equal(diff.counts.moved, 2);
});

test('Mova review CSV retains repeated empty-ID rows while keyed values remain comparable', () => {
  const header = 'ts,none,ts\nint32,string,string\nid,name,effect\n编号,名称,效果\n';
  const before = header + '1,有效记录,Qi_-5\n,停用记录,1702012\n,停用记录,1702012';
  const after = header + '1,有效记录,Qi_-3\n,停用记录,1702012\n,停用记录,1702012';
  const diff = compare(before, after);
  assert.equal(diff.rows.length, 3);
  assert.equal(diff.counts.modified, 1);
  assert.equal(diff.counts.cells, 1);
  assert.equal(diff.counts.unchanged, 2);
  assert.deepEqual(diff.unkeyed, { before: 2, after: 2 });
  assert.equal(new Set(diff.rows.map(row => row.key)).size, 3);
  assert.deepEqual(diff.rows.filter(row => row.unkeyed).map(row => [row.beforeRecord, row.afterRecord]), [[6, 6], [7, 7]]);
});

test('Mova rows without IDs only match identical full content; edits and duplicate removal stay visible', () => {
  const header = 'ts,none,ts\nint32,string,string\nid,name,effect\n编号,名称,效果\n';
  const diff = compare(header + '1,A,x\n,重复,a\n,重复,a\n,停用,old', header + '1,A,x\n,重复,a\n,停用,new');
  assert.deepEqual(diff.unkeyed, { before: 3, after: 2 });
  assert.equal(diff.counts.modified, 0);
  assert.equal(diff.counts.added, 1);
  assert.equal(diff.counts.removed, 2);
  assert.equal(diff.counts.moved, 0);
  const deleted = diff.rows.filter(row => row.unkeyed && row.status === 'removed');
  assert.deepEqual(deleted.map(row => row.cells[2].before), ['a', 'old']);
  const added = diff.rows.find(row => row.unkeyed && row.status === 'added');
  assert.equal(added.beforeRecord, null);
  assert.equal(added.cells[2].after, 'new');
});

test('deleted empty-ID duplicates keep their position next to matching rows', () => {
  const header = 'ts,none,ts\nint32,string,string\nid,name,effect\n编号,名称,效果\n';
  const diff = compare(header + '1,A,x\n,重复,a\n,重复,a\n2,B,y', header + '1,A,x\n,重复,a\n2,B,y');
  assert.deepEqual(diff.rows.map(row => [row.beforeRecord, row.afterRecord]), [[5, 5], [6, 6], [7, null], [8, 7]]);
  assert.equal(diff.counts.moved, 0);
  assert.equal(diff.counts.removed, 1);
});

test('empty-ID content matching follows field names and cannot disturb keyed row ordering', () => {
  const before = 'ts,none,ts\nint32,string,string\nid,name,effect\n编号,名称,效果\n1,A,x\n,停用,a\n2,B,y';
  const after = 'ts,ts,none\nint32,string,string\nid,effect,name\n编号,效果,名称\n,changed,新停用\n0,z,新记录\n1,x,A\n2,y,B\n,a,停用';
  const diff = compare(before, after);
  assert.equal(diff.counts.modified, 0);
  assert.equal(diff.counts.moved, 0);
  const matched = diff.rows.find(row => row.unkeyed && row.status === 'unchanged');
  assert.equal(matched.beforeRecord, 6);
  assert.equal(matched.afterRecord, 9);
  assert.equal(diff.schema[0].kind, 'order');
});

test('Mova missing-key exception is limited to an exactly empty leading id column', () => {
  const header = 'ts,ts\nint32,string\nid,kind\n编号,类型\n';
  assert.throws(() => compare(header + ' ,value', header), /缺少主键值/);
  assert.throws(() => compare(header + ',value', header, { keyColumns: ['id', 'kind'] }), /缺少主键值/);
  const diff = compare(header + ',value', header + ',value', { alignment: 'position' });
  assert.equal(diff.rows[0].unkeyed, false);
  assert.deepEqual(diff.unkeyed, { before: 0, after: 0 });
});
