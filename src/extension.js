'use strict';
const path = require('node:path');
const vscode = require('vscode');
const { webviewHTML } = require('./webview');
const { createComparison, MAX_BYTES } = require('./comparison');
const { readWorkbook } = require('./xlsx');
const { readHeadWorkbook } = require('./git');

const formatNames = { auto: '自动', csv: '普通表格（一行表头）', mova: 'Mova（四行表头）', 'mova-vertical': 'Mova 竖表', headerless: '无表头', custom: '自定义多行表头' };

function activate(context) {
  let selectedLeft;
  let stopped = false;
  const panels = new Map();
  const tabViews = new WeakMap(), nativeRequests = new Map();
  const settings = uri => {
    const config = vscode.workspace.getConfiguration('gridiff', uri);
    return Object.fromEntries(['format', 'keyColumns', 'headerRow', 'dataStartRow', 'descriptionRow'].map(k => [k, config.get(k)]));
  };
  const report = error => vscode.window.showErrorMessage(`Gridiff: ${error.message || error}`);
  const register = (name, fn) => context.subscriptions.push(vscode.commands.registerCommand(name, (...args) => Promise.resolve().then(() => fn(...args)).catch(report)));
  const currentUri = uri => uri instanceof vscode.Uri ? uri : vscode.window.activeTextEditor?.document.uri;
  const label = uri => path.basename(uri.path).replace(/\.git$/, '');
  const isCSV = uri => /\.csv(?:\.git)?$/i.test(uri.path);
  const isXLSX = uri => /\.xlsx(?:\.git)?$/i.test(uri.path);
  const pairKey = (left, right) => JSON.stringify([left.toString(), right.toString()]);
  const activeTab = () => vscode.window.tabGroups.activeTabGroup.activeTab;
  const autoEnabled = uri => vscode.workspace.getConfiguration('gridiff', uri).get('autoOpenDiff', true);

  function keepTextTab(tab, key) {
    const input = tab.input;
    if (!(input instanceof vscode.TabInputTextDiff) || pairKey(input.original, input.modified) !== key) return;
    const entry = tabViews.get(tab);
    if (entry?.key === key) entry.textOnly = true;
    else tabViews.set(tab, { key, textOnly: true });
  }

  async function showNative(left, right) {
    const key = pairKey(left, right);
    nativeRequests.set(key, (nativeRequests.get(key) || 0) + 1);
    const remember = () => { for (const group of vscode.window.tabGroups.all) for (const tab of group.tabs) keepTextTab(tab, key); };
    remember();
    try {
      await vscode.commands.executeCommand('vscode.diff', left, right, `${label(left)} ↔ ${label(right)}`, { preview: false });
      remember();
    } finally {
      const remaining = nativeRequests.get(key) - 1;
      if (remaining) nativeRequests.set(key, remaining); else nativeRequests.delete(key);
    }
  }

  async function openDiffTab(tab, automatic = false) {
    const input = tab?.input;
    if (stopped || !(input instanceof vscode.TabInputTextDiff)) return;
    const xlsx = isXLSX(input.original) || isXLSX(input.modified);
    const supported = xlsx ? isXLSX(input.original) && isXLSX(input.modified) : isCSV(input.original) || isCSV(input.modified);
    if (automatic && (!autoEnabled(input.modified) || !supported)) return;
    const key = pairKey(input.original, input.modified);
    if (automatic && nativeRequests.has(key)) { keepTextTab(tab, key); return; }
    // VS Code opens a binary replacement before closing its old text-diff tab.
    if (xlsx && !tabViews.has(tab)) {
      const previousTab = vscode.window.tabGroups.all.flatMap(group => group.tabs).find(other => other !== tab &&
        tabViews.get(other)?.key === key && tabViews.get(other).opened && other.input instanceof vscode.TabInputTextDiff && pairKey(other.input.original, other.input.modified) === key);
      if (previousTab) tabViews.set(tab, tabViews.get(previousTab));
    }
    const previous = tabViews.get(tab);
    if (previous?.key === key) {
      if (automatic) return;
      const panel = await previous.opening?.catch(() => undefined);
      if (stopped || activeTab() !== tab || tabViews.get(tab) !== previous || !(tab.input instanceof vscode.TabInputTextDiff) ||
          pairKey(tab.input.original, tab.input.modified) !== key) return;
      if (panel && panels.get(panel) === key) { panel.reveal(tab.group.viewColumn); return; }
    }
    const entry = { key };
    tabViews.set(tab, entry);
    entry.opening = Promise.resolve().then(async () => {
      const current = () => !stopped && activeTab() === tab && tabViews.get(tab) === entry &&
        tab.input instanceof vscode.TabInputTextDiff && pairKey(tab.input.original, tab.input.modified) === key &&
        !entry.textOnly && (!automatic || autoEnabled(input.modified));
      // Pin the source diff before opening a webview so Fork's --wait retains its original tab.
      if (current() && tab.isPreview) await vscode.commands.executeCommand('workbench.action.keepEditor');
      if (!current()) {
        if (tabViews.get(tab) === entry && !entry.textOnly) tabViews.delete(tab);
        return;
      }
      entry.opened = true;
      return show(input.original, input.modified, undefined, tab.group.viewColumn);
    });
    return entry.opening;
  }

  const autoOpen = () => { void openDiffTab(activeTab(), true).catch(report); };

  async function read(uri) {
    if (isXLSX(uri)) {
      if ((await vscode.workspace.fs.stat(uri)).size > MAX_BYTES) throw new Error('单侧文件超过 8 MiB，请缩小工作簿。');
      return Buffer.from(await vscode.workspace.fs.readFile(uri));
    }
    const document = await vscode.workspace.openTextDocument(uri);
    const text = document.getText();
    if (Buffer.byteLength(text, 'utf8') > MAX_BYTES) throw new Error('单侧文件超过 8 MiB，请使用文本对比或缩小表格。');
    return text;
  }

  async function show(left, right, load, column = vscode.ViewColumn.Active) {
    const xlsx = isXLSX(left) || isXLSX(right);
    if (xlsx && !(isXLSX(left) && isXLSX(right))) throw new Error('请选择两个 XLSX 文件进行比较；暂不支持 XLSX 与 CSV 混合比较。');
    if (!xlsx && !isCSV(left) && !isCSV(right)) return vscode.commands.executeCommand('vscode.diff', left, right, `${label(left)} ↔ ${label(right)}`);
    let sources = [left, right];
    const comparison = createComparison({ xlsx, workbookReader: readWorkbook, getDefaults: () => settings(right) });
    let busy = false, disposed = false;
    const panel = vscode.window.createWebviewPanel('gridiff.diff', `Gridiff · ${label(right)}`, column, {
      enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'media')]
    });
    panels.set(panel, pairKey(...sources));
    const disposables = [];
    panel.onDidDispose(() => { disposed = true; panels.delete(panel); disposables.forEach(d => d.dispose()); });
    const payload = () => ({ type: 'comparison', ...comparison.snapshot(), busy,
      title: label(sources[1]), sources: sources.map(u => u.toString(true)) });
    const send = () => { if (!disposed) void panel.webview.postMessage(payload()); };
    async function refresh() {
      if (busy) return;
      busy = true; send();
      try {
        const texts = load ? await load() : await Promise.all(sources.map(read));
        if (disposed) return;
        const config = vscode.workspace.getConfiguration('gridiff', right);
        const mode = config.get('xlsxSheets', 'all');
        await comparison.load(texts, { mode, ...(mode === 'named' ? { names: config.get('xlsxSheetNames', []) } : {}) });
      }
      catch (e) { comparison.fail(e); }
      finally { busy = false; send(); }
    }
    async function chooseFormat() {
      const pick = await vscode.window.showQuickPick(Object.entries(formatNames).map(([value, title]) => ({ label: title, value })), { title: 'Gridiff · 表头格式', placeHolder: '两侧使用同一种表头配置' });
      if (!pick || disposed) return;
      const { options } = comparison.snapshot();
      const next = { ...options, format: pick.value };
      if (pick.value === 'custom') {
        for (const [name, prompt, fallback] of [['headerRow', '字段名所在记录（从 1 开始）', 1], ['dataStartRow', '数据起始记录（从 1 开始）', 2], ['descriptionRow', '中文说明所在记录（0 表示无）', 0]]) {
          const value = await vscode.window.showInputBox({ title: 'Gridiff · 自定义表头', prompt, value: String(options[name] ?? fallback),
            validateInput: v => /^\d+$/.test(v) && Number(v) >= (name === 'descriptionRow' ? 0 : 1) ? null : '请输入有效的记录编号' });
          if (value === undefined || disposed) return;
          next[name] = Number(value);
        }
      }
      comparison.update(next); send();
    }
    async function chooseKeys() {
      const mode = await vscode.window.showQuickPick([
        { label: '按主键对齐', description: '选择一个或多个字段', value: 'key' },
        { label: '按行号对齐', description: '插入或删除记录会影响后续对齐', value: 'position' },
        { label: '自动选择主键', description: 'Mova 竖表使用名称；其他表优先 id，否则第一列', value: 'auto' }
      ], { title: 'Gridiff · 记录对齐方式' });
      if (!mode || disposed) return;
      const { options, keyFields } = comparison.snapshot();
      if (mode.value === 'key') {
        if (!comparison.tables) throw new Error('请先选择能够解析两侧文件的表头格式。');
        const picks = await vscode.window.showQuickPick(keyFields.map(f => ({ label: f.name, description: f.label !== f.name ? f.label : undefined, picked: options.keyColumns?.includes(f.name) })), { canPickMany: true, title: 'Gridiff · 选择主键字段', placeHolder: '组合字段必须唯一且非空' });
        if (!picks || disposed) return;
        if (!picks.length) throw new Error('请至少选择一个字段。');
        comparison.update({ alignment: 'key', keyColumns: picks.map(p => p.label) });
      } else comparison.update({ alignment: mode.value === 'position' ? 'position' : 'key', keyColumns: [] });
      send();
    }
    disposables.push(panel.webview.onDidReceiveMessage(async message => {
      if (!message || typeof message.action !== 'string') return;
      try {
        if (message.action === 'ready') { send(); return; }
        if (busy) return;
        if (message.action === 'format') await chooseFormat();
        else if (message.action === 'keys') await chooseKeys();
        else if (message.action === 'refresh') await refresh();
        else if (message.action === 'sheet' && xlsx) {
          comparison.selectSheet(message.name); send();
        }
        else if (message.action === 'swap') {
          sources.reverse(); comparison.swap();
          panels.set(panel, pairKey(...sources));
          if (load) { const previous = load; load = async () => (await previous()).reverse(); }
          panel.title = `Gridiff · ${label(sources[1])}`; send();
        } else if (message.action === 'native' && !xlsx) await showNative(...sources);
      } catch (e) { report(e); }
    }));
    panel.webview.html = webviewHTML(panel.webview, context.extensionUri);
    await refresh();
    return panel;
  }

  register('gridiff.openDiff', async () => {
    const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
    if (!(input instanceof vscode.TabInputTextDiff)) throw new Error('请先打开一个文本差异页，或使用“Gridiff: 比较两个文件”。');
    await openDiffTab(activeTab());
  });
  register('gridiff.compareFiles', async (uri, selected) => {
    let pair = Array.isArray(selected) && selected.length === 2 ? selected : null;
    if (!pair) {
      const left = await vscode.window.showOpenDialog({ title: 'Gridiff · 选择旧版本', canSelectMany: false, canSelectFolders: false });
      if (!left?.length) return;
      const right = await vscode.window.showOpenDialog({ title: 'Gridiff · 选择新版本', canSelectMany: false, canSelectFolders: false });
      if (!right?.length) return;
      pair = [left[0], right[0]];
    }
    await show(...pair);
  });
  register('gridiff.selectLeft', async uri => {
    selectedLeft = currentUri(uri);
    if (!selectedLeft) throw new Error('请先选择一个文件。');
    await vscode.commands.executeCommand('setContext', 'gridiff.hasLeft', true);
    vscode.window.setStatusBarMessage(`Gridiff 旧版本：${label(selectedLeft)}`, 5000);
  });
  register('gridiff.compareSelected', async uri => {
    const right = currentUri(uri);
    if (!selectedLeft || !right) throw new Error('请先选择旧版本和要比较的文件。');
    await show(selectedLeft, right);
  });
  register('gridiff.compareHead', async uri => {
    const right = currentUri(uri);
    if (!right || right.scheme !== 'file') throw new Error('请选择本地 Git 仓库中的文件。');
    const extension = vscode.extensions.getExtension('vscode.git');
    if (!extension) throw new Error('请启用 VS Code 内置 Git 扩展。');
    const git = (await extension.activate()).getAPI(1);
    const repository = git.getRepository(right);
    if (!repository) throw new Error('未找到文件所属的 Git 仓库，请在 VS Code 中打开该仓库。');
    const left = git.toGitUri(right, 'HEAD');
    // Resolve HEAD explicitly: the Git filesystem can return empty text for a missing ref.
    await show(left, right, async () => [isXLSX(right) ? await readHeadWorkbook(git, repository, right) : await repository.show('HEAD', right.fsPath), await read(right)]);
  });
  context.subscriptions.push(
    vscode.window.tabGroups.onDidChangeTabs(event => {
      for (const tab of event.closed) tabViews.delete(tab);
      autoOpen();
    }),
    vscode.window.tabGroups.onDidChangeTabGroups(autoOpen),
    vscode.workspace.onDidChangeConfiguration(event => { if (event.affectsConfiguration('gridiff.autoOpenDiff')) autoOpen(); }),
    { dispose: () => { stopped = true; for (const panel of panels.keys()) panel.dispose(); } }
  );
  autoOpen();
}

module.exports = { activate };
