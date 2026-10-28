'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { chromium } = require('playwright');

function observeInitialTheme() {
  const observer = new MutationObserver(records => {
    if (records.some(record => record.target.id === 'content' && record.addedNodes.length)) {
      window.guideThemeAtFirstRender = { appearance: document.documentElement.dataset.appearance, palette: document.documentElement.dataset.palette };
      observer.disconnect();
    }
  });
  observer.observe(document, { childList: true, subtree: true });
}

async function main() {
  assert.ok(process.env.CODEX_AGENT_TMP, 'Run through agent-tmp-run');
  const root = path.resolve(__dirname, '..');
  const source = pathToFileURL(path.join(root, 'docs/guide/index.html')).href;
  const head = (await fs.readFile(path.join(root, 'docs/guide/index.html'), 'utf8')).split('</head>')[0];
  const themeTag = head.match(/<script\b[^>]*\bsrc=["']theme\.js["'][^>]*>/);
  assert.ok(themeTag, 'the initial theme script must be in the document head');
  assert.doesNotMatch(themeTag[0], /\b(?:async|defer|type\s*=\s*["']module["'])\b/, 'initial theme must run synchronously');
  assert.ok(head.indexOf(themeTag[0]) < head.search(/<link\b[^>]*\brel=["']stylesheet["']/), 'initial theme must be applied before loading CSS');
  const browser = await chromium.launch({ headless: true, channel: process.env.PLAYWRIGHT_CHANNEL || 'chrome' });
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const errors = [], externalRequests = [];
  await context.route(/^https?:/, route => { externalRequests.push(route.request().url()); return route.abort(); });
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'platform', { value: 'MacIntel' });
    Object.defineProperty(navigator, 'userAgentData', { value: undefined });
    Object.defineProperty(navigator, 'clipboard', { value: {
      writeText: async value => {
        if (window.copyMode === 'deny') throw new Error('permission denied');
        window.copied = value;
      }
    } });
    Object.defineProperty(window, 'localStorage', { get() { throw new Error('storage unavailable'); } });
  });
  await context.addInitScript(observeInitialTheme);
  const page = await context.newPage();
  page.on('pageerror', error => errors.push(error.message));
  const open = (os, tool, step) => page.goto(source + '#' + new URLSearchParams({ os, tool, step }));
  const layoutCheck = async label => {
    const problems = await page.evaluate(() => {
      const width = document.documentElement.clientWidth;
      const issues = [];
      if (document.documentElement.scrollWidth > width + 1) issues.push('page overflow');
      for (const button of document.querySelectorAll('button')) {
        const box = button.getBoundingClientRect();
        if (!box.width || !box.height) continue;
        if (box.left < -1 || box.right > width + 1 || button.scrollWidth > button.clientWidth + 1) issues.push(button.textContent.trim());
      }
      return issues;
    });
    assert.deepEqual(problems, [], label);
  };
  const contrastCheck = async (target = page) => target.evaluate(() => {
    const canvas = document.createElement('canvas'); canvas.width = canvas.height = 1;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    const rgb = color => { ctx.clearRect(0, 0, 1, 1); ctx.fillStyle = color; ctx.fillRect(0, 0, 1, 1); return [...ctx.getImageData(0, 0, 1, 1).data]; };
    const luminance = values => values.slice(0, 3).map(v => v / 255).map(v => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4).reduce((n, v, i) => n + v * [.2126, .7152, .0722][i], 0);
    const failures = [];
    for (const element of document.querySelectorAll('body *')) {
      if (!element.getClientRects().length || element.closest(':disabled')) continue;
      if (![...element.childNodes].some(node => node.nodeType === Node.TEXT_NODE && node.textContent.trim())) continue;
      const style = getComputedStyle(element);
      let background = element;
      while (background.parentElement && rgb(getComputedStyle(background).backgroundColor)[3] < 255) background = background.parentElement;
      const fg = luminance(rgb(style.color)), bg = luminance(rgb(getComputedStyle(background).backgroundColor));
      const ratio = (Math.max(fg, bg) + .05) / (Math.min(fg, bg) + .05);
      const large = parseFloat(style.fontSize) >= 24 || (parseFloat(style.fontSize) >= 18.66 && Number(style.fontWeight) >= 700);
      if (ratio < (large ? 3 : 4.5)) failures.push({ text: element.textContent.trim().slice(0, 30), ratio });
    }
    return failures;
  });
  const themeCheck = async (target, appearance, palette) => {
    await target.waitForFunction(({ appearance, palette }) => document.documentElement.dataset.appearance === appearance && document.documentElement.dataset.palette === palette, { appearance, palette });
    assert.equal(await target.locator('#theme-palette').inputValue(), palette);
  };
  try {
    await page.goto(source);
    assert.equal(await page.locator('#os').inputValue(), 'macos');
    assert.equal(await page.locator('#tool').inputValue(), 'native');
    assert.equal(await page.locator('#theme-mode').inputValue(), 'system');
    await themeCheck(page, 'light', 'cobalt');
    assert.deepEqual(await page.evaluate(() => window.guideThemeAtFirstRender), { appearance: 'light', palette: 'cobalt' }, 'theme is ready before the guide first renders');
    await page.emulateMedia({ colorScheme: 'dark' });
    await themeCheck(page, 'dark', 'cobalt');
    await page.emulateMedia({ colorScheme: 'light' });
    await themeCheck(page, 'light', 'cobalt');
    await page.locator('#theme-mode').selectOption('dark');
    await themeCheck(page, 'dark', 'cobalt');
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.emulateMedia({ colorScheme: 'light' });
    await themeCheck(page, 'dark', 'cobalt');
    await page.locator('#theme-mode').selectOption('light');
    await page.emulateMedia({ colorScheme: 'dark' });
    await themeCheck(page, 'light', 'cobalt');
    await page.locator('#theme-mode').selectOption('system');
    await themeCheck(page, 'dark', 'cobalt');
    await open('macos', 'native', '4');
    for (const palette of ['cobalt', 'nord', 'solarized']) {
      await page.locator('#theme-palette').selectOption(palette);
      for (const appearance of ['light', 'dark']) {
        await page.locator('#theme-mode').selectOption(appearance);
        await themeCheck(page, appearance, palette);
        assert.deepEqual(await contrastCheck(), [], `${palette}/${appearance} text contrast`);
        await layoutCheck(`${palette}/${appearance} layout`);
        if (palette === 'cobalt') await page.screenshot({ path: path.join(root, `dist/guide-theme-${appearance}.png`), fullPage: true });
      }
    }
    await page.locator('#theme-palette').selectOption('cobalt');
    await page.locator('#theme-mode').selectOption('system');
    await page.emulateMedia({ colorScheme: 'light' });
    await themeCheck(page, 'light', 'cobalt');

    const persistent = await browser.newContext({ colorScheme: 'dark' });
    try {
      await persistent.addInitScript(observeInitialTheme);
      await persistent.route(/^https?:/, route => { externalRequests.push(route.request().url()); return route.abort(); });
      const saved = await persistent.newPage();
      saved.on('pageerror', error => errors.push(error.message));
      await saved.goto(source);
      await themeCheck(saved, 'dark', 'cobalt');
      assert.deepEqual(await saved.evaluate(() => window.guideThemeAtFirstRender), { appearance: 'dark', palette: 'cobalt' });
      await saved.locator('#theme-mode').selectOption('light');
      await saved.locator('#theme-palette').selectOption('nord');
      assert.deepEqual(await saved.evaluate(() => JSON.parse(localStorage.getItem('gridiff-guide-theme'))), { mode: 'light', palette: 'nord' });
      await saved.reload();
      await themeCheck(saved, 'light', 'nord');
      assert.equal(await saved.locator('#theme-mode').inputValue(), 'light');
      assert.deepEqual(await saved.evaluate(() => window.guideThemeAtFirstRender), { appearance: 'light', palette: 'nord' }, 'saved manual choice is applied before the guide renders');
      await saved.emulateMedia({ colorScheme: 'light' });
      await saved.emulateMedia({ colorScheme: 'dark' });
      await themeCheck(saved, 'light', 'nord');
      await saved.locator('#theme-mode').selectOption('system');
      await saved.reload();
      await themeCheck(saved, 'dark', 'nord');
      assert.equal(await saved.locator('#theme-mode').inputValue(), 'system');
    } finally { await persistent.close(); }

    for (const invalid of ['{invalid json', JSON.stringify({ mode: 'constructor', palette: 'unknown' })]) {
      const recovery = await browser.newContext({ colorScheme: 'dark' });
      try {
        await recovery.addInitScript(value => localStorage.setItem('gridiff-guide-theme', value), invalid);
        await recovery.addInitScript(observeInitialTheme);
        const sample = await recovery.newPage();
        sample.on('pageerror', error => errors.push(error.message));
        await sample.goto(source);
        await themeCheck(sample, 'dark', 'cobalt');
        assert.equal(await sample.locator('#theme-mode').inputValue(), 'system');
        assert.deepEqual(await sample.evaluate(() => window.guideThemeAtFirstRender), { appearance: 'dark', palette: 'cobalt' });
      } finally { await recovery.close(); }
    }
    for (const os of ['macos', 'windows', 'linux']) {
      for (const tool of ['native', 'vscode', 'cursor']) {
        for (let step = 1; step <= 5; step++) {
          await open(os, tool, String(step));
          assert.equal(await page.locator('#os').inputValue(), os);
          assert.equal(await page.locator('#tool').inputValue(), tool);
          assert.equal(await page.locator('[aria-current="step"]').getAttribute('data-step'), String(step));
          assert.ok((await page.locator('#content').innerText()).length > 100);
          if (step === 2 && os !== 'linux') {
            if (tool === 'vscode') assert.equal(await page.locator('#arguments').count(), 0);
            else assert.equal(await page.locator('#arguments').inputValue(), tool === 'cursor' ? '--wait --diff $REMOTE $LOCAL' : '$REMOTE $LOCAL');
          }
          if (step === 2 && os === 'linux') assert.match(await page.locator('#content').innerText(), /Linux.*无法/);
          const brokenImages = await page.locator('img').evaluateAll(async images => {
            await Promise.all(images.map(image => image.decode().catch(() => {})));
            return images.filter(image => !image.naturalWidth).map(image => image.src);
          });
          assert.deepEqual(brokenImages, []);
          await layoutCheck(`${os}/${tool}/${step}`);
          assert.deepEqual(await contrastCheck(), [], `${os}/${tool}/${step} text contrast`);
        }
      }
    }
    for (const width of [320, 375, 414, 768, 1280, 1920]) {
      await page.setViewportSize({ width, height: 800 });
      for (const tool of ['native', 'vscode', 'cursor']) {
        for (const step of ['1', '2', '4', '5']) {
          await open('windows', tool, step);
          await layoutCheck(`${width}/${tool}/${step}`);
        }
      }
    }
    await page.setViewportSize({ width: 1280, height: 800 });
    await open('windows', 'native', '2');
    const folder = page.locator('#project-root');
    await folder.fill('D:\\策划 表格\\design'); await folder.blur();
    assert.equal(await page.locator('#file-path').inputValue(), 'D:\\策划 表格\\design\\gridiff\\gridiff.cmd');
    await page.locator('[data-copy="file-path"]').click();
    assert.equal(await page.evaluate(() => window.copied), 'D:\\策划 表格\\design\\gridiff\\gridiff.cmd');
    await page.evaluate(() => { window.copyMode = 'deny'; });
    await page.locator('[data-copy="arguments"]').click();
    assert.match(await page.locator('#arguments-status').innerText(), /内容已选中/);
    assert.equal(await page.locator('#arguments').evaluate(field => field.value.slice(field.selectionStart, field.selectionEnd)), '$REMOTE $LOCAL');
    await folder.fill('relative/path'); await folder.blur();
    assert.equal(await folder.getAttribute('aria-invalid'), 'true');
    assert.equal(await page.locator('[data-copy="file-path"]').isDisabled(), true);
    await open('macos', 'native', '2');
    await page.locator('#project-root').fill('/tmp/<img src=x onerror=alert(1)>');
    await page.locator('#project-root').blur();
    await page.locator('[data-step="3"]').click();
    await page.locator('[data-step="2"]').click();
    assert.equal(await page.locator('#content img').count(), 1, 'input must remain text after rerender');
    assert.equal(await page.locator('#project-root').inputValue(), '/tmp/<img src=x onerror=alert(1)>');
    await page.locator('#next').click();
    assert.equal(new URL(page.url()).hash.includes('step=3'), true);
    await page.locator('[data-step="4"]').focus(); await page.keyboard.press('Enter');
    assert.equal(await page.locator('[aria-current="step"]').getAttribute('data-step'), '4');
    const previousURL = page.url();
    await page.locator('.skip-link').focus(); await page.keyboard.press('Enter');
    assert.equal(page.url(), previousURL, 'skip link must preserve the selected guide route');
    assert.equal(await page.evaluate(() => document.activeElement.id), 'content');
    const copy = path.join(process.env.CODEX_AGENT_TMP, 'design with spaces', 'gridiff', 'guide');
    await fs.cp(path.join(root, 'docs/guide'), copy, { recursive: true });
    await page.goto(pathToFileURL(path.join(copy, 'index.html')).href + '#os=macos&tool=native&step=2');
    assert.equal(await page.locator('#project-root').inputValue(), path.dirname(path.dirname(copy)));
    assert.equal(await page.locator('#file-path').inputValue(), path.join(path.dirname(copy), 'gridiff'));
    for (const [platform, expected] of [['Win32', 'windows'], ['Linux x86_64', 'linux'], ['Unknown', '']]) {
      const detection = await browser.newContext();
      try {
        await detection.addInitScript(platform => {
          Object.defineProperty(navigator, 'platform', { value: platform });
          Object.defineProperty(navigator, 'userAgentData', { value: undefined });
        }, platform);
        const sample = await detection.newPage();
        await sample.goto(source + '#os=invalid&tool=constructor&step=-1');
        assert.equal(await sample.locator('#os').inputValue(), expected);
        assert.equal(await sample.locator('#tool').inputValue(), 'native');
        assert.equal(await sample.locator('[aria-current="step"]').getAttribute('data-step'), '1');
      } finally { await detection.close(); }
    }
    await open('macos', 'native', '2');
    await page.screenshot({ path: path.join(root, 'dist/guide-desktop.png'), fullPage: true });
    await page.setViewportSize({ width: 375, height: 812 });
    await page.screenshot({ path: path.join(root, 'dist/guide-mobile.png'), fullPage: true });
    assert.deepEqual(errors, []);
    assert.deepEqual(externalRequests, [], 'the guide must not require any network resource');
    console.log('Offline guide passed: 45 system/tool/step branches, six viewport widths, image loading, paths, copy success/denial, keyboard navigation, unsafe input, repository-root inference, system/manual theme changes, six palette/appearance contrasts, early theme application, saved preferences and unavailable/invalid storage.');
  } finally { await browser.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
