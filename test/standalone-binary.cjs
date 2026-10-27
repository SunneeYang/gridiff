'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { chromium } = require('playwright');
const { workbook } = require('./xlsx-fixtures');

async function main() {
  assert.ok(process.env.CODEX_AGENT_TMP, 'Run with agent-tmp-run so the copied executable and fixtures are removed.');
  const temporary = process.env.CODEX_AGENT_TMP;
  const filename = process.platform === 'win32' ? 'gridiff.exe' : 'gridiff';
  const platform = process.platform === 'win32' ? 'windows' : process.platform;
  const source = process.argv[2] || path.join(__dirname, '..', 'dist', 'cli', `gridiff-${platform}-${process.arch}`, filename);
  const binary = path.join(temporary, filename);
  fs.copyFileSync(source, binary); fs.chmodSync(binary, 0o755);
  const environment = { ...process.env, GRIDIFF_RUNTIME_DIR: path.join(temporary, 'instances'), PATH: process.platform === 'win32' ? process.env.SystemRoot : '/usr/bin:/bin' };
  const launch = files => {
    const result = spawnSync(binary, ['--no-open', '--', ...files], { cwd: temporary, env: environment, encoding: 'utf8', timeout: 15000 });
    assert.equal(result.status, 0, result.error?.message || result.stderr);
    assert.match(result.stdout.trim(), /^http:\/\/127\.0\.0\.1:\d+\/s\/[a-f0-9]+\/$/);
    return result.stdout.trim();
  };
  const browser = await chromium.launch({ headless: true, channel: process.env.PLAYWRIGHT_CHANNEL || 'chrome' });
  const page = await browser.newPage();
  await page.route('**/preferences', route => route.fulfill({ contentType: 'application/json', body: JSON.stringify({ mode: 'system', palette: 'default' }) }));
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  async function inspect(files, xlsx) {
    const url = launch(files);
    let closed = false;
    try {
      files.forEach(file => fs.rmSync(file));
      const payload = await (await fetch(url + 'snapshot')).json();
      assert.equal(payload.error || '', '');
      assert.equal(payload.xlsx, xlsx);
      assert.equal(Object.hasOwn(payload, 'inputs'), false, 'source data must stay in Go');
      const worker = await fetch(url + 'worker.js');
      assert.equal(worker.status, 404, 'native executable no longer ships a browser parser');
      const script = await fetch(url + 'browser.js');
      assert.equal(script.status, 200); assert.equal(script.headers.get('content-encoding'), 'gzip');
      await page.goto(url + '#profile=1');
      await page.locator('tr.modified').waitFor();
      assert.equal(await page.evaluate(() => window.gridiffPerf.result.workers), 0);
      assert.equal(await page.evaluate(() => window.gridiffPerf.result.native), true);
      if (xlsx) {
        assert.deepEqual(await page.locator('#sheet option').evaluateAll(options => options.map(option => option.value)), ['Data']);
        assert.equal(await page.locator('td.changed .before > :last-child').innerText(), '4');
        assert.equal(await page.locator('td.changed .after > :last-child').innerText(), '6');
        assert.doesNotMatch(await page.locator('#content').innerText(), /2\+2|3\+3/);
      } else assert.match(await page.locator('tr.modified').innerText(), /new/);
      await page.emulateMedia({ colorScheme: 'dark' });
      await page.waitForFunction(() => document.documentElement.dataset.appearance === 'dark');
      await page.getByRole('button', { name: '结束比较', exact: true }).click();
      await page.waitForFunction(() => document.querySelector('#title').textContent === '比较已结束');
      closed = true;
      await assert.rejects(() => fetch(url + 'snapshot'));
    } finally {
      if (!closed) await fetch(url + 'close', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }).catch(() => {});
    }
  }
  try {
    for (const args of [['one.csv'], ['one.csv', 'two.csv', 'extra.csv'], ['diff', 'one.csv'], ['--unknown', 'one.csv', 'two.csv']]) {
      const result = spawnSync(binary, args, { cwd: temporary, env: environment, encoding: 'utf8', timeout: 15000 });
      assert.equal(result.status, 1, JSON.stringify(args));
      assert.match(result.stderr, /两个文件|未知选项/);
    }
    let files = ['旧 表.csv', 'new $value & name.csv'].map(file => path.join(temporary, file));
    fs.writeFileSync(files[0], 'id,value\n1,old\n'); fs.writeFileSync(files[1], 'id,value\n1,new\n');
    await inspect(files, false);
    files = ['old sheet.xlsx', 'new sheet.xlsx'].map(file => path.join(temporary, file));
    fs.writeFileSync(files[0], await workbook({ Data: [['id', 'value'], ['001', { formula: '2+2', result: 4 }]], Other: [['id', 'v'], ['2', 'x']] }));
    fs.writeFileSync(files[1], await workbook({ Data: [['id', 'value'], ['001', { formula: '3+3', result: 6 }]], Other: [['id', 'v'], ['2', 'x']] }));
    await inspect(files, true);
    const license = spawnSync(binary, ['--licenses'], { cwd: temporary, env: environment, encoding: 'utf8' });
    assert.equal(license.status, 0, license.stderr);
    assert.ok(license.stdout.includes('Go standard library'));
    assert.ok(!license.stdout.includes('exceljs@4.4.0'));
    assert.ok(!license.stdout.includes('Bun runtime'));
    assert.deepEqual(errors, []);
    console.log('Standalone binary passed: no external runtime or browser parser, gzip assets/licenses, CSV/XLSX native computation after deleting inputs, formulas, system theme and shutdown.');
  } finally { await browser.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
