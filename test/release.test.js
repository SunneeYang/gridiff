'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { release } = require('../scripts/release');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiff-release-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ publisher: 'sunneeyang', name: 'gridiff', version: '0.1.13' }));
  fs.writeFileSync(path.join(root, 'package-lock.json'), JSON.stringify({ version: '0.1.13', packages: { '': { version: '0.1.13' } } }));
  const calls = [];
  const options = { root, env: { npm_execpath: '/fake/npm-cli.js', VSCE_PAT: 'market-secret', OVSX_PAT: 'open-secret' }, log: () => {}, exec: (command, argv, settings) => {
    calls.push({ command, argv, ...settings });
    const out = argv.indexOf('--out');
    if (out >= 0) fs.writeFileSync(argv[out + 1], 'prepared artifact');
    return { status: 0 };
  } };
  return { root, calls, options };
}

test('release defaults to local preparation and preserves earlier artifacts', t => {
  const { calls, options } = fixture(t);
  const first = release([], options);
  const second = release([], options);
  assert.notEqual(first.vsix, second.vsix);
  assert.equal(fs.readFileSync(first.vsix, 'utf8'), 'prepared artifact');
  assert.deepEqual(JSON.parse(fs.readFileSync(`${first.vsix}.json`, 'utf8')), {
    publisher: first.publisher, name: first.name, version: first.version, sha256: first.sha256
  });
  assert.equal(calls.filter(c => c.argv.includes('publish')).length, 0);
  assert.ok(calls.every(c => !c.env.VSCE_PAT && !c.env.OVSX_PAT));
});

test('all markets require credentials before any work and receive the same prepared bytes', t => {
  const { calls, options } = fixture(t);
  assert.throws(() => release(['--publish', 'all'], { ...options, env: { ...options.env, OVSX_PAT: '' } }), /OVSX_PAT/);
  assert.equal(calls.length, 0);
  const prepared = release([], options);
  calls.length = 0;
  release(['--publish', 'all', '--package', prepared.vsix], options);
  assert.equal(calls.length, 2);
  assert.ok(calls.every(c => c.argv.includes(prepared.vsix)));
  assert.equal(calls[0].env.VSCE_PAT, 'market-secret');
  assert.equal(calls[0].env.OVSX_PAT, undefined);
  assert.equal(calls[1].env.OVSX_PAT, 'open-secret');
  assert.equal(calls[1].env.VSCE_PAT, undefined);
  assert.deepEqual(calls[1].argv.slice(1, 3), ['--registryUrl', 'https://open-vsx.org']);
  assert.ok(calls.every(c => !c.argv.includes('--skip-duplicate') && !c.argv.some(a => a.includes('secret'))));
});

test('failed upload preserves the artifact and retry targets only the failed market', t => {
  const { calls, options } = fixture(t);
  const prepared = release([], options);
  calls.length = 0;
  const failing = { ...options, exec: (...args) => {
    options.exec(...args);
    return { status: calls.length === 2 ? 1 : 0 };
  } };
  assert.throws(() => release(['--publish', 'all', '--package', prepared.vsix], failing), /--publish openvsx/);
  assert.equal(calls.length, 2);
  assert.equal(fs.readFileSync(prepared.vsix, 'utf8'), 'prepared artifact');
  calls.length = 0;
  release(['--publish', 'openvsx', '--package', prepared.vsix], options);
  assert.equal(calls.length, 1);
  assert.match(calls[0].argv[0], /ovsx/);
  calls.length = 0;
  assert.throws(() => release(['--publish', 'all', '--package', prepared.vsix], { ...options, exec: (...args) => {
    options.exec(...args);
    return { status: 1 };
  } }), /--publish marketplace/);
  assert.equal(calls.length, 1);
});

test('changed packages and mismatched versions cannot reach publishing', t => {
  const { calls, options, root } = fixture(t);
  const prepared = release([], options);
  calls.length = 0;
  fs.appendFileSync(prepared.vsix, 'changed');
  assert.throws(() => release(['--publish', 'all', '--package', prepared.vsix], options), /校验记录不匹配/);
  assert.equal(calls.length, 0);
  fs.writeFileSync(path.join(root, 'package-lock.json'), JSON.stringify({ version: '0.1.12', packages: { '': { version: '0.1.12' } } }));
  assert.throws(() => release([], options), /版本不一致/);
  assert.equal(calls.length, 0);
});

test('Marketplace supports explicit Entra authentication without a PAT', t => {
  const { calls, options } = fixture(t);
  const prepared = release([], options);
  calls.length = 0;
  release(['--publish', 'marketplace', '--azure-credential', '--package', prepared.vsix], { ...options, env: {} });
  assert.equal(calls.length, 1);
  assert.ok(calls[0].argv.includes('--azure-credential'));
  assert.equal(calls[0].env.VSCE_PAT, undefined);
  assert.equal(calls[0].env.OVSX_PAT, undefined);
});
