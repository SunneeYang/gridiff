'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const { startComparisonServer } = require('./browser-server.cjs');

const root = path.resolve(__dirname, '..');
const palettes = ['default', 'github', 'catppuccin', 'solarized', 'nord'];
let saved = { mode: 'system', palette: 'default' }, failSave = false;

(async () => {
  assert.ok(process.env.CODEX_AGENT_TMP, 'Run with agent-tmp-run');
  const files = ['theme-old.csv', 'theme-new.csv'].map(name => path.join(process.env.CODEX_AGENT_TMP, name));
  fs.writeFileSync(files[0], 'id,name,value\n1,生命药水,40\n2,旧制药剂,20\n3,修复材料,10');
  fs.writeFileSync(files[1], 'id,name,value\n1,生命药水,60\n3,修复材料,10\n4,复苏药剂,150');
  const servers = await Promise.all([startComparisonServer({ files }), startComparisonServer({ files })]);
  const urls = servers.map(server => server.url);
  const browser = await chromium.launch({ headless: true, channel: process.env.PLAYWRIGHT_CHANNEL || 'chrome' });
  const errors = [];
  try {
    const page = await browser.newPage({ viewport: { width: 1360, height: 1000 }, colorScheme: 'dark' });
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/preferences', async route => {
      if (route.request().method() === 'POST') {
        if (failSave) { await route.fulfill({ status: 500, contentType: 'application/json', body: '{}' }); return; }
        saved = route.request().postDataJSON();
      }
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify(saved) });
    });
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
    await Promise.all(servers.map(server => server.close()));
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
