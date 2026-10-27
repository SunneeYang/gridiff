'use strict';
const { readTable, readTableRows } = require('./csv');
const { compareTables } = require('./diff');
const { sheetSelection: normalizeSheetSelection } = require('./sheets');
const worksheetTable = (sheet, options) => readTableRows(sheet?.values || [], options, sheet?.metadata || []);
const byteLength = input => typeof input === 'string' ? new TextEncoder().encode(input).length : input.byteLength;

const MAX_BYTES = 8 * 1024 * 1024;
const MAX_CELLS = 1000000;

// The independent plugin compares in memory; native Go parity is checked with shared fixtures.
function createComparison({ xlsx = false, options: initialOptions = {}, sheetSelection: initialSheetSelection, getDefaults, workbookReader, workbookPairReader, onMetric } = {}) {
  function timed(phase, operation, counts = {}) {
    if (!onMetric) return operation();
    const start = performance.now();
    try { return operation(); }
    finally { onMetric({ phase, ms: performance.now() - start, ...counts }); }
  }
  const defaults = () => ({ format: 'auto', keyColumns: [], ...(getDefaults ? getDefaults() : initialOptions) });
  let options = defaults();
  let sheetSelection = normalizeSheetSelection(initialSheetSelection);
  const sheetOptions = new Map();
  const sheetCache = new Map();
  let texts, workbooks, loaded = false, sheets = [], sheetName;
  let result = null, tables = null, error = '', revision = 0;

  function snapshot() {
    const nonempty = tables?.filter(table => table.fields.length) || [];
    const fields = nonempty[0]?.fields.filter(field => nonempty.every(table => table.fields.some(other => other.name === field.name))) || [];
    return { result, error, revision, options, xlsx, sheets, sheetName, sheetSelection,
      skipped: tables?.map(table => table.skippedBlankRows || 0) || [],
      keyFields: fields.map(({ name, label }) => ({ name, label })) };
  }

  function compute() {
    try {
      if (!loaded) return;
      result = null; tables = null; error = '';
      if (xlsx) {
        if (sheetName) sheetOptions.set(sheetName, options);
        // Only explicit first-sheet mode pairs by position, including renamed sheets.
        const firstPair = sheetSelection.mode === 'first';
        const pairName = workbooks[1][0]?.name || workbooks[0][0]?.name;
        if (firstPair && sheetName && pairName && sheetName !== pairName) {
          sheetOptions.set(pairName, options); sheetName = pairName;
        }
        const oldSheets = new Map(workbooks[0].map(sheet => [firstPair ? workbooks[1][0]?.name || sheet.name : sheet.name, sheet]));
        const newSheets = new Map(workbooks[1].map(sheet => [sheet.name, sheet]));
        const names = [...newSheets.keys(), ...[...oldSheets.keys()].filter(name => !newSheets.has(name))];
        let cells = 0;
        const comparisons = names.map(name => {
          const config = sheetOptions.get(name) || defaults();
          const configKey = JSON.stringify(config);
          let cached = sheetCache.get(name);
          if (cached?.configKey !== configKey) {
            cached = { name, configKey, cells: 0, error: '', options: config,
              status: !oldSheets.has(name) ? 'added' : !newSheets.has(name) ? 'removed' : 'common' };
            try {
              cached.tables = timed('table.prepare', () => [worksheetTable(oldSheets.get(name), config), worksheetTable(newSheets.get(name), config)]);
              cached.cells = (cached.tables[0].rows.length + cached.tables[1].rows.length) * new Set(cached.tables.flatMap(table => table.fields.map(field => field.name))).size;
            } catch (e) { cached.error = e.message; }
          }
          cells += cached.cells;
          // The workbook budget includes cached and invalid-key sheets before allocating a diff.
          if (cells > MAX_CELLS) throw new Error('比较范围超过 100 万单元格，请缩小工作簿。');
          if (sheetCache.get(name) !== cached) {
            try {
              if (!cached.error) cached.result = timed('table.compare', () => compareTables(...cached.tables, config),
                { rows: cached.tables[0].rows.length + cached.tables[1].rows.length, columns: cached.tables[1].fields.length });
            } catch (e) { cached.error = e.message; }
            sheetCache.set(name, cached);
          }
          return cached;
        });
        if (!names.includes(sheetName)) sheetName = comparisons.find(comparison => comparison.error || comparison.status !== 'common' || comparison.result?.rows.some(row => row.status !== 'unchanged' || row.moved) || comparison.result?.schema.length)?.name || names[0];
        const current = comparisons.find(comparison => comparison.name === sheetName);
        sheets = comparisons.map(comparison => ({ name: comparison.name, status: comparison.status, counts: comparison.result?.counts, error: comparison.error }));
        if (!current) throw new Error('工作簿中没有工作表。');
        ({ tables, result, error, options } = current);
        return;
      }
      tables = timed('csv.parse', () => texts.map(text => readTable(text, options)));
      const width = new Set(tables.flatMap(table => table.fields.map(field => field.name))).size;
      if ((tables[0].rows.length + tables[1].rows.length) * width > MAX_CELLS) throw new Error('比较范围超过 100 万单元格，请缩小表格或使用文本对比。');
      result = timed('table.compare', () => compareTables(...tables, options), { rows: tables[0].rows.length + tables[1].rows.length, columns: width });
    } catch (e) { error = e.message; result = null; sheets = []; sheetCache.clear(); }
    finally { revision++; }
  }

  function fail(reason) {
    sheetCache.clear();
    error = reason.message || String(reason);
    result = null; tables = null; texts = null; workbooks = null; loaded = false; sheets = [];
    revision++;
    return snapshot();
  }

  return {
    get tables() { return tables; },
    snapshot,
    fail,
    async load(inputs, selection) {
      sheetCache.clear();
      try {
        if (xlsx) sheetSelection = normalizeSheetSelection(selection);
        if (!Array.isArray(inputs) || inputs.length !== 2) throw new Error('请选择旧版本和新版本两个文件。');
        if (inputs.some(input => byteLength(input) > MAX_BYTES)) throw new Error('单侧文件超过 8 MiB，请缩小表格或工作簿。');
        if (xlsx) {
          workbooks = [];
          if (workbookPairReader) workbooks = await workbookPairReader(inputs, sheetSelection);
          else {
            // Single-threaded hosts release one parser's expanded model before loading the next.
            for (const input of inputs) workbooks.push(byteLength(input) ? await workbookReader(input, sheetSelection) : []);
          }
          if (sheetSelection.mode === 'named') {
            const names = new Set(workbooks.flatMap(book => book.map(sheet => sheet.name)));
            const missing = sheetSelection.names.filter(name => !names.has(name));
            if (missing.length) throw new Error('两侧均找不到所选工作表：' + missing.join('、'));
          }
        }
        else texts = inputs.map(input => typeof input === 'string' ? input : new TextDecoder('utf-8').decode(input));
        loaded = true;
        compute();
      } catch (e) { return fail(e); }
      return snapshot();
    },
    update(patch) { options = { ...options, ...patch }; sheetCache.delete(sheetName); compute(); return snapshot(); },
    selectSheet(name) {
      if (xlsx && name !== sheetName && sheets.some(sheet => sheet.name === name)) {
        sheetOptions.set(sheetName, options);
        sheetName = name; options = sheetOptions.get(name) || defaults();
        compute();
      }
      return snapshot();
    },
    swap() { texts?.reverse(); workbooks?.reverse(); sheetCache.clear(); compute(); return snapshot(); }
  };
}

module.exports = { createComparison, MAX_BYTES, MAX_CELLS };
