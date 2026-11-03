'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const Zip = require('jszip');
const { packageSkill } = require('../scripts/build-skill');

function fixture(t, target) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiff-skill-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'gridiff', version: '0.1.17' }));
  const source = path.join(root, 'skills', 'gridiff');
  fs.mkdirSync(path.join(source, 'references'), { recursive: true });
  fs.writeFileSync(path.join(source, 'SKILL.md'), '---\nname: gridiff\ndescription: Compare tables.\n---\nUse the bundled CLI.\n');
  fs.writeFileSync(path.join(source, 'references', 'git.md'), 'Prepare old and new snapshots.\n');
  const filename = target.startsWith('windows-') ? 'gridiff.exe' : 'gridiff';
  const directory = path.join(root, 'dist', 'cli', `gridiff-${target}`);
  fs.mkdirSync(directory, { recursive: true });
  const output = path.join(directory, filename), bytes = Buffer.from('standalone executable');
  fs.writeFileSync(output, bytes);
  fs.writeFileSync(path.join(directory, 'LICENSES.txt'), 'All required notices.\n');
  const build = { output, name: 'gridiff', version: '0.1.17', target, size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), sourceCommit: 'a'.repeat(40), sourceDirty: true };
  fs.writeFileSync(output + '.json', JSON.stringify(build));
  return { root, build, bytes, filename };
}

test('skill package carries its own matching CLI, references and notices', async t => {
  for (const target of ['darwin-arm64', 'windows-x64']) {
    const { root, build, bytes, filename } = fixture(t, target);
    const result = await packageSkill(build, { root });
    const zip = await Zip.loadAsync(fs.readFileSync(result.archive));
    assert.deepEqual(await zip.file(`gridiff/bin/${filename}`).async('nodebuffer'), bytes);
    assert.match(await zip.file('gridiff/SKILL.md').async('string'), /name: gridiff/);
    assert.equal(await zip.file('gridiff/references/git.md').async('string'), 'Prepare old and new snapshots.\n');
    assert.equal(await zip.file('gridiff/LICENSES.txt').async('string'), 'All required notices.\n');
    const receipt = JSON.parse(await zip.file(`gridiff/bin/${filename}.json`).async('string'));
    assert.equal(receipt.sha256, build.sha256);
    assert.equal(receipt.version, build.version);
    if (!target.startsWith('windows-')) assert.equal(zip.file(`gridiff/bin/${filename}`).unixPermissions & 0o777, 0o755);
    assert.deepEqual(fs.readFileSync(path.join(result.directory, 'bin', filename)), bytes);
  }
});

test('skill packaging rejects a changed binary or wrong version', async t => {
  const { root, build } = fixture(t, 'linux-x64');
  fs.appendFileSync(build.output, 'changed');
  await assert.rejects(() => packageSkill(build, { root }), /哈希|校验|制品/);
  const next = fixture(t, 'linux-arm64');
  next.build.version = '0.0.0';
  fs.writeFileSync(next.build.output + '.json', JSON.stringify(next.build));
  await assert.rejects(() => packageSkill(next.build, { root: next.root }), /版本|校验|制品/);
});
