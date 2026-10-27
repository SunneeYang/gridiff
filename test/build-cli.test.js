'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { buildInputsHash, packageDirectories, collectNotices } = require('../scripts/build-cli');

test('build fingerprint changes with embedded data or Go source, independent of timestamps', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiff-inputs-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'assets'));
  const go = path.join(root, 'main.go'), asset = path.join(root, 'assets', 'worker.js.gz');
  fs.writeFileSync(go, 'go source'); fs.writeFileSync(asset, 'browser code');
  const initial = buildInputsHash(root);
  fs.utimesSync(go, new Date(0), new Date(0));
  assert.equal(buildInputsHash(root), initial);
  fs.writeFileSync(asset, 'changed browser code');
  const changed = buildInputsHash(root);
  assert.notEqual(changed, initial);
  fs.writeFileSync(go, 'changed go source');
  assert.notEqual(buildInputsHash(root), changed);
});

test('standalone license inventory includes scoped and nested bundled packages only', () => {
  assert.deepEqual(packageDirectories([
    'src/cli.js', 'node_modules/first/index.js', 'node_modules/first/lib/other.js',
    'node_modules/first/node_modules/nested/index.js', 'node_modules/@scope/pkg/lib/index.js'
  ], '/repo'), [
    '/repo/node_modules/@scope/pkg', '/repo/node_modules/first', '/repo/node_modules/first/node_modules/nested'
  ]);
});

test('build preserves dependency notices and refuses missing licensing for a new dependency', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiff-license-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const name of ['LICENSE', 'THIRD_PARTY_NOTICES.md', 'THIRD_PARTY_NOTICES_BROWSER.txt']) fs.writeFileSync(path.join(root, name), name);
  const dependency = path.join(root, 'dependency'); fs.mkdirSync(dependency);
  fs.writeFileSync(path.join(dependency, 'package.json'), JSON.stringify({ name: 'example', version: '1.2.3', license: 'MIT' }));
  assert.throws(() => collectNotices([dependency], root, 'test'), /缺少依赖许可证：example@1.2.3/);
  fs.writeFileSync(path.join(dependency, 'LICENSE'), 'required attribution');
  fs.writeFileSync(path.join(dependency, 'NOTICE.txt'), 'additional required notice');
  const notices = collectNotices([dependency, dependency], root, 'test');
  assert.ok(notices.includes('required attribution'));
  assert.ok(notices.includes('additional required notice'));
  assert.equal(notices.split('example@1.2.3').length, 2);
});
