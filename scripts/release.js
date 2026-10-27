'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { parseArgs } = require('node:util');

function release(args, { root = path.resolve(__dirname, '..'), env = process.env, exec = spawnSync, log = console.log } = {}) {
  const { values } = parseArgs({ args, options: {
    publish: { type: 'string' }, package: { type: 'string' },
    'azure-credential': { type: 'boolean' }, help: { type: 'boolean' }
  } });
  if (values.help) {
    log('npm run release -- [--publish marketplace|openvsx|all] [--package <prepared.vsix>] [--azure-credential]');
    log('默认只校验、测试和打包。--package 复用本脚本生成的 VSIX 及其 .json 校验记录。');
    return;
  }
  const target = values.publish;
  if (target && !['marketplace', 'openvsx', 'all'].includes(target)) throw new Error('未知发布目标。使用 marketplace、openvsx 或 all。');
  const markets = target === 'all' ? ['marketplace', 'openvsx'] : target ? [target] : [];
  if (values['azure-credential'] && !markets.includes('marketplace')) throw new Error('--azure-credential 仅用于发布 Marketplace。');
  const tokens = { marketplace: 'VSCE_PAT', openvsx: 'OVSX_PAT' };
  for (const market of markets) {
    if (market === 'marketplace' && values['azure-credential']) continue;
    if (!env[tokens[market]]?.trim()) throw new Error(`请先设置 ${tokens[market]}；脚本不会交互创建或保存凭据。`);
  }
  const cleanEnv = { ...env };
  delete cleanEnv.VSCE_PAT;
  delete cleanEnv.OVSX_PAT;
  const cli = {
    vsce: require.resolve('@vscode/vsce/vsce'),
    ovsx: require.resolve('ovsx/bin/ovsx')
  };
  function run(label, argv, childEnv = cleanEnv) {
    log(label);
    const result = exec(process.execPath, argv, { cwd: root, env: childEnv, stdio: 'inherit' });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`${label}失败（${result.signal || result.status}）。`);
  }
  const sha256 = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  let vsix;
  let receipt;
  if (values.package) {
    vsix = path.resolve(root, values.package);
    receipt = JSON.parse(fs.readFileSync(`${vsix}.json`, 'utf8'));
  } else {
    const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    const lock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8'));
    if (manifest.publisher !== 'sunneeyang' || manifest.name !== 'gridiff') throw new Error('扩展 ID 必须是 sunneeyang.gridiff。');
    if (!/^\d+\.\d+\.\d+$/.test(manifest.version)) throw new Error('发布脚本目前只支持 x.y.z 正式版本。');
    if (lock.version !== manifest.version || lock.packages[''].version !== manifest.version) throw new Error('package.json 与 package-lock.json 版本不一致。');
    if (!env.npm_execpath) throw new Error('请通过 npm run release 运行。');
    run('语法检查', [env.npm_execpath, 'run', 'check']);
    run('运行测试', [env.npm_execpath, 'test']);
    fs.mkdirSync(path.join(root, 'dist'), { recursive: true });
    const directory = fs.mkdtempSync(path.join(root, 'dist', 'release-'));
    vsix = path.join(directory, `gridiff-${manifest.version}.vsix`);
    run('打包 VSIX', [cli.vsce, 'package', '--out', vsix]);
    receipt = { publisher: manifest.publisher, name: manifest.name, version: manifest.version, sha256: sha256(vsix) };
    fs.writeFileSync(`${vsix}.json`, `${JSON.stringify(receipt, null, 2)}\n`);
  }
  function verify() {
    if (receipt.publisher !== 'sunneeyang' || receipt.name !== 'gridiff' || !/^\d+\.\d+\.\d+$/.test(receipt.version)) throw new Error('安装包校验记录的扩展标识或版本不正确。');
    if (path.basename(vsix) !== `gridiff-${receipt.version}.vsix` || sha256(vsix) !== receipt.sha256) throw new Error('VSIX 与校验记录不匹配，拒绝上传。');
  }
  verify();
  log(`安装包：${vsix}\nSHA-256：${receipt.sha256}`);
  if (!target) log('检查完成，未上传。使用 --publish 和 --package 明确指定要发布的市场及上述安装包。');
  for (const market of markets) {
    verify();
    const childEnv = { ...cleanEnv };
    const argv = market === 'marketplace'
      ? [cli.vsce, 'publish', '--packagePath', vsix]
      : [cli.ovsx, '--registryUrl', 'https://open-vsx.org', 'publish', vsix];
    if (market === 'marketplace' && values['azure-credential']) argv.push('--azure-credential');
    else childEnv[tokens[market]] = env[tokens[market]];
    try {
      run(`上传 ${market}`, argv, childEnv);
    } catch (error) {
      throw new Error(`${error.message}\n安装包已保留：${vsix}\n先检查远端版本状态；需要补发时使用 --publish ${market} --package 指向此包，避免重新打包或重复上传已成功的市场。`);
    }
    log(`${market} 上传命令已完成；市场验证、命名空间审核和公开可下载状态仍需另行确认。`);
  }
  return { vsix, ...receipt };
}

if (require.main === module) {
  try { release(process.argv.slice(2)); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}

module.exports = { release };
