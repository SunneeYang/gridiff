'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const vm = require('node:vm');
const { chromium } = require('playwright');
const { readTable } = require('../src/csv');
const { compareTables } = require('../src/diff');
const { readWorkbook, worksheetTable } = require('../src/xlsx');
const { workbook } = require('./xlsx-fixtures');
const root = path.resolve(__dirname, '..');
const moduleStub = { exports: {} };
let origin;
vm.runInNewContext(fs.readFileSync(path.join(root, 'src/webview.js'), 'utf8'), {
  module: moduleStub,
  require: name => name === 'vscode' ? { Uri: { joinPath: (_, dir, file) => `${origin}/${dir}/${file}` } } : name.startsWith('.') ? require(path.join(root, 'src', name)) : require(name)
});
const server = http.createServer((request, response) => {
  if (request.url === '/') {
    let html = moduleStub.exports.webviewHTML({ cspSource: origin, asWebviewUri: uri => uri }, {});
    const nonce = html.match(/script nonce="([^"]+)"/)[1];
    html = html.replace('<script nonce=', `<script nonce="${nonce}">window.messages=[];window.acquireVsCodeApi=()=>({getState:()=>null,setState:()=>{},postMessage:m=>window.messages.push(m)});</script><script nonce=`);
    response.setHeader('Content-Type', 'text/html'); response.end(html);
  } else if (request.url === '/theme.css') {
    response.setHeader('Content-Type', 'text/css');
    response.end(':root { --vscode-editor-background:#1e1e1e;--vscode-editor-foreground:#ddd;--vscode-descriptionForeground:#aaa;--vscode-panel-border:#444;--vscode-sideBar-background:#252526;--vscode-list-hoverBackground:#303033;--vscode-input-background:#333;--vscode-input-foreground:#ddd;--vscode-gitDecoration-addedResourceForeground:#81b88b;--vscode-gitDecoration-deletedResourceForeground:#d9919b;--vscode-gitDecoration-modifiedResourceForeground:#d9b476; }');
  } else if (['/media/main.js', '/media/main.css'].includes(request.url)) {
    response.setHeader('Content-Type', request.url.endsWith('.js') ? 'text/javascript' : 'text/css');
    response.end(fs.readFileSync(path.join(root, request.url)));
  } else { response.writeHead(404); response.end(); }
});

(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({ headless: true, channel: process.env.PLAYWRIGHT_CHANNEL || 'chrome' });
  try {
    const page = await browser.newPage({ viewport: { width: 1360, height: 1000 }, deviceScaleFactor: 1 });
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await page.goto(origin);
    const fixture = name => fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8');
    const payload = { type: 'comparison', title: '物品表.csv', sources: ['HEAD / 物品表.csv', '工作区 / 物品表.csv'],
      options: { format: 'auto', keyColumns: [] }, skipped: [0, 0], revision: 1,
      result: compareTables(readTable(fixture('before.csv')), readTable(fixture('after.csv'))) };
    const send = async value => { await page.evaluate(value => window.postMessage(value, '*'), value); await page.locator('#title').filter({ hasText: value.title }).waitFor(); };
    const cell = async (id, field) => {
      const fields = (await page.locator('thead .technical').allTextContents()).map(text => text.split(' · ')[0]);
      assert.ok(fields.includes(field));
      return page.locator('tbody tr').filter({ has: page.locator('.record-id').filter({ hasText: new RegExp(`^id  ${id}$`) }) }).locator('td').nth(fields.indexOf(field));
    };
    await send(payload);
    const price = await cell('100101', 'price');
    assert.ok((await price.innerText()).includes('+20'));
    assert.equal(await price.locator('.before').count(), 1);
    assert.deepEqual(await price.locator('.version').allTextContents(), ['旧', '新']);
    assert.equal(await page.locator('#content button, #inspector').count(), 0);
    await price.click();
    assert.equal(await page.locator('#inspector').count(), 0);
    assert.equal(await page.locator('tbody tr').count(), 6);
    assert.equal(await page.locator('tbody tr.added .before').count(), 0);
    assert.ok(await page.locator('tbody tr.added .after').count() > 0);
    assert.equal(await page.locator('tbody tr.added .version, tbody tr.removed .version').count(), 0);
    assert.equal(await page.locator('tbody tr.removed .after').count(), 0);
    assert.ok(await page.locator('tbody tr.removed .before').count() > 0);
    const addedPrice = await cell('100104', 'price');
    assert.equal(await addedPrice.locator('.before, .version').count(), 0);
    assert.equal(await addedPrice.locator('.after').innerText(), '150');
    const removedPrice = await cell('100105', 'price');
    assert.equal(await removedPrice.locator('.after, .version').count(), 0);
    assert.equal(await removedPrice.locator('.before').innerText(), '20');
    await page.getByRole('button', { name: '变更清单', exact: true }).click();
    assert.equal(await page.locator('.change-record').count(), 6);
    assert.equal(await page.locator('#content button').count(), 0);
    const addedRecord = page.locator('.change-record').filter({ hasText: '100104' });
    assert.equal(await addedRecord.locator('.before').count(), 0);
    assert.ok(await addedRecord.locator('.after').count() > 0);
    assert.equal(await addedRecord.locator('.version').count(), 0);
    const removedRecord = page.locator('.change-record').filter({ hasText: '100105' });
    assert.ok(await removedRecord.locator('.before').count() > 0);
    assert.equal(await removedRecord.locator('.after, .version').count(), 0);
    await page.getByRole('searchbox').fill('复苏');
    await page.waitForFunction(() => document.querySelectorAll('.change-record').length === 1);
    assert.ok((await page.locator('.change-record').innerText()).includes('复苏药剂'));
    await page.getByRole('searchbox').fill('');
    await page.waitForFunction(() => document.querySelectorAll('.change-record').length === 6);
    await page.getByRole('button', { name: '原表对照', exact: true }).click();
    fs.mkdirSync(path.join(root, 'dist'), { recursive: true });
    await page.screenshot({ path: path.join(root, 'dist/gridiff-light.png'), fullPage: true });
    for (const width of [320, 375, 414, 768]) {
      await page.setViewportSize({ width, height: 900 });
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `no page overflow at ${width}`);
    }
    await page.setViewportSize({ width: 1360, height: 1000 });
    await page.reload();
    await send(payload);
    await page.addStyleTag({ url: `${origin}/theme.css` });
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await page.screenshot({ path: path.join(root, 'dist/gridiff-dark.png'), fullPage: true });
    const malicious = compareTables(readTable('id,v\n1,old'), readTable('id,v\n1,<img src=x onerror=alert(1)>'));
    await send({ ...payload, title: '安全检查', revision: 2, result: malicious });
    assert.equal(await page.locator('img').count(), 0);
    assert.ok((await page.locator('#content').innerText()).includes('<img src=x onerror=alert(1)>'));
    const big = 'id,v\n' + Array.from({ length: 250 }, (_, i) => `${i},new`).join('\n');
    await send({ ...payload, title: '分页检查', revision: 3, result: compareTables(readTable(''), readTable(big)) });
    assert.equal(await page.locator('tbody tr').count(), 100);
    await page.getByRole('button', { name: '下一页 →' }).click();
    assert.equal(await page.locator('#page').innerText(), '2 / 3');
    await page.getByRole('button', { name: '下一页 →' }).click();
    assert.equal(await page.locator('tbody tr').count(), 50);
    await send({ ...payload, title: '错误检查', revision: 4, result: null, error: '主键重复' });
    assert.ok(await page.getByRole('alert').isVisible());
    assert.equal(await page.locator('tbody tr').count(), 0);
    const movaHeader = 'ts,none,ts\nint32,string,string\nid,name,effect\n编号,名称,效果\n';
    const emptyIds = compareTables(readTable(movaHeader + '1,正常,old\n,停用,same\n,停用,same'), readTable(movaHeader + '1,正常,new\n,停用,same\n,停用,same'));
    await send({ ...payload, title: 'Mova 空 ID 检查', revision: 5, result: emptyIds });
    assert.equal(await page.getByRole('alert').isVisible(), false);
    assert.ok((await page.locator('#notice').innerText()).includes('Mova 无主键行：旧 2 / 新 2 条'));
    assert.equal(await page.locator('tbody tr').count(), 1);
    await page.getByLabel('仅看变动记录', { exact: true }).uncheck();
    assert.equal(await page.locator('tbody tr').count(), 3);
    assert.equal(await page.locator('tbody .record-id').filter({ hasText: '无主键记录' }).count(), 2);
    await page.getByLabel('仅看变动记录', { exact: true }).check();
    const fieldAddition = compareTables(readTable('id,value\n1,old'), readTable('id,value,extra\n1,new,\n2,,added'));
    await send({ ...payload, title: '新增记录与新增字段检查', revision: 6, result: fieldAddition });
    const newField = await cell('1', 'extra');
    assert.ok((await newField.locator('.before').innerText()).includes('不存在'));
    assert.deepEqual(await newField.locator('.version').allTextContents(), ['旧', '新']);
    const addedEmpty = await cell('2', 'value');
    assert.equal(await addedEmpty.locator('.before, .version').count(), 0);
    assert.ok((await addedEmpty.locator('.after').innerText()).includes('空值'));
    const unified = compareTables(
      readTable('id,params,comment1,modeType,empty\n1,A,before,10,\n3,D,deleted,30,deleted-only\n2,B,same,20,'),
      readTable('id,params,comment1,modeType,empty\n1,A,after,10,\n4,0,added, ,\n2,B,same,20,')
    );
    await send({ ...payload, title: '原顺序统一增删改与字段并集', revision: 7, result: unified });
    const headers = () => page.locator('thead .technical').allTextContents();
    assert.equal(await page.locator('table').count(), 1);
    assert.deepEqual(await page.locator('tbody .record-id').allTextContents(), ['id  1', 'id  4', 'id  3']);
    assert.deepEqual(await headers(), ['id', 'params', 'comment1', 'modeType']);
    for (const kind of ['added', 'removed']) {
      const row = page.locator(`tbody tr.${kind}`);
      assert.equal(await row.locator('.version').count(), 0);
      assert.equal(await row.locator('.value-line').count(), 4);
      const color = await page.locator('body').evaluate(node => getComputedStyle(node).color);
      assert.notEqual(await row.locator('.row-status').evaluate(node => getComputedStyle(node).color), color);
      assert.equal(await row.locator('.value-line > span').first().evaluate(node => getComputedStyle(node).color), color);
      assert.notEqual(await row.locator('.value-line').first().evaluate(node => getComputedStyle(node).backgroundColor), 'rgba(0, 0, 0, 0)');
    }
    await page.getByLabel('仅看变动记录', { exact: true }).uncheck();
    assert.deepEqual(await page.locator('tbody .record-id').allTextContents(), ['id  1', 'id  4', 'id  3', 'id  2']);
    assert.deepEqual(await headers(), ['id', 'params', 'comment1', 'modeType']);
    await page.getByLabel('仅看变动记录', { exact: true }).check();
    await page.getByLabel('仅看变动字段', { exact: true }).uncheck();
    assert.equal((await headers()).length, 5);
    await page.getByLabel('仅看变动字段', { exact: true }).check();
    await page.getByRole('button', { name: '变更清单', exact: true }).click();
    const modifiedRecord = page.locator('.change-record').filter({ hasText: 'id  1' });
    assert.deepEqual(await modifiedRecord.locator('.field-title .technical').allTextContents(), ['comment1']);
    assert.equal(await page.locator('.change-record').filter({ hasText: 'id  3' }).locator('.change-field').count(), 4);
    assert.deepEqual(await page.locator('.change-record .record-id').allTextContents(), ['id  1', 'id  4', 'id  3']);
    for (const kind of ['added', 'removed']) {
      const record = page.locator('.change-record').filter({ has: page.locator(`.row-status.${kind}`) });
      const color = await page.locator('body').evaluate(node => getComputedStyle(node).color);
      assert.notEqual(await record.locator('.row-status').evaluate(node => getComputedStyle(node).color), color);
      assert.equal(await record.locator('.value-line > span').first().evaluate(node => getComputedStyle(node).color), color);
    }
    await page.getByRole('button', { name: '原表对照', exact: true }).click();
    await page.getByRole('searchbox').fill('deleted');
    await page.waitForFunction(() => document.querySelectorAll('tbody tr').length === 1);
    assert.deepEqual(await headers(), ['id', 'params', 'comment1', 'modeType']);
    await page.getByRole('searchbox').fill('');
    await page.waitForFunction(() => document.querySelectorAll('tbody tr').length === 3);
    const metadata = compareTables(
      readTable('all,all\nint32,int32\nid,value\n编号,旧说明\n1,2\n2,3'),
      readTable('all,all\nint32,string\nid,value\n编号,新说明\n1,2\n3,new')
    );
    await send({ ...payload, title: '统一表头与删除记录旧值', revision: 8, result: metadata });
    assert.equal(await page.locator('table').count(), 1);
    assert.ok((await page.locator('thead').innerText()).includes('新说明'));
    assert.ok((await page.locator('thead').innerText()).includes('value · string'));
    assert.equal(await (await cell('2', 'value')).locator('.before').innerText(), '3');
    await page.locator('#schema-title').click();
    assert.ok((await page.locator('#schema-content').innerText()).includes('旧说明'));
    await page.locator('#schema-title').click();
    const unkeyed = compareTables(readTable(movaHeader + ',旧内容,value'), readTable(movaHeader + ',新内容,value'));
    await send({ ...payload, title: '无主键行增删混排', revision: 9, result: unkeyed });
    assert.equal(await page.locator('table').count(), 1);
    assert.deepEqual(await page.locator('tbody tr').evaluateAll(rows => rows.map(row => row.className)), ['removed', 'added']);
    assert.equal((await headers()).length, 2);
    const onlyDeleted = compareTables(
      readTable('id,zero,spaces,empty,keptOnly\n1,,,,keep\n2,0, ,,\n3,,,,\n4,last,,,'),
      readTable('id,zero,spaces,empty,keptOnly\n1,,,,keep')
    );
    await send({ ...payload, title: '纯删除显示非空列', revision: 10, result: onlyDeleted });
    assert.deepEqual(await headers(), ['id', 'zero', 'spaces']);
    assert.deepEqual(await page.locator('tbody .record-id').allTextContents(), ['id  2', 'id  3', 'id  4']);
    await page.getByRole('searchbox').fill('3');
    await page.waitForFunction(() => document.querySelectorAll('tbody tr').length === 1);
    assert.deepEqual(await headers(), ['id', 'zero', 'spaces']);
    assert.ok((await page.locator('tbody').innerText()).includes('空值'));
    await page.getByRole('searchbox').fill('');
    await page.waitForFunction(() => document.querySelectorAll('tbody tr').length === 3);
    const removedField = compareTables(readTable('id,value,other\n1,,same\n2,old,deleted'), readTable('id,other\n1,same'));
    await send({ ...payload, title: '字段删除不触发整行删除回退', revision: 11, result: removedField });
    assert.deepEqual(await headers(), ['value']);
    assert.equal((await (await cell('2', 'value')).locator('.before').innerText()).trim(), 'old');
    const sparseBefore = 'id,v,rare,other\n' + Array.from({ length: 205 }, (_, i) => `${i},old,,same`).join('\n');
    const sparseAfter = 'id,v,rare,other\n' + Array.from({ length: 205 }, (_, i) => `${i},new,${i === 204 ? 'only-last' : ''},same`).join('\n');
    await send({ ...payload, title: '跨页字段并集固定', revision: 12, result: compareTables(readTable(sparseBefore), readTable(sparseAfter)) });
    assert.deepEqual(await headers(), ['v', 'rare']);
    await page.getByRole('button', { name: '下一页 →' }).click();
    await page.getByRole('button', { name: '下一页 →' }).click();
    assert.equal(await page.locator('tbody tr').count(), 5);
    assert.deepEqual(await headers(), ['v', 'rare']);
    assert.ok((await (await cell('204', 'rare')).innerText()).includes('only-last'));
    const cleared = compareTables(readTable('id,value,extra\n1,old,\n2,deleted,delete-only'), readTable('id,value,extra\n1,\n3,,new-column'));
    await send({ ...payload, title: '清空值与新增非空列取并集', revision: 13, result: cleared });
    assert.deepEqual(await headers(), ['id', 'value', 'extra']);
    assert.equal(await page.locator('tr.modified .value-line.after .absent').innerText(), '空值');

    const longText = Array.from({ length: 40 }, (_, i) => `第 ${i + 1} 行完整内容`).join('\n') + '\n' + 'LongToken'.repeat(100);
    const longTable = suffix => `id,text,unchanged\n1,"${longText}${suffix}","${longText}"`;
    await send({ ...payload, title: '完整文本与可用页面高度', revision: 14, result: compareTables(readTable(longTable('旧尾部')), readTable(longTable('新尾部'))) });
    await page.getByLabel('仅看变动字段', { exact: true }).uncheck();
    const full = await cell('1', 'text');
    for (const [side, suffix] of [['before', '旧尾部'], ['after', '新尾部']]) {
      const value = full.locator(`.${side} > span:last-child`);
      assert.equal(await value.textContent(), longText + suffix);
      assert.ok(await value.evaluate(node => node.scrollHeight <= node.clientHeight + 1), `${side} text is not clipped`);
    }
    const unchanged = (await cell('1', 'unchanged')).locator('.unchanged-value');
    assert.equal(await unchanged.textContent(), longText);
    assert.ok(await unchanged.evaluate(node => getComputedStyle(node).webkitLineClamp === 'none'));
    await page.getByRole('button', { name: '变更清单', exact: true }).click();
    assert.equal(await page.locator('#content').getAttribute('tabindex'), '0');
    await page.locator('#content').focus(); await page.keyboard.press('PageDown');
    await page.waitForFunction(() => document.querySelector('#content').scrollTop > 0);
    assert.ok((await page.locator('#content').textContent()).includes(longText + '新尾部'));
    await page.getByRole('button', { name: '原表对照', exact: true }).click();
    await page.setViewportSize({ width: 1360, height: 1400 });
    const wrap = page.locator('.grid-wrap');
    const bounds = await wrap.boundingBox(), footer = await page.locator('footer').boundingBox();
    assert.ok(bounds.height > 1400 * 0.65, 'table can use more than the former 65vh cap');
    assert.ok(Math.abs(bounds.y + bounds.height - footer.y) <= 2, 'table reaches the footer');
    assert.ok(Math.abs(footer.y + footer.height - 1400) <= 2, 'footer stays at the viewport bottom');
    await wrap.focus(); await page.keyboard.press('PageDown');
    await page.waitForFunction(() => document.querySelector('.grid-wrap').scrollTop > 0);
    const head = await page.locator('thead th').first().boundingBox();
    assert.ok(Math.abs(head.y - bounds.y) <= 2, 'header stays fixed while scrolling');
    await page.screenshot({ path: path.join(root, 'dist/gridiff-full-text.png'), fullPage: true });
    await page.setViewportSize({ width: 375, height: 480 });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await page.locator('footer').scrollIntoViewIfNeeded();
    const smallFooter = await page.locator('footer').boundingBox();
    assert.ok(smallFooter.y >= 0 && smallFooter.y + smallFooter.height <= 481, 'footer is reachable in a short window');
    await wrap.evaluate(node => { node.scrollLeft = 200; });
    const narrowWrap = await wrap.boundingBox(), sticky = await page.locator('tbody th').first().boundingBox();
    assert.ok(Math.abs(sticky.x - narrowWrap.x) <= 2, 'record identity stays fixed horizontally');
    await page.setViewportSize({ width: 1360, height: 1000 });
    const schemaColumns = Array.from({ length: 50 }, (_, i) => `field${i}`);
    const manyFields = compareTables(readTable('id\n1'), readTable(`id,${schemaColumns.join(',')}\n1,${schemaColumns.map(() => 'value').join(',')}`));
    await send({ ...payload, title: '展开字段变化仍保留表格空间', revision: 15, result: manyFields });
    await page.locator('#schema-title').click();
    assert.ok(await page.locator('#schema-content').evaluate(node => node.scrollHeight > node.clientHeight));
    assert.equal(await page.locator('#schema-content').getAttribute('tabindex'), '0');
    await page.locator('#schema-content').focus(); await page.keyboard.press('PageDown');
    await page.waitForFunction(() => document.querySelector('#schema-content').scrollTop > 0);
    assert.ok((await page.locator('.grid-wrap').boundingBox()).height >= 160);
    await page.locator('footer').scrollIntoViewIfNeeded();
    await page.locator('#schema-title').click();
    const typedTable = async rows => worksheetTable((await readWorkbook(await workbook({ Data: rows })))[0]);
    const xlsx = compareTables(await typedTable([['id', 'typed', 'formula'], ['1', 1, { formula: '1+1', result: 2 }]]),
      await typedTable([['id', 'typed', 'formula'], ['1', '1', { formula: '2*1', result: 2 }], ['2', '<script>bad()</script>', { formula: 'TODAY()' }]]));
    await send({ ...payload, title: 'XLSX 类型与公式', sources: ['旧版本.xlsx', '新版本.xlsx'], revision: 16, xlsx: true, result: xlsx, sheetName: 'Data',
      sheets: [{ name: 'Data', status: 'common', counts: xlsx.counts }, { name: '删除表', status: 'removed', counts: { added: 0, removed: 1, modified: 0 } }] });
    assert.equal(await page.locator('[data-action="native"]').isVisible(), false);
    assert.equal(await page.getByLabel('工作表', { exact: true }).isVisible(), true);
    const typed = await cell('1', 'typed');
    assert.match(await typed.innerText(), /数字/); assert.match(await typed.innerText(), /文本/);
    const formula = await cell('1', 'formula');
    assert.match(await formula.innerText(), /=1\+1/); assert.match(await formula.innerText(), /=2\*1/);
    assert.match(await (await cell('2', 'formula')).innerText(), /无缓存结果/);
    assert.equal(await page.locator('#content script').count(), 0);
    await page.getByLabel('工作表', { exact: true }).selectOption('删除表');
    assert.deepEqual(await page.evaluate(() => window.messages.at(-1)), { action: 'sheet', name: '删除表' });
    await page.getByLabel('工作表', { exact: true }).selectOption('Data');
    await page.getByRole('searchbox').fill('2*1');
    await page.waitForFunction(() => document.querySelectorAll('tbody tr').length === 1);
    await page.getByRole('searchbox').fill('');
    await page.waitForFunction(() => document.querySelectorAll('tbody tr').length === 2);
    await page.screenshot({ path: path.join(root, 'dist/gridiff-xlsx.png'), fullPage: true });
    const vertical = compareTables(readTable('all,int32,None,无,0\nall,int32,All,所有单位,1\nall,int32,Near_1,最近1个,10'),
      readTable('all,int32,None,无,0\ngo,int64,All,所有单位,2\nall,int32,Near_2,最近2个,11'));
    await send({ ...payload, title: 'Mova 竖表', revision: 17, result: vertical });
    assert.match(await page.locator('#format').textContent(), /Mova 竖表/);
    assert.match(await page.locator('#keys').textContent(), /name/);
    assert.deepEqual(await page.locator('thead .technical').allTextContents(), ['flags', 'type', 'name', 'comment', 'value']);
    assert.match(await page.locator('thead').textContent(), /导出标记.*类型.*名称.*说明.*值/);
    const changedEnum = page.locator('tbody tr').filter({ has: page.locator('.record-id').filter({ hasText: /^name  All$/ }) });
    assert.equal(await changedEnum.locator('.identity strong').textContent(), '所有单位');
    assert.equal(await changedEnum.locator('td').last().locator('.before > span:last-child').textContent(), '1');
    assert.equal(await changedEnum.locator('td').last().locator('.after > span:last-child').textContent(), '2');
    assert.equal(await page.locator('tbody tr').count(), 3);
    await page.screenshot({ path: path.join(root, 'dist/gridiff-mova-vertical.png'), fullPage: true });
    assert.deepEqual(errors, []);
    console.log('Gridiff UI passed: both views, full cell text, viewport layout, keyboard scrolling, search, pagination, safe text, errors, light/dark screenshots.');
  } finally { await browser.close(); server.close(); }
})().catch(error => { console.error(error); server.close(); process.exitCode = 1; });
