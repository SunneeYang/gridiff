'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { syncProject } = require('../scripts/sync-project');

const targets = ['darwin-arm64', 'darwin-x64', 'linux-arm64', 'linux-x64', 'windows-x64'];
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const sourceCommit = 'a'.repeat(40);

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'gridiff-sync-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const root = path.join(directory, 'source'), project = path.join(directory, 'design with spaces');
  fs.mkdirSync(path.join(root, 'launchers'), { recursive: true }); fs.mkdirSync(project);
  fs.cpSync(path.join(__dirname, '..', 'docs', 'guide'), path.join(root, 'docs', 'guide'), { recursive: true });
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'gridiff', publisher: 'sunneeyang', version: '0.1.14' }));
  for (const name of ['gridiff', 'gridiff.cmd']) fs.copyFileSync(path.join(__dirname, '..', 'launchers', name), path.join(root, 'launchers', name));
  for (const target of targets) {
    const output = path.join(root, 'dist', 'cli', `gridiff-${target}`);
    const filename = target.startsWith('windows') ? 'gridiff.exe' : 'gridiff';
    fs.mkdirSync(output, { recursive: true });
    const bytes = Buffer.from(`#!/bin/sh\nprintf '%s\\n' '${target}'\nprintf '<%s>\\n' "$@"\nexit 7\n`);
    fs.writeFileSync(path.join(output, filename), bytes);
    fs.writeFileSync(path.join(output, `${filename}.json`), JSON.stringify({ name: 'gridiff', publisher: 'sunneeyang', version: '0.1.14', target,
      sourceCommit, sourceDirty: true, buildInputsSha256: 'b'.repeat(64), runtime: 'go version test', size: bytes.length, sha256: hash(bytes) }));
    fs.writeFileSync(path.join(output, 'LICENSES.txt'), 'Gridiff\nPermission is hereby granted\nGo standard library and runtime\nAll package notices.\n');
  }
  const invoke = apply => syncProject(['--project', project, ...(apply ? ['--apply'] : [])], { root, log: () => {} });
  return { directory, root, project, destination: path.join(project, 'gridiff'), invoke };
}

function sourcePaths(root, target) {
  const directory = path.join(root, 'dist', 'cli', `gridiff-${target}`), filename = target.startsWith('windows') ? 'gridiff.exe' : 'gridiff';
  return { directory, binary: path.join(directory, filename), receipt: path.join(directory, `${filename}.json`) };
}

test('sync is a complete read-only preflight by default and records dirty build provenance', t => {
  const { project, destination, invoke } = fixture(t);
  fs.writeFileSync(path.join(project, 'keep.txt'), 'existing user file');
  const before = fs.readdirSync(project);
  const result = invoke(false);
  assert.equal(result.applied, false);
  assert.equal(fs.existsSync(destination), false);
  assert.deepEqual(fs.readdirSync(project), before);
  assert.equal(result.manifest.name, 'gridiff');
  assert.equal(result.manifest.sourceCommit, sourceCommit);
  assert.equal(result.manifest.sourceDirty, true);
  assert.equal(result.manifest.builds.length, 5);
});

test('sync installs all platform binaries, launchers and nested LFS rules; unknown files survive updates', t => {
  const { destination, invoke } = fixture(t);
  const result = invoke(true);
  assert.equal(result.applied, true);
  for (const build of result.manifest.builds) assert.equal(hash(fs.readFileSync(path.join(destination, build.path))), build.sha256);
  const attributes = fs.readFileSync(path.join(destination, '.gitattributes'), 'utf8');
  assert.match(attributes, /\/bin\/\*\*\/gridiff filter=lfs diff=lfs merge=lfs -text/);
  assert.match(attributes, /gridiff\.exe filter=lfs/);
  assert.match(attributes, /\/gridiff text eol=lf/);
  assert.match(attributes, /gridiff\.cmd text eol=crlf/);
  assert.equal(fs.existsSync(path.join(path.dirname(destination), '.gitattributes')), false);
  const cmd = fs.readFileSync(path.join(destination, 'gridiff.cmd'), 'utf8');
  assert.ok(cmd.includes('\r\n'));
  assert.equal(cmd.replaceAll('\r\n', '').includes('\n'), false);
  assert.ok(cmd.includes('"%gridiff_binary%" %*'));
  assert.ok(cmd.includes('setlocal DisableDelayedExpansion'));
  assert.ok(cmd.includes('Windows ARM64 native build is not available'));
  assert.match(fs.readFileSync(path.join(destination, 'README.md'), 'utf8'), /含未提交修改的本地开发构建/);
  const readme = fs.readFileSync(path.join(destination, 'README.md'), 'utf8');
  assert.ok(readme.includes('Arguments 设置为 `$REMOTE $LOCAL`'));
  assert.ok(readme.includes('第一文件作为旧版本、第二文件作为新版本'));
  assert.ok(readme.includes('不根据路径或内容猜方向'));
  assert.ok(readme.includes('guide/index.html'));
  for (const name of ['index.html', 'guide.css', 'guide.js', 'theme.js', 'tokens.css', 'assets/fork-custom-default.png', 'assets/gridiff-example.png']) {
    assert.equal(hash(fs.readFileSync(path.join(destination, 'guide', name))), result.manifest.files[`guide/${name}`].sha256);
  }
  if (process.platform !== 'win32') assert.equal(fs.statSync(path.join(destination, 'gridiff')).mode & 0o777, 0o755);
  fs.writeFileSync(path.join(destination, 'my-notes.txt'), 'keep me');
  invoke(true);
  assert.equal(fs.readFileSync(path.join(destination, 'my-notes.txt'), 'utf8'), 'keep me');
  assert.equal(fs.readdirSync(destination).some(name => name.startsWith('.gridiff-sync-')), false);
});

test('a bad last package, mixed version, or incomplete license cannot cause a partial write', t => {
  for (const problem of ['hash', 'version', 'license', 'identity', 'source', 'inputs', 'missing-inputs']) {
    const { root, destination, invoke } = fixture(t);
    const files = sourcePaths(root, targets.at(-1));
    if (problem === 'hash') fs.appendFileSync(files.binary, 'corruption');
    else if (problem === 'license') fs.writeFileSync(path.join(files.directory, 'LICENSES.txt'), 'missing notices');
    else {
      const receipt = JSON.parse(fs.readFileSync(files.receipt));
      if (problem === 'version') receipt.version = '0.1.13';
      if (problem === 'identity') receipt.publisher = 'other';
      if (problem === 'source') receipt.sourceDirty = false;
      if (problem === 'inputs') receipt.buildInputsSha256 = 'c'.repeat(64);
      if (problem === 'missing-inputs') delete receipt.buildInputsSha256;
      fs.writeFileSync(files.receipt, JSON.stringify(receipt));
    }
    assert.throws(() => invoke(true), /不符|不完整|不一致/);
    assert.equal(fs.existsSync(destination), false, problem);
  }
});

test('manual edits to managed files are preserved and stop the whole update before writing', t => {
  const { root, destination, invoke } = fixture(t);
  invoke(true);
  const original = fs.readFileSync(path.join(destination, 'bin/darwin-arm64/gridiff'));
  fs.writeFileSync(path.join(destination, 'README.md'), 'handwritten guidance');
  const files = sourcePaths(root, 'darwin-arm64');
  const bytes = Buffer.from('new build');
  fs.writeFileSync(files.binary, bytes);
  const receipt = JSON.parse(fs.readFileSync(files.receipt)); receipt.sha256 = hash(bytes); receipt.size = bytes.length;
  fs.writeFileSync(files.receipt, JSON.stringify(receipt));
  assert.throws(() => invoke(true), /手工修改/);
  assert.deepEqual(fs.readFileSync(path.join(destination, 'bin/darwin-arm64/gridiff')), original);
  assert.equal(fs.readFileSync(path.join(destination, 'README.md'), 'utf8'), 'handwritten guidance');
});

test('an incomplete guide stops synchronization before writing any target file', t => {
  const { root, destination, invoke } = fixture(t);
  fs.unlinkSync(path.join(root, 'docs', 'guide', 'assets', 'gridiff-example.png'));
  assert.throws(() => invoke(true), /ENOENT/);
  assert.equal(fs.existsSync(destination), false);
});

test('source and destination symlink paths are rejected without touching the linked files', { skip: process.platform === 'win32' }, t => {
  for (const kind of ['source', 'destination']) {
    const { root, project, destination, invoke } = fixture(t);
    const outside = path.join(project, 'unrelated'); fs.mkdirSync(outside);
    if (kind === 'source') {
      const files = sourcePaths(root, 'linux-arm64'), saved = path.join(outside, 'binary');
      fs.renameSync(files.binary, saved); fs.symlinkSync(saved, files.binary);
    } else {
      fs.mkdirSync(path.join(destination, 'bin'), { recursive: true });
      fs.symlinkSync(outside, path.join(destination, 'bin', 'linux-x64'));
    }
    const before = fs.readdirSync(outside);
    assert.throws(() => invoke(true), /符号链接/);
    assert.deepEqual(fs.readdirSync(outside), before);
    assert.equal(fs.existsSync(path.join(destination, 'manifest.json')), false);
  }
});

test('POSIX launcher selects the CPU and preserves quoted arguments without Node; LFS and mode errors are actionable', { skip: process.platform === 'win32' }, t => {
  const { directory, destination, invoke } = fixture(t);
  invoke(true);
  const bin = path.join(directory, 'commands'); fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'uname'), '#!/bin/sh\ncase "$1" in -s) printf "Linux\\n";; -m) printf "x86_64\\n";; esac\n', { mode: 0o755 });
  const entry = path.join(destination, 'gridiff');
  const args = ['old file $LOCAL.csv', 'new "quoted" & name.xlsx'];
  const options = { encoding: 'utf8', env: { ...process.env, PATH: `${bin}:/usr/bin:/bin` } };
  const result = spawnSync(entry, args, options);
  assert.equal(result.status, 7, result.stderr);
  assert.equal(result.stdout, 'linux-x64\n' + args.map(arg => `<${arg}>\n`).join(''));
  const executable = path.join(destination, 'bin/linux-x64/gridiff');
  fs.writeFileSync(executable, 'version https://git-lfs.github.com/spec/v1\noid sha256:abc\nsize 123\n');
  const pointer = spawnSync(entry, args, options);
  assert.equal(pointer.status, 1);
  assert.match(pointer.stderr, /git lfs pull/);
  fs.writeFileSync(executable, '#!/bin/sh\nexit 0\n'); fs.chmodSync(executable, 0o644);
  const permissions = spawnSync(entry, args, options);
  assert.equal(permissions.status, 1);
  assert.match(permissions.stderr, /chmod \+x/);
});
