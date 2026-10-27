'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function harness({ startup = false, auto = true } = {}) {
  const commands = new Map(), documents = new Map(), panels = [], errors = [], native = [], picks = [];
  const controls = {};
  const emitter = () => {
    const listeners = new Set();
    return { event: fn => { listeners.add(fn); return { dispose: () => listeners.delete(fn) }; }, fire: value => { for (const fn of listeners) fn(value); } };
  };
  const tabsChanged = emitter(), groupsChanged = emitter(), configChanged = emitter();
  class Uri {
    constructor(scheme, pathname, query = '') { this.scheme = scheme; this.path = pathname; this.fsPath = pathname; this.query = query; }
    toString() { return `${this.scheme}:${this.path}${this.query ? `?${this.query}` : ''}`; }
    static file(name) { return new Uri('file', name); }
    static joinPath(base, ...parts) { return new Uri(base.scheme, path.posix.join(base.path, ...parts)); }
  }
  class TabInputTextDiff { constructor(original, modified) { Object.assign(this, { original, modified }); } }
  class TabInputWebview {}
  const defaults = { format: 'auto', keyColumns: [], headerRow: 1, dataStartRow: 2, descriptionRow: 0, autoOpenDiff: auto };
  const repository = { show: async () => 'id,v\n1,old' };
  const group = { tabs: [], viewColumn: 1 };
  const tabGroups = { all: [group], activeTabGroup: group, onDidChangeTabs: tabsChanged.event, onDidChangeTabGroups: groupsChanged.event };
  function activateTab(tab) {
    if (group.activeTab) group.activeTab.isActive = false;
    group.activeTab = tab; if (tab) tab.isActive = true;
    tabsChanged.fire({ opened: [], changed: tab ? [tab] : [], closed: [] });
  }
  function openDiff(left, right, active = true) {
    const tab = { input: new TabInputTextDiff(left, right), group, isPreview: true, isActive: false };
    group.tabs.push(tab);
    if (active) { if (group.activeTab) group.activeTab.isActive = false; group.activeTab = tab; tab.isActive = true; }
    tabsChanged.fire({ opened: [tab], changed: [], closed: [] });
    return tab;
  }
  function closeTab(tab) {
    group.tabs.splice(group.tabs.indexOf(tab), 1);
    if (group.activeTab === tab) group.activeTab = group.tabs.at(-1);
    tabsChanged.fire({ opened: [], changed: [], closed: [tab] });
  }
  const vscode = {
    Uri, TabInputTextDiff, TabInputWebview, ViewColumn: { Active: -1 },
    workspace: { getConfiguration: () => ({ get: (key, fallback) => defaults[key] ?? fallback }), onDidChangeConfiguration: configChanged.event, openTextDocument: async uri => {
      if (!documents.has(uri.toString())) throw new Error('File not found');
      const text = await documents.get(uri.toString()); return { getText: () => text };
    } },
    window: {
      tabGroups, showErrorMessage: text => errors.push(text), setStatusBarMessage() {},
      showQuickPick: async () => picks.shift(), showInputBox: async () => picks.shift(),
      createWebviewPanel: (viewType, title) => {
        let disposed = false, onDispose;
        const previous = group.activeTab;
        const tab = { input: new TabInputWebview(), group, isPreview: false };
        group.tabs.push(tab); activateTab(tab);
        const webview = { cspSource: 'https://local.test', html: '', messages: [], asWebviewUri: uri => uri.toString(),
          postMessage: async payload => webview.messages.push(structuredClone(payload)),
          onDidReceiveMessage: fn => { webview.receive = fn; return { dispose() {} }; } };
        const panel = { viewType, title, tab, onDidDispose: fn => { onDispose = fn; }, reveal: () => activateTab(tab), dispose: () => {
          if (disposed) return;
          disposed = true; onDispose(); closeTab(tab);
          if (group.tabs.includes(previous)) activateTab(previous);
        }, get webview() { if (disposed) throw new Error('Webview is disposed'); return webview; }, captured: webview };
        panels.push(panel); return panel;
      }
    },
    extensions: { getExtension: () => ({ activate: async () => ({ getAPI: () => ({ getRepository: () => repository, toGitUri: uri => new Uri('git', uri.path) }) }) }) },
    commands: { registerCommand: (name, fn) => { commands.set(name, fn); return { dispose() {} }; }, executeCommand: async (...args) => {
      native.push(args);
      if (args[0] === 'workbench.action.keepEditor') {
        const tab = group.activeTab;
        await controls.beforePin?.(); tab.isPreview = false;
        tabsChanged.fire({ opened: [], changed: [tab], closed: [] });
      } else if (args[0] === 'vscode.diff') {
        if (controls.nativeFailure) throw controls.nativeFailure;
        const [, left, right] = args;
        const existing = group.tabs.find(tab => tab.input instanceof TabInputTextDiff && tab.input.original.toString() === left.toString() && tab.input.modified.toString() === right.toString());
        const tab = existing || openDiff(left, right);
        if (args[4]?.preview === false) tab.isPreview = false;
        activateTab(tab);
      }
    } }
  };
  function load(filename) {
    const module = { exports: {} };
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'src', filename), 'utf8'), {
      module, Buffer, require: name => name === 'vscode' ? vscode : name === './webview' ? load('webview.js') : name.startsWith('.') ? require(path.join(__dirname, '..', 'src', name)) : require(name)
    });
    return module.exports;
  }
  const left = new Uri('git', '/repo/a.csv'), right = Uri.file('/repo/a.csv');
  documents.set(left.toString(), 'id,v\n1,old'); documents.set(right.toString(), 'id,v\n1,new');
  const initialTab = { input: new TabInputTextDiff(left, right), group, isPreview: true, isActive: true };
  group.tabs.push(initialTab);
  if (startup) group.activeTab = initialTab;
  const subscriptions = [];
  load('extension.js').activate({ extensionUri: Uri.file('/extension'), subscriptions });
  if (!startup) group.activeTab = initialTab;
  return { vscode, commands, documents, panels, errors, native, picks, repository, left, right, initialTab, controls,
    openDiff, closeTab, activateTab, emitGroups: () => groupsChanged.fire({ opened: [], changed: [group], closed: [] }),
    setAuto: enabled => { defaults.autoOpenDiff = enabled; configChanged.fire({ affectsConfiguration: key => key === 'gridiff.autoOpenDiff' }); },
    dispose: () => subscriptions.forEach(item => item.dispose()),
    latest: () => panels.at(-1).captured.messages.at(-1), send: action => panels.at(-1).captured.receive({ action }) };
}
const settle = () => new Promise(resolve => setImmediate(resolve));

test('current diff preserves Git URI, snapshot swap, refresh and native fallback', async () => {
  const h = harness(); await h.commands.get('gridiff.openDiff')();
  assert.equal(h.latest().result.counts.modified, 1);
  assert.match(h.latest().sources[0], /^git:/);
  await h.send('swap'); assert.equal(h.latest().result.rows[0].cells[1].after, 'old');
  h.documents.set(h.left.toString(), 'id,v\n1,fresh'); await h.send('refresh');
  assert.equal(h.latest().result.rows[0].cells[1].after, 'fresh');
  await h.send('native'); assert.equal(h.native.at(-1)[0], 'vscode.diff');
  assert.equal(h.native.at(-1)[1], h.right);
});
test('non CSV uses VS Code diff and does not create a panel', async () => {
  const h = harness(); const uri = h.vscode.Uri.file('/repo/readme.md');
  await h.commands.get('gridiff.compareFiles')(uri, [uri, uri]);
  assert.equal(h.panels.length, 0); assert.equal(h.native.at(-1)[0], 'vscode.diff');
});
test('parse errors remain visible, then alignment can be corrected', async () => {
  const h = harness(); h.documents.set(h.right.toString(), 'id,v\n1,a\n1,b');
  await h.commands.get('gridiff.openDiff')(); assert.match(h.latest().error, /重复/);
  h.picks.push({ value: 'position' }); await h.send('keys');
  assert.equal(h.latest().error, ''); assert.equal(h.latest().result.alignment, 'position');
});
test('closing a panel during file load does not surface a disposed-webview error', async () => {
  const h = harness(); let complete;
  h.documents.set(h.left.toString(), new Promise(resolve => { complete = resolve; }));
  const opening = h.commands.get('gridiff.openDiff')();
  await new Promise(resolve => setImmediate(resolve));
  h.panels[0].dispose(); complete('id,v\n1,old'); await opening;
  assert.deepEqual(h.errors, []);
});
test('HEAD comparison enforces the same byte limit and reports missing HEAD', async () => {
  const h = harness(); h.repository.show = async () => 'x'.repeat(8 * 1024 * 1024 + 1);
  await h.commands.get('gridiff.compareHead')(h.right); assert.match(h.latest().error, /8 MiB/);
  h.repository.show = async () => { throw new Error('HEAD does not exist'); };
  await h.send('refresh'); assert.match(h.latest().error, /HEAD does not exist/);
  assert.equal(h.latest().result, null);
});
test('webview has strict CSP, local-only resources and no CSV embedded in HTML', async () => {
  const h = harness(); h.documents.set(h.right.toString(), 'id,v\n1,<script>evil()</script>');
  await h.commands.get('gridiff.openDiff')();
  const html = h.panels[0].captured.html;
  assert.match(html, /default-src 'none'/); assert.match(html, /script-src 'nonce-/);
  assert.doesNotMatch(html, /evil\(\)/); assert.doesNotMatch(html, /unsafe-inline/);
});

test('startup auto-opens once, pins and retains the source diff, and closing the panel does not bounce', async () => {
  const h = harness({ startup: true }); await settle();
  assert.equal(h.panels.length, 1);
  assert.equal(h.initialTab.isPreview, false);
  assert.ok(h.vscode.window.tabGroups.all[0].tabs.includes(h.initialTab));
  assert.equal(h.latest().result.counts.modified, 1);
  h.activateTab(h.initialTab); h.emitGroups(); await settle();
  assert.equal(h.panels.length, 1);
  await h.commands.get('gridiff.openDiff')();
  assert.equal(h.panels.length, 1, 'manual command reuses the existing matching view');
  h.panels[0].dispose(); await settle();
  assert.equal(h.vscode.window.tabGroups.activeTabGroup.activeTab, h.initialTab);
  assert.equal(h.panels.length, 1);
  h.closeTab(h.initialTab); h.openDiff(h.left, h.right); await settle();
  assert.equal(h.panels.length, 2, 'new source tab can auto-open the same URI pair again');
});

test('auto-open can be disabled and only follows the active CSV diff', async () => {
  const h = harness({ auto: false, startup: true }); await settle();
  assert.equal(h.panels.length, 0);
  h.setAuto(true); await settle(); assert.equal(h.panels.length, 1);
  const md = h.vscode.Uri.file('/repo/readme.md');
  h.openDiff(md, md); await settle(); assert.equal(h.panels.length, 1);
  const background = h.openDiff(h.left, h.right, false); await settle();
  assert.equal(h.panels.length, 1);
  h.activateTab(background); await settle(); assert.equal(h.panels.length, 2);
});

test('native fallback suppresses both existing and swapped diff tabs without a permanent URI blacklist', async () => {
  const h = harness({ startup: true }); await settle();
  await h.send('native'); await settle();
  assert.equal(h.panels.length, 1);
  assert.equal(h.vscode.window.tabGroups.activeTabGroup.activeTab, h.initialTab);
  await h.commands.get('gridiff.openDiff')();
  await h.send('swap'); await h.send('native'); await settle();
  const swapped = h.vscode.window.tabGroups.activeTabGroup.activeTab;
  assert.equal(swapped.input.original, h.right);
  assert.equal(h.panels.length, 1);
  h.activateTab(h.initialTab); await h.commands.get('gridiff.openDiff')();
  assert.equal(h.panels.length, 2, 'a swapped view must not be reused for the original direction');
  assert.equal(h.latest().sources[0], h.left.toString());
  h.controls.nativeFailure = new Error('Cannot open diff');
  await h.send('native'); assert.match(h.errors.at(-1), /Cannot open diff/);
  h.controls.nativeFailure = null;
  h.openDiff(h.left, h.right); await settle();
  assert.equal(h.panels.length, 3, 'failed fallback clears transient suppression');
});

test('same tab with different Git refs is a new comparison', async () => {
  const h = harness({ startup: true }); await settle();
  const nextLeft = new h.vscode.Uri('git', h.left.path, 'ref=other');
  h.documents.set(nextLeft.toString(), 'id,v\n1,another');
  h.initialTab.input = new h.vscode.TabInputTextDiff(nextLeft, h.right);
  h.activateTab(h.initialTab); await settle();
  assert.equal(h.panels.length, 2);
  assert.equal(h.latest().result.rows[0].cells[1].before, 'another');
});

test('slow pinning cannot steal focus after tab switches, disabling, or disposal', async () => {
  for (const cancel of ['switch', 'disable', 'dispose']) {
    const h = harness(); let finishPin;
    h.controls.beforePin = () => new Promise(resolve => { finishPin = resolve; });
    h.activateTab(h.initialTab); await settle();
    if (cancel === 'switch') { const md = h.vscode.Uri.file('/repo/readme.md'); h.openDiff(md, md); }
    if (cancel === 'disable') h.setAuto(false);
    if (cancel === 'dispose') h.dispose();
    finishPin(); await settle();
    assert.equal(h.panels.length, 0, cancel);
    assert.deepEqual(h.errors, []);
  }
});

test('manual reuse of a loading view cannot steal focus after switching tabs', async () => {
  const h = harness(); let finishRead;
  h.documents.set(h.left.toString(), new Promise(resolve => { finishRead = resolve; }));
  h.activateTab(h.initialTab); await settle();
  h.activateTab(h.initialTab);
  const opening = h.commands.get('gridiff.openDiff')(); await settle();
  const md = h.vscode.Uri.file('/repo/readme.md');
  const other = h.openDiff(md, md);
  finishRead('id,v\n1,old'); await opening;
  assert.equal(h.vscode.window.tabGroups.activeTabGroup.activeTab, other);
  assert.equal(h.panels.length, 1);
});
