'use strict';
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');
const vscode = require('vscode');

async function waitForTab(Type) {
  for (let i = 0; i < 200; i++) {
    if (vscode.window.tabGroups.activeTabGroup.activeTab?.input instanceof Type) return;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.fail(`Expected ${Type.name}; got ${vscode.window.tabGroups.activeTabGroup.activeTab?.input?.constructor.name}`);
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
  } finally { fs.rmSync(repoPath, { recursive: true, force: true }); }
  console.log('GRIDiff_HOST_TESTS_PASSED: startup auto-open, pinned source diff, no bounce, reopening, setting toggle, manual commands, native fallback, Git HEAD and git URI');
}
module.exports = { run };
