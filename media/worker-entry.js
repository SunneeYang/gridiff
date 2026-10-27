'use strict';
const { Workbook } = require('exceljs/dist/exceljs.min.js');
const { createComparison, MAX_BYTES } = require('../src/comparison');
const { readWorkbookData } = require('../src/xlsx-core');

let comparison, sources, title, settings;
const sheetOptions = new Map();

function options(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('比较设置无效。');
  const next = {};
  for (const key of ['format', 'alignment', 'keyColumns', 'headerRow', 'dataStartRow', 'descriptionRow']) {
    if (Object.hasOwn(value, key)) next[key] = value[key];
  }
  if (next.format !== undefined && !['auto', 'csv', 'mova', 'mova-vertical', 'headerless', 'custom'].includes(next.format)) throw new Error('表头格式无效。');
  if (next.alignment !== undefined && !['key', 'position'].includes(next.alignment)) throw new Error('对齐方式无效。');
  if (next.keyColumns !== undefined && (!Array.isArray(next.keyColumns) || next.keyColumns.length > 256 || next.keyColumns.some(key => typeof key !== 'string' || !key.length || key.length > 4096))) throw new Error('主键设置无效。');
  for (const key of ['headerRow', 'dataStartRow', 'descriptionRow']) {
    if (next[key] !== undefined && (!Number.isSafeInteger(next[key]) || next[key] < (key === 'descriptionRow' ? 0 : 1) || next[key] > 1000000)) throw new Error('表头记录编号无效。');
  }
  return next;
}

function decode(value) {
  if (typeof value !== 'string' || value.length > Math.ceil(MAX_BYTES / 3) * 4) throw new Error('单侧文件超过 8 MiB。');
  const binary = atob(value);
  if (binary.length > MAX_BYTES) throw new Error('单侧文件超过 8 MiB。');
  return Uint8Array.from(binary, character => character.charCodeAt(0));
}

async function workbookReader(bytes) {
  try { return await readWorkbookData(Workbook, bytes); }
  catch (error) { throw new Error(`无法读取 XLSX：${error.message}`); }
}

function payload() {
  const state = comparison.snapshot();
  title = sources[1].split(/[\\/]/).at(-1);
  return { type: 'comparison', ...state, busy: false, readonlySnapshot: true, sources, title,
    settings: { ...settings, options: state.options, sheetName: state.sheetName, sheetOptions: [...sheetOptions] } };
}

async function handle(message) {
  if (message.action === 'load') {
    const snapshot = message.snapshot;
    if (!snapshot || !Array.isArray(snapshot.sources) || snapshot.sources.length !== 2 ||
        snapshot.sources.some(source => typeof source !== 'string') || typeof snapshot.xlsx !== 'boolean') throw new Error('文件快照无效。');
    sources = [...snapshot.sources]; title = snapshot.title;
    settings = { swapped: message.settings?.swapped === true };
    let initial = {};
    sheetOptions.clear();
    try {
      initial = options(message.settings?.options || {});
      for (const [name, value] of message.settings?.sheetOptions || []) {
        if (typeof name !== 'string') throw new Error('工作表设置无效。');
        sheetOptions.set(name, options(value));
      }
    } catch { initial = {}; sheetOptions.clear(); }
    comparison = createComparison({ xlsx: snapshot.xlsx, options: snapshot.xlsx ? {} : initial, workbookReader });
    if (snapshot.error) comparison.fail(new Error(snapshot.error));
    else {
      if (!Array.isArray(snapshot.inputs) || snapshot.inputs.length !== 2 || snapshot.inputs.some(input => typeof input !== 'string')) throw new Error('文件快照内容无效。');
      const inputs = snapshot.xlsx ? snapshot.inputs.map(decode) : [...snapshot.inputs];
      if (settings.swapped) { inputs.reverse(); sources.reverse(); }
      await comparison.load(inputs);
      if (snapshot.xlsx) {
        const originalSheet = comparison.snapshot().sheetName;
        for (const [name, value] of sheetOptions) {
          if (comparison.snapshot().sheets.some(sheet => sheet.name === name)) {
            comparison.selectSheet(name); comparison.update(value);
          }
        }
        comparison.selectSheet(message.settings?.sheetName || originalSheet);
      }
    }
  } else {
    if (!comparison) throw new Error('请先读取比较快照。');
    if (message.action === 'options') {
      comparison.update(options(message.options));
      const state = comparison.snapshot();
      if (state.xlsx && state.sheetName) sheetOptions.set(state.sheetName, state.options);
    } else if (message.action === 'sheet') {
      if (typeof message.name !== 'string' || !comparison.snapshot().sheets.some(sheet => sheet.name === message.name)) throw new Error('工作表不存在。');
      comparison.selectSheet(message.name);
    } else if (message.action === 'swap') {
      comparison.swap(); sources.reverse(); settings.swapped = !settings.swapped;
    } else if (message.action === 'refresh') comparison.update({});
    else throw new Error('未知比较操作。');
  }
  return payload();
}

// Serialize parsing and settings changes so a slower workbook load cannot win a race.
let queue = Promise.resolve();
self.onmessage = event => {
  const message = event.data;
  if (!message || typeof message !== 'object') return;
  queue = queue.then(async () => {
    try { self.postMessage({ id: message.id, data: await handle(message) }); }
    catch (error) { self.postMessage({ id: message.id, error: error.message || String(error) }); }
  });
};
