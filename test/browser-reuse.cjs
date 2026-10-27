'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { chromium } = require('playwright');
const { submitComparison } = require('./browser-server.cjs');
const { workbook } = require('./xlsx-fixtures');

(async () => {
  assert.ok(process.env.CODEX_AGENT_TMP, 'Run with agent-tmp-run');
  const temp = process.env.CODEX_AGENT_TMP;
  const binary = path.resolve('dist/cli', `gridiff-${process.platform === 'win32' ? 'windows' : process.platform}-${process.arch}`, process.platform === 'win32' ? 'gridiff.exe' : 'gridiff');
  const runtimeDirectory = path.join(temp, 'instances');
  const urls = new Set();
  let serial = 0;
  const files = async (values, ext = 'csv') => {
    const pair = values.map((_, i) => path.join(temp, `${++serial}-${i}.${ext}`));
    await Promise.all(pair.map((file, i) => fs.writeFile(file, values[i])));
    return pair;
  };
  const submit = async pair => {
    const url = await submitComparison({ files: pair, binary, runtimeDirectory }); urls.add(url); return url;
  };
  const close = async url => { await fetch(url + 'close', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }).catch(() => {}); };
  const browser = await chromium.launch({ headless: true, channel: process.env.PLAYWRIGHT_CHANNEL || 'chrome' });
  try {
    const context = await browser.newContext();
    const page = await context.newPage(), errors = [];
    page.on('pageerror', error => errors.push(error.message));
    const before = 'id,name,value,rare\n' + Array.from({ length: 205 }, (_, i) => `${i},name${i},old,${i === 204 ? 'old' : ''}`).join('\n');
    const after = before.replaceAll(',old,', ',new,').replace('204,name204,new,old', '204,name204,new,last');
    const pair = await files([before, after]);
    const simultaneous = await Promise.all([submit(pair), submit(pair)]);
    assert.equal(simultaneous[0], simultaneous[1], 'concurrent launches must share one server');
    const url = simultaneous[0];
    await page.goto(url + '#profile=1');
    await page.waitForFunction(() => window.gridiffPerf?.result?.ok && document.querySelectorAll('tbody tr').length === 100);
    const initial = await page.evaluate(() => { window.reuseMarker = 'retained-document'; return window.gridiffPerf.result; });
    assert.equal(initial.rows, 205); assert.equal(initial.transmittedRows, 100);
    assert.ok((await page.locator('thead').innerText()).includes('rare'), 'columns include changes beyond this page');
    await page.locator('#search').fill('name204');
    await page.waitForFunction(() => document.querySelectorAll('tbody tr').length === 1 && document.querySelector('tbody').textContent.includes('name204'));
    await page.evaluate(() => {
      const search = document.querySelector('#search');
      search.value = 'name202'; search.dispatchEvent(new Event('input', { bubbles: true }));
      document.querySelector('#only-fields').click();
      search.value = 'name203'; search.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await page.waitForFunction(() => document.querySelector('#search').value === 'name203' && document.querySelectorAll('tbody tr').length === 1 && document.querySelector('tbody').textContent.includes('name203'));
    assert.equal(await page.locator('#error').isVisible(), false);
    const latest = await files(['id,value\n900,previous', 'id,value\n900,replacement']);
    await page.locator('#search').fill('old-query-pending');
    assert.equal(await submit(latest), url);
    await Promise.all(latest.map(file => fs.unlink(file)));
    await page.waitForFunction(generation => window.gridiffPerf.result.generation > generation && document.querySelector('tbody')?.textContent.includes('replacement'), initial.generation);
    assert.equal(await page.evaluate(() => window.reuseMarker), 'retained-document');
    assert.equal(await page.evaluate(() => window.gridiffPerf.result.workers), 0);
    assert.equal(await page.evaluate(() => window.gridiffPerf.result.native), true);
    assert.equal(await page.locator('#search').inputValue(), '');
    assert.equal(page.url(), url + '#profile=1');

    // A slow XLSX response must not overwrite a later CSV comparison or retain its settings.
    const rows = [['id', 'value'], ...Array.from({ length: 5000 }, (_, i) => [String(i), 'xlsx'])];
    const slow = await files([await workbook({ Data: rows }), await workbook({ Data: rows })], 'xlsx');
    const final = await files(['id,value\n1,old', 'id,value\n1,latest-csv']);
    await submit(slow); await submit(final);
    const generation = (await (await fetch(url + 'snapshot')).json()).generation;
    await page.waitForFunction(generation => window.gridiffPerf.result.generation === generation && document.querySelector('tbody')?.textContent.includes('latest-csv'), generation);
    assert.equal(await page.locator('#sheet-label').isVisible(), false);
    assert.equal(await page.evaluate(() => window.gridiffPerf.result.workers), 0);
    await page.close();
    const discoveryName = (await fs.readdir(runtimeDirectory)).find(name => name.endsWith('.json'));
    const discoveryPath = path.join(runtimeDirectory, discoveryName);
    const discovery = JSON.parse(await fs.readFile(discoveryPath, 'utf8'));
    const response = await new Promise((resolve, reject) => {
      const request = require('node:http').request(url + 'submit', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + discovery.control } }, response => {
        let body = ''; response.setEncoding('utf8'); response.on('data', chunk => { body += chunk; });
        response.on('end', () => resolve({ status: response.statusCode, data: JSON.parse(body) }));
      });
      request.on('error', reject); request.end(JSON.stringify({ files: final, open: true }));
    });
    assert.equal(response.status, 200);
    assert.equal(response.data.open, true, 'closing the page permits reopening');
    const reopened = await context.newPage(); await reopened.goto(url + '#profile=1');
    await reopened.waitForFunction(() => window.gridiffPerf?.result?.ok);
    assert.ok((await reopened.locator('#content').innerText()).includes('latest-csv'));
    await reopened.getByRole('button', { name: '结束比较', exact: true }).click();
    await reopened.waitForFunction(() => document.querySelector('#title').textContent === '比较已结束');
    await reopened.close();
    // Recreate an abandoned record, as after a killed service, without killing an unrelated process.
    for (let i = 0; i < 100; i++) {
      if (!await fs.access(discoveryPath).then(() => true, () => false)) break;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.equal(await fs.access(discoveryPath).then(() => true, () => false), false);
    await fs.writeFile(discoveryPath, JSON.stringify(discovery), { mode: 0o600 });
    const recovered = await submit(final);
    assert.notEqual(recovered, url);
    assert.deepEqual(errors, []);
    console.log('Reusable browser passed: concurrent launch, paged global search/columns, latest-view wins, one document with native computation, deleted inputs, stale compute, reopening and abandoned discovery recovery.');
  } finally { await browser.close(); for (const url of urls) await close(url); }
})().catch(error => { console.error(error); process.exitCode = 1; });
