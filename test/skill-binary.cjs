'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const Zip = require('jszip');
const { workbook } = require('./xlsx-fixtures');
const managedDirectories = [];

async function main() {
  assert.ok(process.env.CODEX_AGENT_TMP, 'Run with agent-tmp-run so installed fixtures and reports are removed.');
  const temporary = fs.mkdtempSync(path.join(process.env.CODEX_AGENT_TMP, 'skill-binary-'));
  const target = `${process.platform === 'win32' ? 'windows' : process.platform}-${process.arch}`;
  const archive = process.argv[2] || path.join(__dirname, '..', 'dist', 'skills', `gridiff-${target}.zip`);
  const zip = await Zip.loadAsync(fs.readFileSync(archive));
  for (const entry of Object.values(zip.files)) {
    assert.ok(entry.name.startsWith('gridiff/') && !entry.name.split('/').includes('..'), 'invalid package path');
    if (entry.dir) continue;
    const output = path.join(temporary, entry.name);
    fs.mkdirSync(path.dirname(output), { recursive: true });
    fs.writeFileSync(output, await entry.async('nodebuffer'), { mode: entry.unixPermissions & 0o777 || 0o644 });
  }
  const installed = path.join(temporary, 'gridiff');
  const manifest = JSON.parse(fs.readFileSync(path.join(installed, 'manifest.json'), 'utf8'));
  for (const [name, expected] of Object.entries(manifest.files)) {
    assert.equal(createHash('sha256').update(fs.readFileSync(path.join(installed, name))).digest('hex'), expected);
  }
  const binary = path.join(installed, manifest.cli);
  const runtime = path.join(temporary, 'instances');
  const env = { ...process.env, GRIDIFF_RUNTIME_DIR: runtime, PATH: process.platform === 'win32' ? process.env.SystemRoot : '/usr/bin:/bin' };
  const invoke = (args, status = 0) => {
    const result = spawnSync(binary, args, { cwd: temporary, env, encoding: 'utf8', timeout: 30000 });
    assert.equal(result.status, status, result.error?.message || result.stderr);
    assert.doesNotMatch(result.stdout, /http:\/\//);
    return result;
  };
  assert.equal(invoke(['--version']).stdout.trim(), manifest.version);
  const compare = (before, after, extra = [], status = 0) => {
    const directory = fs.mkdtempSync(path.join(temporary, 'report-'));
    const output = path.join(directory, '完整 报告.json');
    invoke(['--output', output, ...extra, before, after], status);
    return JSON.parse(fs.readFileSync(output, 'utf8'));
  };
  const compareTemporary = (before, after, status = 0) => {
    const output = invoke(['--temp-output', before, after], status).stdout.trim();
    const cache = process.platform === 'darwin' ? path.join(os.homedir(), 'Library', 'Caches') : process.platform === 'win32' ? process.env.LocalAppData : process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache');
    assert.equal(path.dirname(path.dirname(output)), path.join(cache, 'gridiff', 'reports'));
    assert.equal(path.basename(output), 'report.json');
    assert.match(path.basename(path.dirname(output)), /^report-/);
    managedDirectories.push(path.dirname(output));
    return JSON.parse(fs.readFileSync(output, 'utf8'));
  };
  let before = path.join(temporary, 'old.csv'), after = path.join(temporary, 'new.csv');
  fs.writeFileSync(before, 'id,value\n' + Array.from({ length: 20000 }, (_, i) => `${String(i).padStart(6, '0')},old`).join('\n'));
  fs.writeFileSync(after, 'id,value\n' + Array.from({ length: 20000 }, (_, i) => `${String(i).padStart(6, '0')},new`).join('\n'));
  let report = compareTemporary(before, after);
  assert.equal(report.complete, true);
  assert.equal(report.counts.modified, 20000);
  assert.equal(report.sheets[0].result.rows.length, 20000);
  const last = report.sheets[0].result.rows[19999];
  assert.equal(last.identity, '019999');
  assert.equal(last.cells[1].before, 'old');
  assert.equal(last.cells[1].after, 'new');

  before = path.join(temporary, 'old.xlsx'); after = path.join(temporary, 'new.xlsx');
  fs.writeFileSync(before, await workbook({ Data: [['id', 'value'], ['001', { formula: '2+2', result: 4 }]], Other: [['id', 'value'], ['2', 'old']] }));
  fs.writeFileSync(after, await workbook({ Data: [['id', 'value'], ['001', { formula: '3+3', result: 6 }]], Other: [['id', 'value'], ['2', 'new']] }));
  report = compare(before, after);
  assert.equal(report.counts.modified, 1);
  assert.deepEqual(report.sourceSheets, [['Data'], ['Data']]);
  assert.equal(report.sheets[0].result.rows[0].cells[1].beforeMeta.raw, 4);
  assert.equal(report.sheets[0].result.rows[0].cells[1].afterMeta.raw, 6);
  assert.equal(compare(before, after, ['--sheets', 'all']).counts.modified, 2);
  assert.equal(compare(before, before).counts.unchanged, 1);
  fs.writeFileSync(after, await workbook({ Data: [['id', 'value'], ['001', 6]], Other: [['id', 'value'], ['2', 'a'], ['2', 'b']] }));
  report = compare(before, after, ['--sheets', 'all'], 1);
  assert.equal(report.complete, false);
  assert.equal(report.counts, undefined);
  assert.ok(report.sheets.find(sheet => sheet.name === 'Data').result);
  assert.ok(report.sheets.find(sheet => sheet.name === 'Other').error.length > 0);

  before = path.join(temporary, 'duplicate.csv'); after = path.join(temporary, 'valid.csv');
  fs.writeFileSync(before, 'id,value\n1,a\n1,b'); fs.writeFileSync(after, 'id,value\n1,c');
  report = compare(before, after, [], 1);
  assert.equal(report.complete, false);
  assert.ok(report.error.length > 0);
  assert.equal(report.counts, undefined);
  assert.equal(compareTemporary(before, after, 1).complete, false);
  const original = fs.readFileSync(before);
  invoke(['--output', before, before, after], 1);
  assert.deepEqual(fs.readFileSync(before), original);
  assert.equal(fs.existsSync(runtime), false, 'file reports must not start a browser service');
  console.log('Installed skill passed: native managed cache paths, 20000 changes read after process exit, persistent reports, first/all sheets, formula caches, failure report paths, input protection and no service.');
}

main().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => {
  for (const directory of managedDirectories) fs.rmSync(directory, { recursive: true, force: true });
});
