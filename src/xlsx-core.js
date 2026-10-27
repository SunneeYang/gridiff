'use strict';

const MAX_CELLS = 1000000;

function cellValue(cell, date1904) {
  const SSF = require('ssf');
  let value = cell.type === 6 ? cell.result : cell.value;
  if (value?.richText) value = value.richText.map(part => part.text).join('');
  else if (value?.hyperlink) value = value.text;
  let type = value == null ? 'empty' : typeof value;
  let raw = value ?? null;
  let numeric = value;
  if (value instanceof Date) {
    // shortcut: ExcelJS normalizes dates to milliseconds; retain OOXML serials if finer precision is needed.
    if (!Number.isFinite(value.getTime())) throw new Error(`单元格 ${cell.address} 的日期无效。`);
    type = 'date'; raw = value.toISOString();
    numeric = 25569 + value.getTime() / 86400000 - (date1904 ? 1462 : 0);
  } else if (value?.error) { type = 'error'; raw = value.error; }
  else if (typeof value === 'number' && (!Number.isFinite(value) || (Number.isInteger(value) && !Number.isSafeInteger(value)))) {
    throw new Error(`单元格 ${cell.address} 的数值超出安全精度，请在源文件中将长 ID 保存为文本。`);
  }
  let text = raw === null ? '' : type === 'boolean' ? (raw ? 'TRUE' : 'FALSE') : String(raw);
  if (type === 'number' || type === 'date') {
    try { text = SSF.format(cell.numFmt || (type === 'date' ? 'yyyy-mm-dd hh:mm:ss' : 'General'), numeric, { date1904 }); }
    catch { /* An unsupported display format must not hide the underlying value. */ }
    if (text === '') text = String(raw);
  }
  return { text, meta: { type, raw } };
}

async function readWorkbookData(Workbook, input, onMetric) {
  const book = new Workbook();
  let start = onMetric ? performance.now() : 0;
  await book.xlsx.load(input, { ignoreNodes: ['mergeCells', 'dataValidations', 'conditionalFormatting', 'drawing', 'picture', 'extLst'] });
  onMetric?.({ phase: 'xlsx.load', ms: performance.now() - start, bytes: input.byteLength });
  start = onMetric ? performance.now() : 0;
  let area = 0;
  // Both hosts strip unselected sheet ZIP members before loading.
  const sheets = book.worksheets.map(sheet => {
    const values = [], metadata = [];
    let height = 0, width = 0;
    sheet.eachRow(row => row.eachCell(cell => {
      if (cell.value === null || cell.value === '') return;
      height = Math.max(height, row.number); width = Math.max(width, cell.col);
    }));
    area += height * width;
    if (area > MAX_CELLS) throw new Error('XLSX 有值区域超过 100 万单元格，请缩小工作簿（包含区域内的空白）。');
    for (let i = 0; i < height; i++) { values.push([]); metadata.push([]); }
    sheet.eachRow(row => row.eachCell(cell => {
      if (row.number > height || cell.col > width) return;
      const { text, meta } = cellValue(cell, book.properties.date1904 === true);
      values[row.number - 1][cell.col - 1] = text;
      metadata[row.number - 1][cell.col - 1] = meta;
    }));
    for (const row of values) {
      for (let i = 0; i < row.length; i++) row[i] ??= '';
      while (row.at(-1) === '') row.pop();
    }
    return { name: sheet.name, values, metadata };
  });
  onMetric?.({ phase: 'xlsx.normalize', ms: performance.now() - start, cells: area, sheets: sheets.length });
  return sheets;
}

module.exports = { readWorkbookData };
