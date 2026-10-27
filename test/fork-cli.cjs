'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check) {
  for (let i = 0; i < 300; i++) { if (check()) return; await sleep(100); }
  assert.fail('Timed out waiting for Fork CLI test phase');
}

// Runs in the extension host opened by the actual --wait --diff invocation.
async function run() {
  const vscode = require('vscode'), state = process.env.GRIDIFF_FORK_STATE;
  const write = phase => fs.writeFileSync(state, phase);
  try {
    await until(() => vscode.window.tabGroups.activeTabGroup.activeTab?.input instanceof vscode.TabInputWebview);
    const source = vscode.window.tabGroups.all.flatMap(group => group.tabs).find(tab => tab.input instanceof vscode.TabInputTextDiff);
    assert.ok(source); assert.equal(source.isPreview, false);
    write('grid-open');
    await until(() => fs.readFileSync(state, 'utf8') === 'close-grid');
    await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
    await sleep(300);
    const resolved = vscode.window.tabGroups.activeTabGroup.activeTab;
    assert.ok(resolved.input instanceof vscode.TabInputTextDiff);
    assert.equal(resolved.input.original.toString(), source.input.original.toString());
    assert.equal(resolved.input.modified.toString(), source.input.modified.toString());
    write('grid-closed');
    await until(() => fs.readFileSync(state, 'utf8') === 'close-source');
    await vscode.window.tabGroups.close(resolved);
    write('source-closed');
    await until(() => fs.readFileSync(state, 'utf8') === 'finish');
    write('passed');
  } catch (error) { write(`failed: ${error.message}`); throw error; }
}

async function main() {
  assert.ok(process.env.CODEX_AGENT_TMP, 'Run with agent-tmp-run');
  const root = path.resolve(__dirname, '..'), temp = process.env.CODEX_AGENT_TMP;
  const state = path.join(temp, 'fork-state'), userData = path.join(temp, 'vscode-user');
  const { workbook } = require('./xlsx-fixtures');
  const files = ['old.xlsx', 'new.xlsx'].map(name => path.join(temp, name));
  fs.writeFileSync(files[0], await workbook({ Data: [['id', 'v'], ['1', 'old']] }));
  fs.writeFileSync(files[1], await workbook({ Data: [['id', 'v'], ['1', 'new']] }));
  fs.writeFileSync(state, 'starting');
  const log = fs.openSync(path.join(root, 'dist/xlsx-cli-test.log'), 'w');
  const cli = spawn('/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code', [
    '--new-window', '--user-data-dir', userData, '--extensions-dir', path.join(temp, 'extensions'),
    '--extensionDevelopmentPath', root, '--extensionTestsPath', __filename,
    '--skip-welcome', '--skip-release-notes', '--disable-workspace-trust', '--disable-extensions', '--wait', '--diff', ...files
  ], { env: { ...process.env, GRIDIFF_FORK_STATE: state }, stdio: ['ignore', log, log] });
  let exited = false, exitCode;
  cli.on('close', code => { exited = true; exitCode = code; });
  cli.on('error', error => { exited = true; exitCode = error.message; });
  const phase = () => {
    const value = fs.readFileSync(state, 'utf8');
    assert.ok(!value.startsWith('failed:'), value); return value;
  };
  try {
    await until(() => phase() === 'grid-open'); assert.equal(exited, false);
    fs.writeFileSync(state, 'close-grid');
    await until(() => phase() === 'grid-closed'); await sleep(300);
    assert.equal(exited, false, '--wait must survive closing only Gridiff');
    fs.writeFileSync(state, 'close-source');
    await until(() => phase() === 'source-closed');
    await until(() => exited); assert.equal(exitCode, 0, '--wait must finish after closing the source diff');
    fs.writeFileSync(state, 'finish');
    await until(() => phase() === 'passed');
    fs.writeFileSync(path.join(root, 'dist/xlsx-cli-result.json'), JSON.stringify({ passed: true, autoOpen: true, waitUntilSourceClosed: true, time: new Date().toISOString() }, null, 2));
    console.log('Fork CLI passed: XLSX --wait --diff auto-opens Gridiff and waits for the source tab to close.');
    await sleep(1000);
  } finally {
    if (!exited) cli.kill();
    fs.closeSync(log);
  }
}

module.exports = { run };
if (require.main === module) main().catch(error => { console.error(error); process.exitCode = 1; });
