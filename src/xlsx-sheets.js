'use strict';
const { SaxesParser } = require('saxes');
const path = require('node:path').posix;

const MAIN = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const PACKAGE = 'http://schemas.openxmlformats.org/package/2006/relationships';
const STRICT_MAIN = 'http://purl.oclc.org/ooxml/spreadsheetml/main';
const STRICT_REL = 'http://purl.oclc.org/ooxml/officeDocument/relationships';

async function worksheetPaths(entries, readEntry, selection) {
  if (selection.mode === 'all') return null;
  async function read(name, visit) {
    if (!entries.has(name)) throw new Error('XLSX 缺少工作簿或工作表关系信息。');
    const bytes = await readEntry(name);
    const encoding = bytes[0] === 0xff && bytes[1] === 0xfe ? 'utf-16le' : bytes[0] === 0xfe && bytes[1] === 0xff ? 'utf-16be' : 'utf-8';
    const parser = new SaxesParser({ xmlns: true }), stack = [];
    parser.on('doctype', () => { throw new Error('XLSX XML 不允许包含 DTD。'); });
    parser.on('opentag', tag => { visit(tag, stack); stack.push(tag); });
    parser.on('closetag', () => stack.pop());
    parser.write(new TextDecoder(encoding, { fatal: true }).decode(bytes)).close();
  }
  const selectedIDs = new Map(), paths = new Set();
  let sheetIndex = 0;
  await read('xl/workbook.xml', (tag, stack) => {
    if (!stack.length && (tag.local !== 'workbook' || ![MAIN, STRICT_MAIN, ''].includes(tag.uri))) throw new Error('XLSX 工作簿命名空间无效或不受支持。');
    if (stack.length === 2 && stack[1].local === 'sheets' && tag.local === 'sheet') {
      const name = tag.attributes.name?.value;
      const selected = selection.mode === 'first' ? sheetIndex++ === 0 : selection.names.includes(name);
      if (!selected) return;
      if (tag.uri !== stack[0].uri || stack[1].uri !== stack[0].uri) throw new Error('XLSX 所选工作表命名空间无效。');
      const id = Object.values(tag.attributes).find(attr => [REL, STRICT_REL].includes(attr.uri) && attr.local === 'id')?.value;
      if (!id || selectedIDs.has(id)) throw new Error('XLSX 所选工作表的关系标识缺失或重复。');
      selectedIDs.set(id, false);
    }
  });
  if (!selectedIDs.size && !entries.has('xl/_rels/workbook.xml.rels')) return paths;
  const ids = new Set();
  await read('xl/_rels/workbook.xml.rels', (tag, stack) => {
    if (stack.length !== 1 || stack[0].uri !== PACKAGE || stack[0].local !== 'Relationships' || tag.uri !== PACKAGE || tag.local !== 'Relationship') return;
    const attrs = Object.fromEntries(Object.values(tag.attributes).filter(attr => !attr.uri).map(attr => [attr.local, attr.value]));
    if (!attrs.Id || ids.has(attrs.Id)) throw new Error('XLSX 工作表关系标识无效或重复。');
    ids.add(attrs.Id);
    if (!selectedIDs.has(attrs.Id)) return;
    const target = attrs.Target;
    if (![REL + '/worksheet', STRICT_REL + '/worksheet'].includes(attrs.Type) || (attrs.TargetMode && attrs.TargetMode !== 'Internal') || !target || /[\\?#:]/.test(target) || path.normalize(target) !== target || target.startsWith('../')) throw new Error('XLSX 所选工作表关系无效。');
    const selected = target.startsWith('/') ? target.slice(1) : 'xl/' + target;
    if (!/^xl\/worksheets\/[^/]+\.xml$/.test(selected) || !entries.has(selected)) throw new Error('XLSX 所选工作表不存在或路径无效。');
    paths.add(selected); paths.add('xl/worksheets/_rels/' + path.basename(selected) + '.rels');
    selectedIDs.set(attrs.Id, true);
  });
  if ([...selectedIDs.values()].some(found => !found)) throw new Error('XLSX 找不到所选工作表的关系。');
  return paths;
}

function unusedWorksheet(name, paths) {
  return paths !== null && name.startsWith('xl/worksheets/') && !name.endsWith('/') && !paths.has(name);
}

module.exports = { worksheetPaths, unusedWorksheet };
