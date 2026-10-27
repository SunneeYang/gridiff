'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const { parseArgs } = require('node:util');
const { createHash } = require('node:crypto');
const { chromium } = require('playwright');
const { workbook } = require('../test/xlsx-fixtures');
const { startComparisonServer, submitComparison } = require('../test/browser-server.cjs');

const quote = value => /[",\r\n]/.test(String(value)) ? '"' + String(value).replaceAll('"', '""') + '"' : String(value);
const csv = rows => rows.map(row => row.map(quote).join(',')).join('\n');
function table(rows, columns, mode = 'sparse') {
  const header = Array.from({ length: columns }, (_, i) => i ? `field${i}` : 'id');
  const before = Array.from({ length: rows }, (_, r) => header.map((_, c) => c ? `v${r % 100}_${c}` : String(r + 1)));
  if (mode === 'longtext') for (const row of before) row[1] = '中文多行文本,"引用"\n' + '内容'.repeat(256);
  if (mode === 'mova') for (let r = 0; r < rows; r += 97) before[r] = header.map((_, c) => c ? 'note' : '');
  let after = before.map(row => [...row]);
  let modified = 0, added = 0, removed = 0, moved = 0;
  if (mode === 'add-remove') {
    added = removed = rows / 10;
    after = [...after.slice(removed), ...before.slice(0, added).map((row, i) => [String(rows + i + 1), ...row.slice(1)])];
  } else if (mode === 'reorder') { after.reverse(); moved = rows; }
  else if (mode !== 'unchanged') for (let r = 0; r < rows; r++) {
    if (after[r][0] && (mode === 'dense' || r % 100 === 0)) {
      modified++;
      for (let c = 1; c < columns; c++) if (mode === 'dense' || c === 1) after[r][c] += '_changed';
    }
  }
  const headers = mode === 'mova' ? [header.map(() => 'all'), header.map(() => 'string'), header, header.map((_, i) => `说明${i}`)] : [header];
  return { inputs: [csv([...headers, ...before]), csv([...headers, ...after])], extension: 'csv',
    expected: { rows: rows + added, columns, counts: { modified, added, removed, moved } } };
}
async function spreadsheet(sheetCount, rows, columns, sparse = false) {
  const sheets = {};
  for (let s = 0; s < sheetCount; s++) {
    sheets[`Sheet${s}`] = [Array.from({ length: columns }, (_, c) => c ? `field${c}` : 'id')];
    for (let r = 0; r < rows; r++) sheets[`Sheet${s}`].push(Array.from({ length: columns }, (_, c) => {
      if (!c) return String(r + 1);
      if (sparse) return c === 1 || c === columns - 1 ? r : null;
      if (c % 5 === 0) return { formula: `${r + 1}+${c}`, result: r + 1 + c };
      if (c % 5 === 1 && c > 1) return new Date(Date.UTC(2025, 0, 1 + r % 28));
      return c % 5 === 2 ? `text${r % 100}` : r + c;
    }));
  }
  const before = await workbook(sheets);
  for (const values of Object.values(sheets)) for (let r = 0; r < rows; r += 100) values[r + 1][1] = 'changed';
  return { inputs: [before, await workbook(sheets)], extension: 'xlsx',
    expected: { rows, columns, sheets: 1, counts: { modified: Math.ceil(rows / 100), added: 0, removed: 0, moved: 0 } } };
}
const cases = [
  ['csv-small', () => table(1000, 12)],
  ['csv-tall', () => table(50000, 8)],
  ['csv-wide', () => table(1000, 400)],
  ['csv-dense', () => table(10000, 30, 'dense')],
  ['csv-unchanged', () => table(10000, 30, 'unchanged')],
  ['csv-longtext', () => table(2000, 6, 'longtext')],
  ['csv-add-remove', () => table(20000, 12, 'add-remove')],
  ['csv-reorder', () => table(20000, 12, 'reorder')],
  ['mova-four-row', () => table(10000, 24, 'mova')],
  ['mova-vertical', () => {
    const rows = Array.from({ length: 10000 }, (_, r) => ['all', 'int32', `Name${r}`, `说明${r}`, r]);
    return { inputs: [csv(rows), csv(rows.map((row, r) => r % 100 ? row : [...row.slice(0, 4), r + 1]))], extension: 'csv',
      expected: { rows: 10000, columns: 5, counts: { modified: 100, added: 0, removed: 0, moved: 0 } } };
  }],
  ['xlsx-typed', () => spreadsheet(1, 5000, 20)],
  ['xlsx-multi-sheet', () => spreadsheet(8, 1000, 20)],
  ['xlsx-sparse', () => spreadsheet(1, 5000, 40, true)]
];

async function main() {
  assert.ok(process.env.CODEX_AGENT_TMP, 'Run benchmark through agent-tmp-run.');
  const { values } = parseArgs({ options: { repeats: { type: 'string', default: '3' }, case: { type: 'string' }, binary: { type: 'string' }, reuse: { type: 'boolean' }, cycles: { type: 'string', default: '1' } } });
  const repeats = Number(values.repeats), cycles = Number(values.cycles);
  assert.ok(Number.isInteger(cycles) && cycles >= 1 && cycles <= 20);
  assert.ok(Number.isInteger(repeats) && repeats >= 1 && repeats <= 10, 'repeats must be 1–10');
  const selected = values.case ? cases.filter(([name]) => name === values.case) : cases;
  assert.ok(selected.length, 'Unknown benchmark case');
  const root = path.resolve(__dirname, '..');
  const binary = values.binary ? path.resolve(values.binary) : path.join(root, 'dist', 'cli', `gridiff-${process.platform === 'win32' ? 'windows' : process.platform}-${process.arch}`, process.platform === 'win32' ? 'gridiff.exe' : 'gridiff');
  const build = JSON.parse(await fs.readFile(binary + '.json', 'utf8'));
  assert.equal(createHash('sha256').update(await fs.readFile(binary)).digest('hex'), build.sha256, 'Binary differs from its build receipt');
  const browserStart = performance.now();
  const browser = await chromium.launch({ headless: true, channel: process.env.PLAYWRIGHT_CHANNEL || 'chrome' });
  const browserLaunchMs = performance.now() - browserStart;
  const report = { schema: 2, reuse: !!values.reuse, cycles, browserLaunchMs, createdAt: new Date().toISOString(), sourceCommit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
    sourceDirty: !!execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).trim(),
    build, environment: { platform: process.platform, arch: process.arch, cpu: os.cpus()[0].model, chrome: browser.version(), node: process.version },
    notes: 'Synthetic fixtures; fresh browser context each run; warm OS file cache; timings overlap and must not be added. frame is a double-rAF proxy, not a pixel-paint timestamp. Chrome performance.memory is a nonstandard heap estimate, not process RSS or peak memory; heaps may be shared or omitted. Profile logging is enabled.', repeats, cases: [] };
  const output = path.join(root, 'dist', 'perf', `baseline-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  await fs.mkdir(path.dirname(output), { recursive: true });
  const collect = page => page.evaluate(() => ({ events: [...window.gridiffPerf.events], dropped: window.gridiffPerf.dropped,
    result: window.gridiffPerf.result, domNodes: document.querySelectorAll('*').length,
    reportedHeapBytes: performance.memory?.usedJSHeapSize ?? null }));
  const settled = (page, generation = null) => page.waitForFunction(generation => window.gridiffPerf?.events.some(event => event.phase === 'render.frame' && !event.busy && (generation === null || event.generation === generation)), generation, { timeout: 60000 });
  async function retainedMainHeap(page) {
    const session = await page.context().newCDPSession(page);
    try {
      await session.send('HeapProfiler.collectGarbage');
      const heap = await session.send('Runtime.getHeapUsage'), dom = await session.send('Memory.getDOMCounters');
      return { afterGcMainHeapBytes: heap.usedSize, dom };
    } finally { await session.detach(); }
  }
  function validate(result, expected, name) {
    assert.equal(result.ok, true, name); assert.equal(result.sheetErrors, 0, name);
    assert.equal(result.rows, expected.rows, name); assert.equal(result.columns, expected.columns, name);
    for (const [key, value] of Object.entries(expected.counts)) assert.equal(result.counts[key], value, `${name} ${key}`);
    if (expected.sheets) assert.equal(result.sheets, expected.sheets);
    if (result.transmittedRows !== undefined) assert.ok(result.transmittedRows <= 100, name + " bounded row payload");
  }
  async function action(page, operation, recompute = false) {
    const previous = await page.evaluate(() => window.gridiffPerf.result.request);
    await page.evaluate(() => { window.gridiffPerf.events.length = 0; });
    const start = performance.now(); await operation(); await settled(page);
    const measured = { wallMs: performance.now() - start, ...await collect(page) };
    assert.equal(await page.locator('#error').isVisible(), false);
    if (recompute) assert.ok(measured.result.request > previous, 'Operation must produce a fresh worker result');
    return measured;
  }
  try {
    for (const [name, generate] of selected) {
      const fixture = await generate();
      const files = fixture.inputs.map((_, i) => path.join(process.env.CODEX_AGENT_TMP, `${name}-${i}.${fixture.extension}`));
      await Promise.all(files.map((file, i) => fs.writeFile(file, fixture.inputs[i])));
      const sizes = fixture.inputs.map(input => Buffer.byteLength(input));
      assert.ok(sizes.every(size => size <= 8 * 1024 * 1024), name + ' byte limit');
      const entry = { name, bytes: sizes, expected: fixture.expected, runs: [] }; report.cases.push(entry);
      for (let repeat = 0; repeat < repeats; repeat++) {
        const start = performance.now();
        const runtimeDirectory = path.join(process.env.CODEX_AGENT_TMP, `instance-${name}-${repeat}`);
        const server = values.reuse ? await (async () => {
          const url = await submitComparison({ files, binary, runtimeDirectory });
          return { url, close: () => fetch(url + 'close', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }).catch(() => {}) };
        })() : await startComparisonServer({ files, binary });
        const launchMs = performance.now() - start;
        const preparePageStart = performance.now();
        const context = await browser.newContext({ viewport: { width: 1360, height: 1000 } });
        const page = await context.newPage(); const pagePreparationMs = performance.now() - preparePageStart; const errors = [];
        page.on('pageerror', error => errors.push(error.message));
        // Keep theme preference reads deterministic without changing the user's saved preference.
        await page.route('**/preferences', route => route.fulfill({ contentType: 'application/json', body: '{"mode":"system","palette":"default"}' }));
        try {
          const navigation = performance.now(); const response = await page.goto(server.url + '#profile=1');
          assert.equal(response.status(), 200); await settled(page);
          const load = { wallMs: performance.now() - navigation, ...await collect(page) };
          validate(load.result, fixture.expected, name);
          assert.ok(load.events.some(event => event.phase === 'server.snapshot'));
          assert.ok(load.events.some(event => event.phase === 'table.compare'));
          const operations = {}, warmReplacements = [];
          const firstChangedValues = () => page.locator('tbody td.changed').first().evaluate(cell =>
            ['before', 'after'].map(side => cell.querySelector('.value-line.' + side + ' > :last-child').textContent));
          const originalValues = fixture.expected.counts.modified ? await firstChangedValues() : null;
          if (values.reuse) {
            await page.evaluate(() => { window.benchmarkDocument = 'same-document'; });
            for (let cycle = 0; cycle < cycles; cycle++) {
              const newFiles = fixture.inputs.map((_, i) => path.join(process.env.CODEX_AGENT_TMP, `${name}-warm-${repeat}-${cycle}-${i}.${fixture.extension}`));
              await Promise.all(newFiles.map((file, i) => fs.writeFile(file, fixture.inputs[cycle % 2 ? i : 1 - i])));
              const previous = await page.evaluate(() => { const result = window.gridiffPerf.result; window.gridiffPerf.events.length = 0; return result; });
              const replaceStart = performance.now();
              const url = await submitComparison({ files: newFiles, binary, runtimeDirectory });
              const acknowledgedMs = performance.now() - replaceStart;
              await Promise.all(newFiles.map(file => fs.unlink(file)));
              await settled(page, previous.generation + 1);
              const measured = { wallMs: performance.now() - replaceStart, acknowledgedMs, ...await collect(page) };
              assert.equal(url, server.url); assert.equal(page.url(), server.url + '#profile=1');
              assert.equal(await page.evaluate(() => window.benchmarkDocument), 'same-document');
              assert.equal(measured.result.workers, 1); validate(measured.result, fixture.expected, name);
              if (originalValues) assert.deepEqual(await firstChangedValues(), cycle % 2 ? originalValues : [...originalValues].reverse(), name + ' replacement values');
              assert.ok((await page.locator('#title').innerText()).includes(`warm-${repeat}-${cycle}`));
              if (cycles > 1) measured.retained = await retainedMainHeap(page);
              warmReplacements.push(measured);
            }
          }
          if (fixture.expected.sheets > 1) {
            operations.sheet = await action(page, () => page.locator('#sheet').selectOption('Sheet1'), true);
            assert.equal(await page.locator('#sheet').inputValue(), 'Sheet1');
          }
          operations.refresh = await action(page, () => page.getByRole('button', { name: '重新计算', exact: true }).click(), true);
          if (name === 'csv-wide') {
            operations.allFields = await action(page, () => page.locator('#only-fields').uncheck());
            const frame = operations.allFields.events.filter(event => event.phase === 'render.frame').at(-1);
            assert.equal(frame.columns, 400); assert.equal(frame.visibleRows, 7);
          }
          if (await page.locator('#next').isEnabled()) {
            const before = await page.locator('#page').innerText();
            operations.page = await action(page, () => page.locator('#next').click());
            assert.notEqual(await page.locator('#page').innerText(), before);
          }
          operations.search = await action(page, () => page.locator('#search').fill('NO_MATCH_BENCHMARK'));
          assert.equal(operations.search.events.filter(event => event.phase === 'render.frame').at(-1).visibleRows, 0);
          for (const measured of Object.values(operations)) validate(measured.result, fixture.expected, name);
          assert.deepEqual(errors, []);
          await action(page, () => page.locator('#search').fill(''));
          const retained = await retainedMainHeap(page);
          entry.runs.push({ launchMs, pagePreparationMs, load, warmReplacements, operations, retained });
          console.log(`${name} ${repeat + 1}/${repeats}: launch ${launchMs.toFixed(0)} ms, load ${load.wallMs.toFixed(0)} ms, refresh ${operations.refresh.wallMs.toFixed(0)} ms${warmReplacements.length ? `, warm ${warmReplacements.at(-1).wallMs.toFixed(0)} ms` : ''}`);
          await fs.writeFile(output, JSON.stringify(report, null, 2) + '\n');
        } finally { await context.close(); await server.close(); }
      }
      await Promise.all(files.map(file => fs.unlink(file)));
    }
    console.log(`Saved ${output}`);
  } finally { await browser.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
