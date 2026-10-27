'use strict';

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

function readTable(text, options = {}) {
  const rows = parseCSV(text);
  let format = options.format || 'auto';
  if (format === 'auto') format = isMova(rows) ? 'mova' : 'csv';
  if (!['csv', 'mova', 'custom', 'headerless'].includes(format)) throw new Error('未知 CSV 格式。');
  if (!rows.length) return { format, fields: [], rows: [] };
  const header = format === 'mova' ? 3 : format === 'custom' ? options.headerRow : 1;
  const start = format === 'mova' ? 5 : format === 'custom' ? options.dataStartRow : format === 'headerless' ? 1 : 2;
  const description = format === 'mova' ? 4 : format === 'custom' ? options.descriptionRow || 0 : 0;
  if (format !== 'headerless' && (!Number.isInteger(header) || header < 1 || !Number.isInteger(start) || start <= header ||
      !Number.isInteger(description) || description < 0 || description >= start || (description && description === header))) {
    throw new Error('表头配置不合法：字段名、说明必须在数据起始记录之前，且不能是同一行。');
  }
  if (format !== 'headerless' && (!rows[header - 1] || (description && !rows[description - 1]))) throw new Error('文件不足以包含指定的表头。');
  const names = format === 'headerless'
    ? Array.from({ length: rows.reduce((max, row) => Math.max(max, row.length), 0) }, (_, i) => `列${i + 1}`)
    : rows[header - 1];
  const seen = new Set();
  const fields = names.map((name, i) => {
    if (!name.trim()) throw new Error(`第 ${i + 1} 列没有字段名，请选择正确的表头格式。`);
    if (seen.has(name)) throw new Error(`字段名「${name}」重复，无法按字段对齐。`);
    seen.add(name);
    return { name, label: description ? rows[description - 1][i] || name : name,
      type: format === 'mova' ? rows[1][i] || '' : '', flags: format === 'mova' ? rows[0][i] || '' : '' };
  });
  for (const [i, row] of rows.entries()) {
    // Mova JSON export reads declared fields only; trailing data cells are ignored.
    if (format === 'mova' && i >= start - 1) continue;
    if (row.slice(fields.length).some(value => value !== '')) throw new Error(`第 ${i + 1} 条记录有 ${row.length} 列，超出表头的 ${fields.length} 列；请检查格式或源文件。`);
  }
  const data = rows.slice(start - 1).map((row, i) => ({
    record: start + i, values: fields.map((_, j) => row[j] ?? '')
  }));
  return { format, fields, skippedBlankRows: data.filter(row => row.values.every(value => value === '')).length,
    rows: data.filter(row => row.values.some(value => value !== '')) };
}

module.exports = { parseCSV, readTable, isMova };
