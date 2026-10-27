'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { buildInputsHash, collectNotices } = require('../scripts/build-cli');

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

test('build preserves dependency notices and refuses missing licensing for a new dependency', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiff-license-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const name of ['LICENSE', 'THIRD_PARTY_NOTICES.md', 'THIRD_PARTY_NOTICES_BROWSER.txt']) fs.writeFileSync(path.join(root, name), name);
  fs.mkdirSync(path.join(root, 'node_modules/ssf'), { recursive: true }); fs.writeFileSync(path.join(root, 'node_modules/ssf/LICENSE'), 'SSF license');
  const dependency = path.join(root, 'dependency'); fs.mkdirSync(dependency);
  fs.writeFileSync(path.join(dependency, 'package.json'), JSON.stringify({ name: 'example', version: '1.2.3', license: 'MIT' }));
  assert.throws(() => collectNotices([{id:'example@1.2.3',directory:dependency}], root, 'test'), /缺少依赖许可证：example@1.2.3/);
  fs.writeFileSync(path.join(dependency, 'LICENSE'), 'required attribution');
  fs.writeFileSync(path.join(dependency, 'NOTICE.txt'), 'additional required notice');
  const notices = collectNotices([{id:'example@1.2.3',directory:dependency},{id:'example@1.2.3',directory:dependency}], root, 'test');
  assert.ok(notices.includes('required attribution'));
  assert.ok(notices.includes('additional required notice'));
  assert.equal(notices.split('example@1.2.3').length, 2);
});
