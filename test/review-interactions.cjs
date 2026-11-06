'use strict';
const assert = require('node:assert/strict');
const path = require('node:path');

async function openSettings(page) {
  if (!await page.locator('#settings').evaluate(node => node.open)) await page.locator('#settings > summary').click();
}
async function ready(page) { await page.waitForFunction(() => document.querySelector('#content').getAttribute('aria-busy') === 'false'); }

// Run the same display contract against native projections and the independent plugin renderer.
async function reviewInteractions(page) {
  await ready(page);
  await page.locator('#only-changes').check();
  await page.locator('#only-fields').check();
  await page.locator('#grid-tab').click(); await ready(page);
  await page.locator('#field-filter').selectOption('price'); await ready(page);
  await page.waitForFunction(() => document.querySelectorAll('tbody tr').length === 4);
  assert.equal(await page.locator('thead .technical').innerText(), 'price · int32 · all');
  const summary = await page.locator('#summary').textContent();
  await page.locator('#search').fill('生命药水');
  await page.waitForFunction(() => document.querySelectorAll('tbody tr').length === 1);
  assert.equal(await page.locator('#summary').textContent(), summary);
  await page.locator('#next-record').click();
  const selection = await page.locator('#record-position').textContent();
  await openSettings(page);
  await page.evaluate(() => { window.reviewTable = document.querySelector('table'); });
  const signatures = [];
  for (const style of ['github', 'material', 'soft', 'brutalist']) {
    await page.getByLabel('组件风格', { exact: true }).selectOption(style);
    assert.ok(await page.evaluate(() => window.reviewTable === document.querySelector('table')), 'style must preserve DOM');
    assert.equal(await page.locator('#search').inputValue(), '生命药水');
    assert.equal(await page.locator('#field-filter').inputValue(), 'price');
    assert.equal(await page.locator('#record-position').textContent(), selection);
    signatures.push(await page.locator('#search').evaluate(node => {
      const css = getComputedStyle(node); return [css.borderRadius, css.borderTopWidth, css.borderBottomWidth, css.boxShadow].join('|');
    }));
  }
  assert.equal(new Set(signatures).size, 4, 'component styles must have distinct input treatment');
  let appearanceRequests = 0;
  const countComparison = request => { if (request.url().endsWith('/compare')) appearanceRequests++; };
  page.on('request', countComparison);
  for (const style of ['github', 'material', 'soft', 'brutalist']) {
    await page.getByLabel('组件风格', { exact: true }).selectOption(style);
    await page.getByLabel('阅读布局', { exact: true }).selectOption('matrix');
    const matrixHeight = (await page.locator('tbody tr').boundingBox()).height;
    for (const layout of ['paper', 'focus', 'terminal', 'matrix']) {
      await page.getByLabel('阅读布局', { exact: true }).selectOption(layout);
      assert.equal(await page.locator('#grid-tab').getAttribute('aria-pressed'), 'true', 'layout must preserve grid view');
      assert.ok(await page.evaluate(() => window.reviewTable === document.querySelector('table')), 'grid layout changes preserve the table DOM');
      assert.equal(await page.locator('#field-filter').inputValue(), 'price');
      assert.equal(await page.locator('#search').inputValue(), '生命药水');
      assert.equal(await page.locator('#record-position').textContent(), selection);
      const rowHeight = (await page.locator('tbody tr').boundingBox()).height;
      if (layout === 'paper') assert.ok(rowHeight > matrixHeight, `${style}: paper layout must visibly increase grid reading space`);
      if (layout === 'terminal') {
        assert.ok(rowHeight < matrixHeight, `${style}: terminal layout must visibly compact grid rows`);
        assert.equal(await page.locator('.cell-value').evaluate(node => getComputedStyle(node).fontFamily), await page.locator('.record-id').evaluate(node => getComputedStyle(node).fontFamily), 'terminal data uses the monospace font');
      }
      if (layout === 'focus') {
        const before = await page.locator('td .before').boundingBox(), after = await page.locator('td .after').boundingBox();
        assert.equal(before.y, after.y, 'focus grid must align old and new values side by side');
        assert.ok(after.x >= before.x + before.width, 'focus values must not overlap');
        assert.notEqual(await page.locator('tr.current > th').evaluate(node => getComputedStyle(node).boxShadow), 'none', 'focus grid identifies the current row');
      }
    }
  }
  assert.equal(appearanceRequests, 0, 'appearance does not request a comparison');
  page.off('request', countComparison);
  await page.keyboard.press('Escape');
  await page.locator('#list-tab').click(); await ready(page);
  await openSettings(page);
  appearanceRequests = 0; page.on('request', countComparison);
  const matrixFieldHeight = (await page.locator('.change-field').boundingBox()).height;
  for (const layout of ['paper', 'focus', 'terminal', 'matrix']) {
    await page.getByLabel('阅读布局', { exact: true }).selectOption(layout);
    assert.equal(await page.locator('#list-tab').getAttribute('aria-pressed'), 'true', 'layout must preserve list view');
    assert.match(await page.locator('#content').textContent(), /40/);
    assert.match(await page.locator('#content').textContent(), /60/);
    assert.equal(await page.locator('#record-position').textContent(), selection);
    if (layout === 'paper') assert.ok((await page.locator('.change-field').boundingBox()).height > matrixFieldHeight, 'paper list has more reading space');
    if (layout === 'terminal') assert.equal(await page.locator('.expanded').evaluate(node => getComputedStyle(node).display), 'block', 'terminal list stacks old and new lines');
    if (layout === 'focus') {
      assert.equal(await page.locator('.focus-detail').count(), 1);
      assert.equal(await page.locator('.focus-detail .change-record').count(), 1);
    }
  }
  assert.equal(appearanceRequests, 0, 'list reflow stays local');
  page.off('request', countComparison);
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('#settings').evaluate(node => node.open), false);
  assert.equal(await page.evaluate(() => document.activeElement === document.querySelector('#settings > summary')), true);
  await page.locator('#search').fill('no-matching-record');
  await page.locator('.empty-state').waitFor();
  await page.locator('.empty-state button').click(); await ready(page);
  assert.equal(await page.locator('#field-filter').inputValue(), '');
  assert.equal(await page.locator('#search').inputValue(), '');
  assert.equal(await page.evaluate(() => document.activeElement.id), 'search');
  await openSettings(page);
  assert.ok((await page.locator('#source-details').textContent()).includes('旧版本'));
  await page.locator('#title').click();
  assert.equal(await page.locator('#settings').evaluate(node => node.open), false, 'outside click dismisses settings');
  for (const width of [390, 728, 1280]) {
    await page.setViewportSize({ width, height: 844 });
    await page.locator('#grid-tab').click(); await ready(page);
    await page.locator('tbody tr').first().click();
    const values = await page.locator('tbody').textContent();
    for (const layout of ['matrix', 'paper', 'focus', 'terminal']) {
      await openSettings(page);
      await page.getByLabel('阅读布局', { exact: true }).selectOption(layout);
      await page.keyboard.press('Escape');
      await page.locator('.grid-wrap').evaluate(node => { node.scrollTop = 0; });
      assert.equal(await page.locator('tbody').textContent(), values, 'layouts retain every value, label and numeric delta');
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `no page overflow at ${width} with ${layout}`);
      for (const side of ['added', 'removed']) {
        assert.equal(await page.locator(`tbody tr.${side} .version`).count(), 0);
        assert.ok(await page.locator(`tbody tr.${side} .value-line`).first().evaluate(node => node.getBoundingClientRect().width > 0));
      }
      const host = await page.locator('html').getAttribute('data-host') || 'editor';
      await page.screenshot({ path: path.join(__dirname, '..', 'dist', `review-${host}-grid-${layout}-${width}.png`), fullPage: true });
    }
    await page.locator('#list-tab').click(); await ready(page);
    await openSettings(page);
    await page.getByLabel('组件风格', { exact: true }).selectOption('soft');
    await page.getByLabel('阅读布局', { exact: true }).selectOption('focus'); await ready(page);
    await page.keyboard.press('Escape');
    await page.locator('.record-queue button').last().click();
    assert.equal(await page.locator('.focus-detail .change-record').count(), 1);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `no page overflow at ${width}`);
    assert.ok((await page.locator('.focus-detail').boundingBox()).height >= 100);
    await page.evaluate(() => { window.previousDetail = document.querySelector('.focus-detail').firstChild; });
    await page.locator('.focus-detail .record-id').click();
    assert.ok(await page.evaluate(() => window.previousDetail === document.querySelector('.focus-detail').firstChild), 'reading detail must not rebuild it');
    const selectedColor = await page.locator('.record-queue button[aria-pressed="true"]').evaluate(node => getComputedStyle(node).backgroundColor);
    const otherColor = await page.locator('.record-queue button[aria-pressed="false"]').first().evaluate(node => getComputedStyle(node).backgroundColor);
    assert.notEqual(selectedColor, otherColor, 'focus queue selection is visible');
    if (width === 390) {
      assert.equal(await page.locator('.focus-detail').evaluate(node => getComputedStyle(node).overflowY), 'visible', 'narrow detail uses the main content scroll');
      await page.locator('#content').focus(); await page.keyboard.press('PageDown');
      await page.waitForFunction(() => document.querySelector('.focus-detail .after').getBoundingClientRect().bottom <= document.querySelector('#content').getBoundingClientRect().bottom + 1);
      const valueBox = await page.locator('.focus-detail .after').boundingBox(), contentBox = await page.locator('#content').boundingBox();
      assert.ok(valueBox.y >= contentBox.y && valueBox.y + valueBox.height <= contentBox.y + contentBox.height + 1, 'new value is reachable in one content scroll');
    }
    const host = await page.locator('html').getAttribute('data-host') || 'editor';
    await page.screenshot({ path: path.join(__dirname, '..', 'dist', `review-${host}-focus-${width}.png`), fullPage: true });
  }
  await page.setViewportSize({ width: 1360, height: 1000 });
  await openSettings(page);
  await page.getByLabel('组件风格', { exact: true }).selectOption('material');
  await page.getByLabel('阅读布局', { exact: true }).selectOption('matrix'); await ready(page);
  await page.keyboard.press('Escape');
  await page.locator('#grid-tab').click(); await ready(page);
}

async function reviewPagination(page) {
  await ready(page);
  await page.locator('#only-fields').check(); await ready(page);
  await page.locator('#field-filter').selectOption('rare'); await ready(page);
  await page.waitForFunction(() => document.querySelectorAll('tbody tr').length === 1);
  assert.match(await page.locator('tbody .record-id').textContent(), /204/);
  assert.match(await page.locator('#results').textContent(), /1 \/ 205/);
  await page.locator('#clear-filters').click(); await ready(page);
  await page.waitForFunction(() => document.querySelectorAll('tbody tr').length === 100);
  await page.locator('tbody tr').last().click();
  await page.locator('#next-record').click(); await ready(page);
  await page.waitForFunction(() => document.querySelector('#record-position').textContent === '101 / 205');
  assert.equal(await page.locator('#page').textContent(), '2 / 3');
  assert.match(await page.locator('tr.current .record-id').textContent(), /100$/);
  await openSettings(page);
  const pageBefore = await page.locator('#page').textContent();
  await page.locator('.grid-wrap').evaluate(node => { node.scrollTop = 100; window.scrollTable = node; });
  for (const layout of ['paper', 'focus', 'terminal', 'matrix']) {
    await page.getByLabel('阅读布局', { exact: true }).selectOption(layout);
    assert.equal(await page.locator('#page').textContent(), pageBefore);
    assert.equal(await page.locator('#record-position').textContent(), '101 / 205');
    assert.ok(await page.evaluate(() => window.scrollTable === document.querySelector('.grid-wrap')));
    assert.ok(await page.locator('.grid-wrap').evaluate(node => node.scrollTop > 0), 'layout must not reset scrolling; row height changes may adjust the browser scroll anchor');
  }
  await page.keyboard.press('Escape');
  await page.locator('#previous-record').click(); await ready(page);
  await page.waitForFunction(() => document.querySelector('#record-position').textContent === '100 / 205');
  assert.equal(await page.locator('#page').textContent(), '1 / 3');
  const geometry = await page.locator('tr.current').evaluate(node => ({ row: node.getBoundingClientRect().top, header: document.querySelector('thead').getBoundingClientRect().bottom, bottom: node.getBoundingClientRect().bottom, viewport: document.querySelector('.grid-wrap').getBoundingClientRect().bottom }));
  assert.ok(geometry.row >= geometry.header - 1 && geometry.bottom <= geometry.viewport + 1, 'cross-page selection is visible below sticky header');
  if (await page.locator('html').getAttribute('data-host') === 'browser') {
    await page.locator('#next').click(); await ready(page);
    await page.locator('#list-tab').click(); await ready(page);
    await openSettings(page);
    let releaseSearch, requests = 0;
    const searchGate = new Promise(resolve => { releaseSearch = resolve; });
    const delayedSearch = async route => { requests++; await searchGate; await route.continue(); };
    await page.route('**/compare', delayedSearch);
    const searching = page.waitForRequest(request => request.url().endsWith('/compare'));
    await page.locator('#search').fill('only-last'); await searching;
    await openSettings(page);
    await page.getByLabel('阅读布局', { exact: true }).selectOption('focus');
    assert.equal(await page.locator('#list-tab').getAttribute('aria-pressed'), 'true');
    releaseSearch();
    await page.waitForFunction(() => document.querySelector('.focus-detail .record-id')?.textContent === 'id  204');
    assert.equal(await page.locator('#page').textContent(), '1 / 1', 'layout must not restore the previous projection page');
    assert.equal(await page.locator('#search').inputValue(), 'only-last');
    assert.equal(requests, 1, 'layout must not enqueue a stale view during search');
    await page.unroute('**/compare', delayedSearch);
    await page.keyboard.press('Escape');
    await page.locator('#clear-filters').click(); await ready(page);
    await page.locator('#grid-tab').click(); await ready(page);
    await openSettings(page); await page.getByLabel('阅读布局', { exact: true }).selectOption('matrix');
    await page.keyboard.press('Escape');
  }
  await page.locator('#prev').evaluate(node => node.click()); await ready(page);
}
module.exports = { reviewInteractions, reviewPagination };
