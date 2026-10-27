'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { readHeadWorkbook } = require('../src/git');
const { workbook } = require('./xlsx-fixtures');

test('HEAD workbook reads the exact binary blob and validates size before spawning Git', async () => {
  const dir = fs.mkdtempSync(path.join(process.env.CODEX_AGENT_TMP || os.tmpdir(), 'gridiff-git-'));
  try {
    execFileSync('git', ['init', '-q', dir]);
    const buffer = await workbook({ Data: [['id'], ['001']] });
    const hash = execFileSync('git', ['hash-object', '-w', '--stdin'], { cwd: dir, input: buffer, encoding: 'utf8' }).trim();
    let details = { object: hash, size: buffer.length };
    const repository = { rootUri: { fsPath: dir }, getObjectDetails: async (ref, file) => {
      assert.equal(ref, 'HEAD'); assert.equal(file, '/sample.xlsx'); return details;
    } };
    const git = { git: { path: 'git' } }, uri = { fsPath: '/sample.xlsx' };
    assert.deepEqual(await readHeadWorkbook(git, repository, uri), buffer);
    details = { object: 'not-a-hash', size: 1 };
    await assert.rejects(readHeadWorkbook(git, repository, uri), /对象无效/);
    details = { object: hash, size: 8 * 1024 * 1024 + 1 };
    await assert.rejects(readHeadWorkbook(git, repository, uri), /8 MiB/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
