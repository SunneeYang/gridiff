'use strict';
const { readTable, readTableRows } = require('./csv');
const { compareTables } = require('./diff');
const worksheetTable = (sheet, options) => readTableRows(sheet?.values || [], options, sheet?.metadata || []);
const byteLength = input => typeof input === 'string' ? new TextEncoder().encode(input).length : input.byteLength;

const MAX_BYTES = 8 * 1024 * 1024;
const MAX_CELLS = 1000000;

// Both hosts compare the same in-memory snapshot; file access belongs to the host.
function createComparison({ xlsx = false, options: initialOptions = {}, getDefaults, workbookReader } = {}) {
  const defaults = () => ({ format: 'auto', keyColumns: [], ...(getDefaults ? getDefaults() : initialOptions) });
  let options = defaults();
  const sheetOptions = new Map();
  let texts, workbooks, loaded = false, sheets = [], sheetName;
  let result = null, tables = null, error = '', revision = 0;

  function snapshot() {
    const nonempty = tables?.filter(table => table.fields.length) || [];
    const fields = nonempty[0]?.fields.filter(field => nonempty.every(table => table.fields.some(other => other.name === field.name))) || [];
    return { result, error, revision, options, xlsx, sheets, sheetName,
      skipped: tables?.map(table => table.skippedBlankRows || 0) || [],
      keyFields: fields.map(({ name, label }) => ({ name, label })) };
  }

  function compute() {
    try {
      if (!loaded) return;
      result = null; tables = null; error = '';
      if (xlsx) {
        if (sheetName) sheetOptions.set(sheetName, options);
        const oldSheets = new Map(workbooks[0].map(sheet => [sheet.name, sheet]));
        const newSheets = new Map(workbooks[1].map(sheet => [sheet.name, sheet]));
        const names = [...newSheets.keys(), ...[...oldSheets.keys()].filter(name => !newSheets.has(name))];
        let cells = 0;
        const comparisons = names.map(name => {
          const config = sheetOptions.get(name) || defaults();
          let pair, diff, failure = '';
          try {
            pair = [worksheetTable(oldSheets.get(name), config), worksheetTable(newSheets.get(name), config)];
            cells += (pair[0].rows.length + pair[1].rows.length) * new Set(pair.flatMap(table => table.fields.map(field => field.name))).size;
            if (cells > MAX_CELLS) throw new Error('比较范围超过 100 万单元格，请缩小工作簿。');
            diff = compareTables(...pair, config);
          } catch (e) { failure = e.message; }
          return { name, tables: pair, result: diff, error: failure, options: config,
            status: !oldSheets.has(name) ? 'added' : !newSheets.has(name) ? 'removed' : 'common' };
        });
        if (cells > MAX_CELLS) throw new Error('比较范围超过 100 万单元格，请缩小工作簿。');
        if (!names.includes(sheetName)) sheetName = comparisons.find(comparison => comparison.error || comparison.status !== 'common' || comparison.result?.rows.some(row => row.status !== 'unchanged' || row.moved) || comparison.result?.schema.length)?.name || names[0];
        const current = comparisons.find(comparison => comparison.name === sheetName);
        sheets = comparisons.map(comparison => ({ name: comparison.name, status: comparison.status, counts: comparison.result?.counts, error: comparison.error }));
        if (!current) throw new Error('工作簿中没有工作表。');
        ({ tables, result, error, options } = current);
        return;
      }
      tables = texts.map(text => readTable(text, options));
      const width = new Set(tables.flatMap(table => table.fields.map(field => field.name))).size;
      if ((tables[0].rows.length + tables[1].rows.length) * width > MAX_CELLS) throw new Error('比较范围超过 100 万单元格，请缩小表格或使用文本对比。');
      result = compareTables(...tables, options);
    } catch (e) { error = e.message; result = null; sheets = []; }
    finally { revision++; }
  }

  function fail(reason) {
    error = reason.message || String(reason);
    result = null; tables = null; texts = null; workbooks = null; loaded = false; sheets = [];
    revision++;
    return snapshot();
  }

  return {
    get tables() { return tables; },
    snapshot,
    fail,
    async load(inputs) {
      try {
        if (!Array.isArray(inputs) || inputs.length !== 2) throw new Error('请选择旧版本和新版本两个文件。');
        if (inputs.some(input => byteLength(input) > MAX_BYTES)) throw new Error('单侧文件超过 8 MiB，请缩小表格或工作簿。');
        if (xlsx) workbooks = await Promise.all(inputs.map(input => byteLength(input) ? workbookReader(input) : []));
        else texts = inputs.map(input => typeof input === 'string' ? input : new TextDecoder('utf-8').decode(input));
        loaded = true;
        compute();
      } catch (e) { return fail(e); }
      return snapshot();
    },
    update(patch) { options = { ...options, ...patch }; compute(); return snapshot(); },
    selectSheet(name) {
      if (xlsx && sheets.some(sheet => sheet.name === name)) {
        sheetOptions.set(sheetName, options);
        sheetName = name; options = sheetOptions.get(name) || defaults();
        compute();
      }
      return snapshot();
    },
    swap() { texts?.reverse(); workbooks?.reverse(); compute(); return snapshot(); }
  };
}

module.exports = { createComparison, MAX_BYTES, MAX_CELLS };
