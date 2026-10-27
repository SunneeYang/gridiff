'use strict';
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');
const vscode = require('vscode');
const { workbook } = require('../xlsx-fixtures');
const { readHeadWorkbook } = require('../../src/git');
const { readWorkbook, worksheetTable } = require('../../src/xlsx');
const { compareTables } = require('../../src/diff');

async function waitForTab(Type) {
  for (let i = 0; i < 200; i++) {
    if (vscode.window.tabGroups.activeTabGroup.activeTab?.input instanceof Type) return;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
  const names = [vscode.TabInputTextDiff, vscode.TabInputWebview];
  const labels = ['TabInputTextDiff', 'TabInputWebview'];
  assert.fail(`Expected ${labels[names.indexOf(Type)] || Type.name}; got ${labels[names.findIndex(type => input instanceof type)] || input?.constructor.name}`);
}

async function run() {
  const extension = vscode.extensions.getExtension('sunneeyang.gridiff');
  assert.ok(extension, 'Gridiff extension is discoverable');
  const left = vscode.Uri.file(path.join(__dirname, '../fixtures/before.csv'));
  const right = vscode.Uri.file(path.join(__dirname, '../fixtures/after.csv'));
  const tabs = () => vscode.window.tabGroups.all.flatMap(group => group.tabs);
  const sourceTab = () => tabs().find(tab => tab.input instanceof vscode.TabInputTextDiff && tab.input.original.toString() === left.toString() && tab.input.modified.toString() === right.toString());
  await vscode.commands.executeCommand('vscode.diff', left, right, 'Gridiff auto-open test', { preview: true });
  await waitForTab(vscode.TabInputWebview);
  assert.ok(extension.isActive, 'startup activation needs no manual Gridiff command');
  assert.ok((await vscode.commands.getCommands(true)).includes('gridiff.openDiff'));
  assert.ok(sourceTab(), 'original diff remains open for --wait');
  assert.equal(sourceTab().isPreview, false, 'source preview is pinned before the webview opens');
  assert.equal(tabs().filter(tab => tab.input instanceof vscode.TabInputWebview).length, 1);
  await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
  await waitForTab(vscode.TabInputTextDiff);
  await new Promise(resolve => setTimeout(resolve, 200));
  assert.ok(vscode.window.tabGroups.activeTabGroup.activeTab.input instanceof vscode.TabInputTextDiff, 'closing Gridiff does not reopen it');
  await vscode.window.tabGroups.close(sourceTab());
  await vscode.commands.executeCommand('vscode.diff', left, right, 'Gridiff reopen test');
  await waitForTab(vscode.TabInputWebview);
  await vscode.workspace.getConfiguration('gridiff').update('autoOpenDiff', false, vscode.ConfigurationTarget.Global);
  await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  await vscode.commands.executeCommand('vscode.diff', left, right, 'Gridiff manual test');
  await waitForTab(vscode.TabInputTextDiff);
  await new Promise(resolve => setTimeout(resolve, 200));
  assert.equal(tabs().filter(tab => tab.input instanceof vscode.TabInputWebview).length, 0);
  await vscode.commands.executeCommand('gridiff.openDiff');
  await waitForTab(vscode.TabInputWebview);
  await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
  await vscode.commands.executeCommand('gridiff.compareFiles', left, [left, right]);
  await waitForTab(vscode.TabInputWebview);
  await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
  const text = vscode.Uri.file(path.join(__dirname, '../../README.md'));
  await vscode.commands.executeCommand('gridiff.compareFiles', text, [text, text]);
  await waitForTab(vscode.TabInputTextDiff);
  const repoPath = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiff-host-'));
  const file = path.join(repoPath, 'sample.csv');
  try {
    const gitCommand = (...args) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', ...args], { cwd: repoPath, stdio: 'pipe' });
    gitCommand('init', '-b', 'main');
    fs.writeFileSync(file, 'id,v\n1,before'); gitCommand('add', 'sample.csv');
    gitCommand('-c', 'user.name=Gridiff Test', '-c', 'user.email=gridiff@example.invalid', 'commit', '-m', 'Test fixture');
    fs.writeFileSync(file, 'id,v\n1,after');
    const git = (await vscode.extensions.getExtension('vscode.git').activate()).getAPI(1);
    const repository = await git.openRepository(vscode.Uri.file(repoPath));
    assert.ok(repository);
    assert.equal(await repository.show('HEAD', file), 'id,v\n1,before');
    const gitUri = git.toGitUri(vscode.Uri.file(file), 'HEAD');
    assert.equal((await vscode.workspace.openTextDocument(gitUri)).getText(), 'id,v\n1,before');
    await vscode.commands.executeCommand('gridiff.compareHead', vscode.Uri.file(file));
    await waitForTab(vscode.TabInputWebview);
    await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
    const bookFile = path.join(repoPath, 'sample.xlsx'), bookUri = vscode.Uri.file(bookFile);
    const oldBook = await workbook({ Data: [['id', 'v'], ['1', { formula: '1+1', result: 2 }]], Removed: [['id'], ['x']] });
    fs.writeFileSync(bookFile, oldBook);
    fs.writeFileSync(path.join(repoPath, '.gitattributes'), '*.xlsx diff=xlsx\n');
    gitCommand('config', 'diff.xlsx.textconv', 'echo converted');
    gitCommand('add', 'sample.xlsx', '.gitattributes');
    gitCommand('-c', 'user.name=Gridiff Test', '-c', 'user.email=gridiff@example.invalid', 'commit', '-m', 'XLSX fixture');
    const newBook = await workbook({ Data: [['id', 'v'], ['1', { formula: '2*1', result: 2 }]], Added: [['id'], ['y']] });
    fs.writeFileSync(bookFile, newBook);
    assert.deepEqual(await readHeadWorkbook(git, repository, bookUri), oldBook, 'HEAD returns unconverted XLSX bytes');
    const before = await readWorkbook(await readHeadWorkbook(git, repository, bookUri));
    const after = await readWorkbook(await vscode.workspace.fs.readFile(bookUri));
    assert.equal(compareTables(worksheetTable(before[0]), worksheetTable(after[0])).counts.modified, 0);
    await vscode.commands.executeCommand('gridiff.compareHead', bookUri);
    await waitForTab(vscode.TabInputWebview);
    await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
    const oldFile = path.join(repoPath, 'old.xlsx'); fs.writeFileSync(oldFile, oldBook);
    await vscode.commands.executeCommand('gridiff.compareFiles', bookUri, [vscode.Uri.file(oldFile), bookUri]);
    await waitForTab(vscode.TabInputWebview);
    await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    await vscode.workspace.getConfiguration('gridiff').update('autoOpenDiff', true, vscode.ConfigurationTarget.Global);
    await vscode.commands.executeCommand('vscode.diff', vscode.Uri.file(oldFile), bookUri, 'Fork XLSX diff', { preview: true });
    await waitForTab(vscode.TabInputWebview);
    const binaryTab = tabs().find(tab => tab.input instanceof vscode.TabInputTextDiff && tab.input.original.fsPath === oldFile && tab.input.modified.fsPath === bookFile);
    assert.ok(binaryTab, 'binary diff exposes both file URIs through TabInputTextDiff');
    assert.equal(binaryTab.isPreview, false, 'binary source remains pinned');
    await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
    await waitForTab(vscode.TabInputTextDiff);
    await new Promise(resolve => setTimeout(resolve, 300));
    assert.equal(tabs().filter(tab => tab.input instanceof vscode.TabInputWebview).length, 0, `XLSX close does not bounce: ${JSON.stringify(tabs().map(tab => ({ label: tab.label, active: tab.isActive, type: tab.input.constructor.name, original: tab.input.original?.path, modified: tab.input.modified?.path })))}`);
    const resolvedBinaryTab = tabs().find(tab => tab.input instanceof vscode.TabInputTextDiff && tab.input.original.fsPath === oldFile && tab.input.modified.fsPath === bookFile);
    assert.ok(resolvedBinaryTab, 'the binary replacement remains open after dismissing Gridiff');
    await vscode.window.tabGroups.close(resolvedBinaryTab);
  } finally { fs.rmSync(repoPath, { recursive: true, force: true }); }
  console.log('GRIDiff_HOST_TESTS_PASSED: CSV startup, manual commands, native fallback, Git HEAD; XLSX files, formula comparison and binary HEAD bypassing textconv');
  if (process.env.GRIDIFF_HOST_REPORT) fs.writeFileSync(process.env.GRIDIFF_HOST_REPORT, JSON.stringify({
    passed: true, vscode: vscode.version, xlsx: ['two files', 'formula comparison', 'HEAD ignores textconv', 'auto-open binary diff'], time: new Date().toISOString()
  }, null, 2));
}
module.exports = { run: async () => {
  try { await run(); }
  catch (error) {
    if (process.env.GRIDIFF_HOST_REPORT) fs.writeFileSync(process.env.GRIDIFF_HOST_REPORT, JSON.stringify({ passed: false, error: error.message, vscode: vscode.version,
      tabs: vscode.window.tabGroups.all.flatMap(group => group.tabs).map(tab => ({ label: tab.label, active: tab.isActive, type: tab.input.constructor.name, original: tab.input.original?.path, modified: tab.input.modified?.path })) }));
    throw error;
  }
} };
