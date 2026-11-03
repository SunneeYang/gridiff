'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const Zip = require('jszip');
const { build } = require('./build-cli');

const hash = bytes => createHash('sha256').update(bytes).digest('hex');

async function packageSkill(result, { root = path.resolve(__dirname, '..') } = {}) {
  const project = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const receiptBytes = fs.readFileSync(result.output + '.json');
  const receipt = JSON.parse(receiptBytes);
  const binary = fs.readFileSync(result.output);
  if (!/^(?:(?:darwin|linux)-(?:arm64|x64)|windows-x64)$/.test(result.target) || receipt.name !== project.name || receipt.version !== project.version || receipt.target !== result.target || receipt.version !== result.version || receipt.size !== binary.length || receipt.sha256 !== hash(binary) || receipt.sha256 !== result.sha256) {
    throw new Error('CLI 制品版本、平台或哈希校验失败，请重新构建。');
  }
  const source = path.join(root, 'skills', 'gridiff'), files = [];
  const visit = relative => {
    for (const name of fs.readdirSync(path.join(source, relative)).sort()) {
      const file = path.posix.join(relative, name), absolute = path.join(source, file);
      const stat = fs.lstatSync(absolute);
      if (stat.isDirectory()) visit(file);
      else if (stat.isFile()) files.push({ name: file, bytes: fs.readFileSync(absolute), mode: 0o100644 });
      else throw new Error(`技能资源不是普通文件：${file}`);
    }
  };
  visit('');
  if (!files.some(file => file.name === 'SKILL.md')) throw new Error('技能缺少 SKILL.md。');
  const filename = result.target.startsWith('windows-') ? 'gridiff.exe' : 'gridiff';
  files.push({ name: `bin/${filename}`, bytes: binary, mode: 0o100755 });
  files.push({ name: `bin/${filename}.json`, bytes: receiptBytes, mode: 0o100644 });
  files.push({ name: 'LICENSES.txt', bytes: fs.readFileSync(path.join(path.dirname(result.output), 'LICENSES.txt')), mode: 0o100644 });
  const manifest = { schemaVersion: 1, name: 'gridiff', version: receipt.version, target: result.target, cli: `bin/${filename}`, files: Object.fromEntries(files.map(file => [file.name, hash(file.bytes)])) };
  files.push({ name: 'manifest.json', bytes: Buffer.from(JSON.stringify(manifest, null, 2) + '\n'), mode: 0o100644 });
  const directory = path.join(root, 'dist', 'skills', `gridiff-${result.target}`, 'gridiff');
  const zip = new Zip();
  for (const file of files) {
    const output = path.join(directory, file.name);
    fs.mkdirSync(path.dirname(output), { recursive: true });
    fs.writeFileSync(output, file.bytes, { mode: file.mode & 0o777 });
    fs.chmodSync(output, file.mode & 0o777);
    zip.file(`gridiff/${file.name}`, file.bytes, { unixPermissions: file.mode });
  }
  const archive = path.join(root, 'dist', 'skills', `gridiff-${result.target}.zip`);
  fs.writeFileSync(archive, await zip.generateAsync({ type: 'nodebuffer', platform: 'UNIX', compression: 'DEFLATE', compressionOptions: { level: 9 } }));
  return { directory, archive, manifest };
}

async function buildSkill(args, { root = path.resolve(__dirname, '..'), log = console.log } = {}) {
  if (args.includes('--help')) { log('node scripts/build-skill.js [--target <平台-架构> | --all]'); return []; }
  const results = await build(args, { root, log });
  const packages = [];
  for (const result of results) {
    const bundle = await packageSkill(result, { root });
    packages.push(bundle);
    log(bundle.archive);
  }
  return packages;
}

if (require.main === module) buildSkill(process.argv.slice(2)).catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { buildSkill, packageSkill };
