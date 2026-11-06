'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { chromium } = require('playwright');
const { startComparisonServer } = require('./browser-server.cjs');
const { reviewInteractions, reviewPagination } = require('./review-interactions.cjs');
const { workbook } = require('./xlsx-fixtures');

(async () => {
  assert.ok(process.env.CODEX_AGENT_TMP, 'Run with agent-tmp-run');
  const temp = process.env.CODEX_AGENT_TMP, servers = [];
  const start = async (extension, values, timing = {}) => {
    const files = values.map((_, i) => path.join(temp, `${servers.length}-${i}.${extension}`));
    await Promise.all(files.map((file, i) => fs.writeFile(file, values[i])));
    const server = await startComparisonServer({ files, ...timing }); servers.push(server);
    await Promise.all(files.map(file => fs.unlink(file)));
    return server;
  };
  const browser = await chromium.launch({ headless: true, channel: process.env.PLAYWRIGHT_CHANNEL || 'chrome' });
  const errors = [];
  try {
    const context = await browser.newContext({ viewport: { width: 1360, height: 1000 } });
    let preferences = { mode: 'system', palette: 'default', style: 'material', layout: 'matrix' };
    await context.route('**/preferences', async route => {
      if (route.request().method() === 'POST') preferences = route.request().postDataJSON();
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify(preferences) });
    });
    const openSettings = async () => { if (!await page.locator('#settings').evaluate(node => node.open)) await page.locator('#settings > summary').click(); };
    const page = await context.newPage(); page.on('pageerror', error => errors.push(error.message));
    const csv = await start('csv', [
      'group,key,value\ng,a,old\ng,b,same\nx,c,removed\n',
      'group,key,value\ng,a,new\ng,b,same\ny,d,<img src=x onerror=alert(1)>\n'
    ]);
    await page.goto(csv.url);
    assert.equal(await page.evaluate(() => typeof window.gridiffPerf), 'undefined');
    await page.locator('#error:not([hidden])').waitFor();
    assert.match(await page.locator('#error').innerText(), /重复/);
    assert.equal(await page.locator('[data-action=native]').isVisible(), false);
    await openSettings();
    await page.locator('#keys').click();
    await page.getByLabel('对齐方式', { exact: true }).selectOption('key');
    await page.getByRole('checkbox', { name: 'group', exact: true }).check();
    await page.getByRole('checkbox', { name: 'key', exact: true }).check();
    await page.getByRole('button', { name: '应用', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('#keys').textContent.includes('group + key') && !document.querySelector('#keys').disabled);
    assert.equal(await page.locator('#error').isVisible(), false);
    assert.equal(await page.locator('tbody tr').count(), 3);
    assert.ok((await page.locator('#content').innerText()).includes('<img src=x onerror=alert(1)>'));
    assert.equal(await page.locator('#content img').count(), 0);
    assert.ok((await page.locator('#notice').innerText()).includes('内存中的只读快照'));
    await openSettings();
    await page.locator('#format').click();
    await page.getByLabel('格式', { exact: true }).selectOption('custom');
    await page.getByLabel('字段名所在记录', { exact: true }).fill('1');
    await page.getByLabel('数据起始记录', { exact: true }).fill('2');
    await page.getByRole('button', { name: '应用', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('#format').textContent.includes('自定义表头') && !document.querySelector('#format').disabled);
    await page.locator('#search').fill('new');
    await page.waitForFunction(() => document.querySelectorAll('tbody tr').length === 1);
    await page.reload();
    await page.waitForFunction(() => document.querySelectorAll('tbody tr').length === 1);
    assert.equal(await page.locator('#search').inputValue(), 'new');
    await page.locator('#search').fill('');
    await page.waitForFunction(() => document.querySelectorAll('tbody tr').length === 3);
    await page.getByRole('button', { name: '交换左右', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('tr.modified .after')?.textContent.includes('old'));
    await page.getByRole('button', { name: '重新计算', exact: true }).click();
    await page.waitForFunction(() => !document.querySelector('#keys').disabled);
    assert.ok((await page.locator('tr.modified .after').innerText()).includes('old'));
    await page.setViewportSize({ width: 375, height: 900 });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await openSettings();
    await page.locator('#keys').click();
    await page.getByLabel('对齐方式', { exact: true }).selectOption('position');
    await page.getByRole('button', { name: '应用', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('#keys').textContent === '对齐：行号' && !document.querySelector('#keys').disabled);
    await page.setViewportSize({ width: 1360, height: 1000 });
    await fs.mkdir(path.join(__dirname, '..', 'dist'), { recursive: true });
    await page.screenshot({ path: path.join(__dirname, '..', 'dist', 'gridiff-browser.png'), fullPage: true });
    await page.getByRole('button', { name: '结束比较', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('#title').textContent === '比较已结束');
    await csv.closed;
    assert.equal(await page.locator('#content').innerText(), '');
    assert.equal(await page.locator('#sources').innerText(), '');
    assert.equal(await page.locator('#source-details').textContent(), '');
    assert.equal(await page.locator('#field-filter option').count(), 0);
    assert.equal(await page.locator('button:enabled, input:enabled, select:enabled').count(), 0);

    const xlsx = await start('xlsx', [
      await workbook({ Data: [['id', 'value'], ['1', { formula: '1+1', result: 2 }]] }),
      await workbook({ Data: [['id', 'value'], ['1', { formula: '2+1', result: 3 }]], Extra: [['id', 'value'], ['2', 'new sheet']] })
    ]);
    await page.goto(xlsx.url);
    await page.waitForFunction(() => document.querySelectorAll('#sheet option').length === 1);
    await page.waitForFunction(() => document.querySelector('tbody tr.modified'));
    assert.ok((await page.locator('#content').innerText()).includes('2'));
    assert.ok((await page.locator('#content').innerText()).includes('3'));
    assert.ok(!(await page.locator('#content').innerText()).includes('1+1'));
    assert.ok(!(await page.locator('#content').innerText()).includes('2+1'));
    assert.ok(!(await page.locator('#content').innerText()).includes('new sheet'));
    assert.equal(await page.locator('#search').inputValue(), '');
    await page.getByRole('button', { name: '结束比较', exact: true }).click();
    await xlsx.closed;

    const vertical = await start('csv', ['all,int32,None,无,0\nall,int32,All,所有,1', 'all,int32,None,无,0\ngo,int32,All,所有,2']);
    await page.goto(vertical.url);
    await page.waitForFunction(() => document.querySelector('#format').textContent.includes('Mova 竖表'));
    await openSettings();
    await page.locator('#format').click();
    await page.getByLabel('格式', { exact: true }).selectOption('mova-vertical');
    await page.getByRole('button', { name: '应用', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('#format').textContent === '格式：Mova 竖表' && !document.querySelector('#format').disabled);
    assert.equal(await page.locator('#error').isVisible(), false);
    assert.ok((await page.locator('#keys').textContent()).includes('name'));
    await page.getByRole('button', { name: '结束比较', exact: true }).click();
    await vertical.closed;

    for (const extension of ['txt', 'png', 'tmp']) {
      const unsupported = await start(extension, ['id,value\n1,a', Buffer.from([0, 255, 1])]);
      await page.goto(unsupported.url);
      await page.locator('#error:not([hidden])').waitFor();
      const message = await page.locator('#error').innerText();
      assert.match(message, /不支持/); assert.match(message, /\.csv/); assert.match(message, /\.xlsx/);
      assert.doesNotMatch(message, /可调整/);
      assert.equal(await page.locator('table').count(), 0);
      assert.equal(await page.locator('#keys').isDisabled(), true);
      assert.equal(await page.locator('#format').isDisabled(), true);
      await page.getByRole('button', { name: '结束比较', exact: true }).click();
      await unsupported.closed;
    }

    const expired = await start('csv', ['id,value\n1,a', 'id,value\n1,b']);
    await page.goto(expired.url);
    await page.locator('tr.modified').waitFor();
    await expired.close();
    await page.waitForFunction(() => document.querySelector('#title').textContent === '比较已结束');
    assert.ok((await page.locator('#review-notice').innerText()).includes('重新打开比较'));
    assert.equal(await page.locator('button:enabled').count(), 0);
    const fixtures = await Promise.all(['before.csv', 'after.csv'].map(name => fs.readFile(path.join(__dirname, 'fixtures', name))));
    const review = await start('csv', fixtures);
    await page.goto(review.url); await page.locator('tbody tr').first().waitFor();
    await reviewInteractions(page); await review.close();
    const sparse = await start('csv', ['old', 'new'].map(value => 'id,v,rare,other\n' + Array.from({ length: 205 }, (_, i) => `${i},${value},${value === 'new' && i === 204 ? 'only-last' : ''},same`).join('\n')));
    await page.goto(sparse.url); await page.locator('tbody tr').first().waitFor();
    await reviewPagination(page); await sparse.close();
    assert.deepEqual(errors, []);
    console.log('Browser UI passed: CSV/XLSX snapshots, compound keys, custom headers, swap, reload, source removal, safe text, responsive layout, session end and expiry.');
  } finally {
    await browser.close();
    await Promise.all(servers.map(server => server.close()));
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
