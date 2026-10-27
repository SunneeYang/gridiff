'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { chromium } = require('playwright');
const { pageHTML } = require('../src/page');
const { readTable } = require('../src/csv');
const { compareTables } = require('../src/diff');

const root = path.resolve(__dirname, '..');
const palettes = ['default', 'github', 'catppuccin', 'solarized', 'nord'];
const payload = { type: 'comparison', title: '主题预览.csv', sources: ['旧版本', '新版本'], readonlySnapshot: true,
  options: { format: 'csv', keyColumns: ['id'] }, revision: 1, skipped: [0, 0],
  result: compareTables(readTable('id,name,value\n1,生命药水,40\n2,旧制药剂,20\n3,修复材料,10'),
    readTable('id,name,value\n1,生命药水,60\n3,修复材料,10\n4,复苏药剂,150')) };
let saved = { mode: 'system', palette: 'default' }, failSave = false;
function server() {
  return http.createServer(async (request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    if (request.url.endsWith('/preferences')) {
      if (request.method === 'POST') {
        let body = ''; for await (const chunk of request) body += chunk;
        if (failSave) { response.writeHead(500); response.end('{}'); return; }
        saved = JSON.parse(body);
      }
      response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify(saved)); return;
    }
    const name = request.url.split('/').at(-1);
    if (!name) {
      response.setHeader('Content-Type', 'text/html');
      response.end(pageHTML({ resource: asset => asset, browser: true,
        csp: "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'" }));
    } else if (name === 'browser.js') {
      response.setHeader('Content-Type', 'text/javascript');
      response.end(`window.gridiffHost={getState:()=>({onlyChanges:false,onlyFields:false}),setState:()=>{},postMessage:m=>{if(m.action==='ready')setTimeout(()=>window.dispatchEvent(new MessageEvent('message',{data:${JSON.stringify(payload)}})),0)}};`);
    } else if (['main.js', 'main.css', 'themes.js', 'themes.css'].includes(name)) {
      response.setHeader('Content-Type', name.endsWith('.css') ? 'text/css' : 'text/javascript');
      response.end(fs.readFileSync(path.join(root, 'media', name)));
    } else { response.writeHead(404); response.end(); }
  });
}
const listen = instance => new Promise(resolve => instance.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${instance.address().port}/s/example/`)));
const close = instance => new Promise(resolve => { instance.close(resolve); instance.closeAllConnections(); });

(async () => {
  assert.ok(process.env.CODEX_AGENT_TMP, 'Run with agent-tmp-run');
  const first = server(), second = server();
  const urls = await Promise.all([listen(first), listen(second)]);
  const browser = await chromium.launch({ headless: true, channel: process.env.PLAYWRIGHT_CHANNEL || 'chrome' });
  const errors = [];
  try {
    const page = await browser.newPage({ viewport: { width: 1360, height: 1000 }, colorScheme: 'dark' });
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(urls[0]);
    await page.locator('tbody tr').first().waitFor();
    assert.equal(await page.locator('html').getAttribute('data-appearance'), 'dark');
    await page.emulateMedia({ colorScheme: 'light' });
    await page.waitForFunction(() => document.documentElement.dataset.appearance === 'light');
    await page.getByLabel('明暗', { exact: true }).selectOption('dark');
    const savedPalette = page.waitForResponse(response => response.url().endsWith('/preferences') && response.request().method() === 'POST' && response.request().postDataJSON().palette === 'catppuccin');
    await page.getByLabel('配色', { exact: true }).selectOption('catppuccin');
    await page.waitForFunction(() => document.documentElement.dataset.palette === 'catppuccin');
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.emulateMedia({ colorScheme: 'light' });
    assert.equal(await page.locator('html').getAttribute('data-appearance'), 'dark');
    await savedPalette;
    await page.goto(urls[1]);
    await page.waitForFunction(() => document.documentElement.dataset.palette === 'catppuccin');
    assert.equal(await page.getByLabel('明暗', { exact: true }).inputValue(), 'dark');
    assert.equal(await page.locator('html').getAttribute('data-appearance'), 'dark');
    await page.reload();
    await page.waitForFunction(() => document.documentElement.dataset.palette === 'catppuccin');
    await page.getByLabel('明暗', { exact: true }).selectOption('system');
    await page.waitForFunction(() => document.documentElement.dataset.appearance === 'light');
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.waitForFunction(() => document.documentElement.dataset.appearance === 'dark');

    for (const mode of ['light', 'dark']) for (const palette of palettes) {
      await page.getByLabel('明暗', { exact: true }).selectOption(mode);
      await page.getByLabel('配色', { exact: true }).selectOption(palette);
      const result = await page.evaluate(() => {
        const css = getComputedStyle(document.documentElement);
        const luminance = key => {
          const hex = css.getPropertyValue(key).trim().replace('#', '');
          const rgb = [0, 2, 4].map(i => Number.parseInt(hex.slice(i, i + 2), 16) / 255)
            .map(value => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
          return 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2];
        };
        const contrast = (a, b) => (Math.max(luminance(a), luminance(b)) + 0.05) / (Math.min(luminance(a), luminance(b)) + 0.05);
        return Object.fromEntries([
          ['--fg', '--bg'], ['--fg', '--surface'], ['--muted', '--bg'], ['--muted', '--surface'],
          ['--fg', '--add-bg'], ['--fg', '--remove-bg'], ['--added', '--bg'], ['--removed', '--bg'],
          ['--modified', '--bg'], ['--selected-fg', '--selected']
        ].map(pair => [pair.join('/'), contrast(...pair)]));
      });
      for (const [pair, ratio] of Object.entries(result)) assert.ok(ratio >= 4.5, `${palette}/${mode} ${pair}: ${ratio.toFixed(2)}`);
    }
    await page.getByLabel('配色', { exact: true }).selectOption('catppuccin');
    fs.mkdirSync(path.join(root, 'dist'), { recursive: true });
    await page.screenshot({ path: path.join(root, 'dist', 'gridiff-theme-dark.png'), fullPage: true });
    await page.getByLabel('明暗', { exact: true }).selectOption('light');
    await page.getByLabel('配色', { exact: true }).selectOption('github');
    await page.screenshot({ path: path.join(root, 'dist', 'gridiff-theme-light.png'), fullPage: true });
    for (const width of [320, 375, 768]) {
      await page.setViewportSize({ width, height: 900 });
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `no horizontal page overflow at ${width}`);
    }
    failSave = true;
    await page.getByLabel('配色', { exact: true }).selectOption('solarized');
    await page.locator('#theme-save-status').filter({ hasText: '未能保存' }).waitFor();
    assert.equal(await page.locator('html').getAttribute('data-palette'), 'solarized');
    assert.deepEqual(errors, []);
    console.log('Themes passed: live OS changes, manual overrides, cross-port preferences, reload, five light/dark palettes, 4.5:1 text contrast, responsive layout and save errors.');
  } finally {
    await browser.close();
    await Promise.all([close(first), close(second)]);
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
