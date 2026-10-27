'use strict';

// Empty XLSX cells share immutable metadata to avoid cloning one object per blank cell.
const emptyMetadata = Object.freeze({ type: 'empty', raw: null });

// Values stay strings: leading zeros, large IDs, whitespace and empty cells are significant.
function parseCSV(text) {
  text = text.replace(/^\uFEFF/, '');
  const rows = [];
  let row = [], value = '', quoted = false, closed = false, started = false;
  const cell = () => { row.push(value); value = ''; closed = false; };
  const record = () => {
    cell();
    rows.push(row);
    row = []; started = false;
  };
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { value += '"'; i++; }
      else if (c === '"') { quoted = false; closed = true; }
      else value += c;
      continue;
    }
    if (c === ',') { cell(); started = true; }
    else if (c === '\r' || c === '\n') {
      record();
      if (c === '\r' && text[i + 1] === '\n') i++;
    } else if (c === '"' && !value && !closed) { quoted = true; started = true; }
    else {
      if (closed || c === '"') throw new Error(`CSV 第 ${rows.length + 1} 条记录的引号格式不合法。`);
      value += c; started = true;
    }
  }
  if (quoted) throw new Error(`CSV 第 ${rows.length + 1} 条记录有未闭合的引号。`);
  if (started || row.length || value || closed) record();
  return rows;
}

function isMova(rows) {
  return rows.length >= 4 && rows[2].some(name => name.toLowerCase() === 'id') &&
    rows[0].some(Boolean) && rows[0].every(flag => !flag || /^(all|go|ts|cs|none|i18n)(,(all|go|ts|cs|none|i18n))*$/.test(flag));
}

function isMovaVertical(rows) {
  const sample = rows.filter(row => row.some(value => value !== '')).slice(0, 5);
  const fieldRow = row => row.length >= 3 && row[1].trim() && row[2].trim() &&
    /^(all|go|ts|cs|c#|dart|tss|none|i18n)(,(all|go|ts|cs|c#|dart|tss|none|i18n))*$/.test(row[0].trim());
  const first = sample[0];
  // A single enum row is valid; custom structure types require multiple field rows.
  const type = first?.[1]?.replace(/ /g, '').replace(/（/g, '(').replace(/）/g, ')') || '';
  const knownType = /^(u?int(?:32|64)?|float(?:32|64)?|number|range|string|(?:长整数|整数|长小数|小数|文本)(?:数组|Map)?)$/.test(type) || /^(Array|array|Map|map)\(.+\)$/.test(type);
  return Boolean(first && fieldRow(first) && first.length >= 4 && knownType) || sample.filter(fieldRow).length >= 2;
}

const verticalFields = [['flags', '导出标记'], ['type', '类型'], ['name', '名称'], ['comment', '说明'], ['value', '值']];

function readTable(text, options = {}) {
  return readTableRows(parseCSV(text), options);
}

function readTableRows(rows, options = {}, metadata) {
  let format = options.format || 'auto';
  if (format === 'auto') format = isMova(rows) ? 'mova' : isMovaVertical(rows) ? 'mova-vertical' : 'csv';
  if (!['csv', 'mova', 'mova-vertical', 'custom', 'headerless'].includes(format)) throw new Error('未知表格格式。');
  if (!rows.length) return { format, fields: [], rows: [] };
  const vertical = format === 'mova-vertical';
  const headerless = vertical || format === 'headerless';
  const header = format === 'mova' ? 3 : format === 'custom' ? options.headerRow : 1;
  const start = format === 'mova' ? 5 : format === 'custom' ? options.dataStartRow : headerless ? 1 : 2;
  const description = format === 'mova' ? 4 : format === 'custom' ? options.descriptionRow || 0 : 0;
  if (!headerless && (!Number.isInteger(header) || header < 1 || !Number.isInteger(start) || start <= header ||
      !Number.isInteger(description) || description < 0 || description >= start || (description && description === header))) {
    throw new Error('表头配置不合法：字段名、说明必须在数据起始记录之前，且不能是同一行。');
  }
  if (!headerless && (!rows[header - 1] || (description && !rows[description - 1]))) throw new Error('文件不足以包含指定的表头。');
  const names = headerless
    ? Array.from({ length: rows.reduce((max, row) => Math.max(max, row.length), vertical ? 5 : 0) }, (_, i) => vertical && verticalFields[i] ? verticalFields[i][0] : `列${i + 1}`)
    : rows[header - 1];
  const seen = new Set();
  const fields = names.map((name, i) => {
    if (!name.trim()) throw new Error(`第 ${i + 1} 列没有字段名，请选择正确的表头格式。`);
    if (seen.has(name)) throw new Error(`字段名「${name}」重复，无法按字段对齐。`);
    seen.add(name);
    return { name, label: vertical ? verticalFields[i]?.[1] || name : description ? rows[description - 1][i] || name : name,
      type: format === 'mova' ? rows[1][i] || '' : '', flags: format === 'mova' ? rows[0][i] || '' : '' };
  });
  for (const [i, row] of rows.entries()) {
    // Mova JSON export reads declared fields only; trailing data cells are ignored.
    if (format === 'mova' && i >= start - 1) continue;
    if (row.slice(fields.length).some(value => value !== '')) throw new Error(`第 ${i + 1} 条记录有 ${row.length} 列，超出表头的 ${fields.length} 列；请检查格式或源文件。`);
  }
  const data = rows.slice(start - 1).map((row, i) => ({
    record: start + i, values: fields.map((_, j) => row[j] ?? ''),
    ...(metadata ? { metadata: fields.map((_, j) => metadata[start + i - 1]?.[j] ?? emptyMetadata) } : {})
  }));
  return { format, fields, skippedBlankRows: data.filter(row => row.values.every(value => value === '')).length,
    rows: data.filter(row => row.values.some(value => value !== '')) };
}

module.exports = { parseCSV, readTable, readTableRows, isMova };
