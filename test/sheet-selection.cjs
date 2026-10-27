'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { chromium } = require('playwright');
const { workbook, rewriteZip } = require('./xlsx-fixtures');
const { readWorkbook } = require('../src/xlsx');
const { startComparisonServer, submitComparison } = require('./browser-server.cjs');

(async () => {
  assert.ok(process.env.CODEX_AGENT_TMP, 'Run through agent-tmp-run');
  const temp = process.env.CODEX_AGENT_TMP, urls = new Set();
  const binary = path.resolve('dist/cli/gridiff-darwin-arm64/gridiff');
  const files = [path.join(temp, 'old.xlsx'), path.join(temp, 'new.xlsx')];
  const old = await workbook({ First: [['id', 'v'], ['1', 'old']], '中文, table': [['id', 'v'], ['2', 'before']], Gone: [['id'], ['3']] });
  const next = await workbook({ Renamed: [['id', 'v'], ['1', 'new']], '中文, table': [['id', 'v'], ['2', 'after']], Added: [['id'], ['4']] });
  await Promise.all(files.map((file, i) => fs.writeFile(file, [old, next][i])));
  const runtimeDirectory = path.join(temp, 'instance');
  const close = url => fetch(url + 'close', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }).catch(() => {});
  const browser = await chromium.launch({ headless: true, channel: process.env.PLAYWRIGHT_CHANNEL || 'chrome' });
  const page = await browser.newPage();
  try {
    let url;
    const submit = async args => {
      const current = await submitComparison({ files, binary, runtimeDirectory, args });
      urls.add(current);
      if (url) assert.equal(current, url, 'loading range must not create another server');
      else { url = current; await page.goto(url + '#profile=1'); await page.evaluate(() => { window.selectionMarker = 42; }); }
      const snapshot = await (await fetch(url + 'snapshot')).json();
      await page.waitForFunction(generation => window.gridiffPerf?.result?.generation === generation, snapshot.generation);
      assert.equal(await page.evaluate(() => window.selectionMarker), 42, 'reuse keeps the document');
      return snapshot;
    };
    const names = () => page.locator('#sheet option').evaluateAll(options => options.map(option => option.value));
    let snapshot = await submit([]);
    assert.equal(snapshot.sheetSelection.mode, 'first');
    assert.deepEqual(await names(), ['Renamed']);
    await page.locator('tbody tr.modified').waitFor();
    assert.match(await page.locator('#notice').innerText(), /首个工作表/);
    snapshot = await submit(['--sheets', 'all']);
    assert.equal(snapshot.sheetSelection.mode, 'all');
    assert.deepEqual(await names(), ['Renamed', '中文, table', 'Added', 'First', 'Gone']);
    await page.locator('#sheet').selectOption('中文, table');
    await page.waitForFunction(() => document.querySelector('#content').textContent.includes('after'));
    assert.match(await page.locator('#notice').innerText(), /全部工作表/);
    snapshot = await submit(['--sheet', '中文, table', '--sheet', 'Added']);
    assert.deepEqual(snapshot.sheetSelection, { mode: 'named', names: ['中文, table', 'Added'] });
    assert.deepEqual(await names(), ['中文, table', 'Added']);
    assert.deepEqual((await readWorkbook(Buffer.from(snapshot.inputs[0], 'base64'))).map(sheet => sheet.name), ['中文, table']);
    await page.locator('#sheet').selectOption('Added');
    await page.locator('tbody tr.added').waitFor();
    await page.getByRole('button', { name: '交换左右', exact: true }).click();
    await page.locator('tbody tr.removed').waitFor();
    await page.reload();
    await page.locator('tbody tr.removed').waitFor();
    await page.evaluate(() => { window.selectionMarker = 42; });
    await submit(['--sheet', '中文, table', '--sheet', 'typo']);
    assert.match(await page.locator('#error').innerText(), /两侧均找不到.*typo/);
    await submit([]); assert.deepEqual(await names(), ['Renamed']);
    assert.equal(await page.locator('#error').isVisible(), false);
    const namedStartup = await submitComparison({ files, binary, runtimeDirectory: path.join(temp, 'named-startup'), args: ['--sheet', '中文, table'] });
    urls.add(namedStartup);
    const named = await (await fetch(namedStartup + 'snapshot')).json();
    assert.deepEqual(named.sheetSelection, { mode: 'named', names: ['中文, table'] });
    assert.deepEqual((await readWorkbook(Buffer.from(named.inputs[1], 'base64'))).map(sheet => sheet.name), ['中文, table']);
    const waitServer = await startComparisonServer({ files, binary, args: ['--sheets', 'all'] });
    try { const data = await (await fetch(waitServer.url + 'snapshot')).json(); assert.equal(data.sheetSelection.mode, 'all'); assert.equal((await readWorkbook(Buffer.from(data.inputs[1], 'base64'))).length, 3); }
    finally { await waitServer.close(); }
    for (const args of [['--sheets'], ['--sheet'], ['--sheets', 'wrong'], ['--sheets', 'all', '--sheet', 'A'], ['--sheet', '', ...files]]) {
      const result = spawnSync(binary, args, { encoding: 'utf8', env: { ...process.env, GRIDIFF_RUNTIME_DIR: runtimeDirectory } });
      assert.equal(result.status, 1); assert.match(result.stderr, /缺少值|first 或 all|不能与|不能为空/);
    }
    const broken = await rewriteZip(next, zip => zip.file('xl/worksheets/sheet1.xml', '<broken>'));
    await fs.writeFile(files[1], broken);
    const skip = await submitComparison({ files, binary, runtimeDirectory, args: ['--sheet', '中文, table'] });
    assert.equal((await (await fetch(skip + 'snapshot')).json()).error, undefined);
    const check = await submitComparison({ files, binary, runtimeDirectory, args: ['--sheets', 'all'] });
    const failed = await (await fetch(check + 'snapshot')).json();
    assert.match(failed.error, /XLSX/);
    await page.waitForFunction(generation => window.gridiffPerf?.result?.generation === generation, failed.generation);
    assert.match(await page.locator('#notice').innerText(), /全部工作表/);
    console.log('Sheet selection passed: defaults, all/named CLI startup and reuse, first/name pairing, hidden payload exclusion, swap/reload, misses, malformed arguments and selected XML validation.');
  } finally { for (const url of urls) await close(url); await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
