'use strict';
const { createComparison, MAX_BYTES } = require('../src/comparison');
const { readWorkbookData } = require('../src/xlsx-core');
const { selectView } = require('./view');

let comparison, sources, title, settings, unsupported;
let view, generation = 0;
let metrics, droppedMetrics = 0;
const record = metric => { if (metrics) { if (metrics.length < 500) metrics.push(metric); else droppedMetrics++; } };
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
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function workbookReader(bytes) {
  try {
    const { Workbook } = require('exceljs/dist/exceljs.min.js');
    return await readWorkbookData(Workbook, bytes, metrics ? record : undefined);
  }
  catch (error) { throw new Error(`无法读取 XLSX：${error.message}`); }
}

async function workbookPairReader(inputs) {
  if (inputs.some(input => !input.byteLength)) {
    const books = [];
    for (const input of inputs) books.push(input.byteLength ? await workbookReader(input) : []);
    return books;
  }
  const started = performance.now();
  const helper = new Worker(self.location.href, { type: 'module' });
  try {
    const remote = new Promise((resolve, reject) => {
      helper.onmessage = ({ data }) => {
        helper.terminate();
        if (data.error) { reject(new Error(data.error)); return; }
        for (const metric of data.metrics || []) if (metric.phase !== 'worker.compute') record({ ...metric, side: 1 });
        if (metrics && data.sentAt) record({ phase: 'xlsx.transfer', ms: performance.timeOrigin + performance.now() - data.sentAt });
        resolve(data.data.workbook);
      };
      helper.onerror = event => { event.preventDefault(); reject(new Error('无法读取 XLSX：辅助解析程序无法运行。')); };
      helper.onmessageerror = () => reject(new Error('无法读取 XLSX：辅助解析结果无法接收。'));
      helper.postMessage({ id: 1, action: 'parse-workbook', input: inputs[1].buffer, profile: !!metrics }, [inputs[1].buffer]);
    });
    // Settle the local parser too, so a failed helper cannot overlap the next queued comparison.
    const results = await Promise.allSettled([workbookReader(inputs[0]), remote]);
    for (const result of results) if (result.status === 'rejected') throw result.reason;
    return results.map(result => result.value);
  } finally {
    helper.terminate();
    if (metrics) record({ phase: 'xlsx.parallel', ms: performance.now() - started, workers: 2 });
  }
}

function viewOptions(value = {}) {
  if (!value || typeof value !== 'object' || (value.query !== undefined && typeof value.query !== 'string') ||
      (value.page !== undefined && (!Number.isSafeInteger(value.page) || value.page < 0))) throw new Error('视图设置无效。');
  return { view: value.view === 'list' ? 'list' : 'grid', onlyChanges: value.onlyChanges !== false,
    onlyFields: value.onlyFields !== false, query: value.query || '', page: value.page || 0 };
}

function payload(presentation) {
  const state = comparison.snapshot();
  if (state.xlsx && state.sheetName) sheetOptions.set(state.sheetName, state.options);
  let pageInfo;
  if (state.result) {
    const start = metrics ? performance.now() : 0;
    const selected = selectView(state.result, view);
    pageInfo = selected.pageInfo; view.page = pageInfo.page;
    state.result = { ...state.result, rows: selected.rows };
    if (metrics) record({ phase: 'view.select', ms: performance.now() - start, rows: pageInfo.totalRows, transmittedRows: selected.rows.length });
  }
  title = sources[1].split(/[\\/]/).at(-1);
  return { type: 'comparison', ...state, busy: false, readonlySnapshot: true, sources, title, unsupported,
    generation, presentation, viewState: { ...view }, pageInfo,
    settings: { ...settings, options: state.options, sheetName: state.sheetName, sheetOptions: [...sheetOptions] } };
}

async function handle(message) {
  if (message.action === 'parse-workbook') {
    if (!(message.input instanceof ArrayBuffer) || !message.input.byteLength || message.input.byteLength > MAX_BYTES) throw new Error('XLSX 解析输入无效。');
    return { workbook: await workbookReader(new Uint8Array(message.input)) };
  }
  if (message.action === 'load') {
    const snapshot = message.snapshot;
    if (!snapshot || !Array.isArray(snapshot.sources) || snapshot.sources.length !== 2 ||
        snapshot.sources.some(source => typeof source !== 'string') || typeof snapshot.xlsx !== 'boolean') throw new Error('文件快照无效。');
    sources = [...snapshot.sources]; title = snapshot.title;
    generation = snapshot.generation || 0;
    view = viewOptions(message.view);
    unsupported = snapshot.unsupported === true;
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
    comparison = createComparison({ xlsx: snapshot.xlsx, options: snapshot.xlsx ? {} : initial,
      sheetSelection: snapshot.sheetSelection || { mode: 'first' }, workbookPairReader, onMetric: metrics ? record : undefined });
    if (snapshot.error) comparison.fail(new Error(snapshot.error));
    else {
      if (!Array.isArray(snapshot.inputs) || snapshot.inputs.length !== 2 || snapshot.inputs.some(input => typeof input !== 'string')) throw new Error('文件快照内容无效。');
      const start = metrics ? performance.now() : 0;
      const inputs = snapshot.xlsx ? snapshot.inputs.map(decode) : [...snapshot.inputs];
      if (metrics) record({ phase: 'input.decode', ms: performance.now() - start });
      if (settings.swapped) { inputs.reverse(); sources.reverse(); }
      await comparison.load(inputs, snapshot.sheetSelection || { mode: 'first' });
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
    if (message.view) view = viewOptions(message.view);
    if (message.action === 'view') view = viewOptions(message.view);
    else if (message.action === 'options') {
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
    if (message.action !== 'view') view.page = 0;
  }
  return payload(message.id);
}

// Serialize parsing and settings changes so a slower workbook load cannot win a race.
let queue = Promise.resolve();
self.onmessage = event => {
  const message = event.data;
  if (!message || typeof message !== 'object') return;
  queue = queue.then(async () => {
    metrics = message.profile === true ? [] : null; droppedMetrics = 0;
    const start = metrics ? performance.now() : 0;
    try {
      const data = await handle(message);
      if (metrics) record({ phase: 'worker.compute', ms: performance.now() - start, dropped: droppedMetrics });
      self.postMessage({ id: message.id, data, ...(metrics ? { metrics, sentAt: performance.timeOrigin + performance.now() } : {}) });
    } catch (error) { self.postMessage({ id: message.id, error: error.message || String(error) }); }
  });
};
