'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { gzipSync } = require('node:zlib');
const { parseArgs } = require('node:util');
const { spawnSync, execFileSync } = require('node:child_process');
const { pageHTML } = require('../src/page');
const targets = ['darwin-arm64', 'darwin-x64', 'linux-arm64', 'linux-x64', 'windows-x64'];

function buildInputsHash(directory) {
  const digest = createHash('sha256');
  const visit = relative => {
    for (const name of fs.readdirSync(path.join(directory, relative)).sort()) {
      const file = path.posix.join(relative, name), absolute = path.join(directory, file);
      const stat = fs.lstatSync(absolute);
      if (stat.isDirectory()) visit(file);
      else if (stat.isFile()) digest.update(JSON.stringify([file, stat.size])).update(fs.readFileSync(absolute));
      else throw new Error(`构建输入不是普通文件：${absolute}`);
    }
  };
  visit('');
  return digest.digest('hex');
}

function collectNotices(dependencies, root, goLicense) {
  const sections = [
    `Gridiff\nSource: https://github.com/SunneeYang/gridiff\n\n${fs.readFileSync(path.join(root, 'LICENSE'), 'utf8')}`,
    `Go standard library and runtime\nSource: https://go.dev/\n${goLicense}`,
    `SSF General number formatting algorithm (Apache-2.0)\nSource: https://github.com/SheetJS/ssf\n${fs.readFileSync(path.join(root, 'node_modules/ssf/LICENSE'), 'utf8')}`
  ];
  const seen = new Set();
  for (const { id, directory } of dependencies) {
    if (seen.has(id)) continue;
    seen.add(id);
    const files = fs.readdirSync(directory).filter(name => /^(licen[sc]e|copying|notice|patents)(\.|$)/i.test(name) && fs.statSync(path.join(directory, name)).isFile());
    if (!files.length) throw new Error(`缺少依赖许可证：${id}`);
    sections.push(`${id}\n` + files.sort().map(name => `${name}\n${fs.readFileSync(path.join(directory, name), 'utf8')}`).join('\n'));
  }
  return sections.join('\n\n' + '='.repeat(72) + '\n\n') + '\n';
}
function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: 'inherit', ...options });
  if (result.error || result.status !== 0) throw new Error(`${command} 失败：${result.error?.message || result.status}`);
}
async function build(args, { root = path.resolve(__dirname, '..'), log = console.log } = {}) {
  const { values } = parseArgs({ args, options: { target: { type: 'string' }, all: { type: 'boolean' }, help: { type: 'boolean' } } });
  if (values.help) { log(`node scripts/build-cli.js [--target ${targets.join('|')} | --all]`); return; }
  if (values.all && values.target) throw new Error('--all 与 --target 不能同时使用。');
  const selected = values.all ? targets : [values.target || `${process.platform === 'win32' ? 'windows' : process.platform}-${process.arch}`];
  if (selected.some(target => !targets.includes(target))) throw new Error('不支持的目标平台。');
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const version = manifest.version;
  if (!/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(version)) throw new Error('版本号无效。');
  const sourceCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  const sourceDirty = !!execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).trim();
  const goRoot = execFileSync('go', ['env', 'GOROOT'], { encoding: 'utf8' }).trim();
  const goVersion = execFileSync('go', ['version'], { encoding: 'utf8' }).trim();
  const goLicense = [path.join(goRoot, 'LICENSE'), path.join(goRoot, '..', 'LICENSE')].find(file => fs.existsSync(file));
  if (!goLicense) throw new Error('Go 安装中缺少 LICENSE。');
  const modules = execFileSync('go', ['list', '-deps', '-f', '{{if .Module}}{{if not .Module.Main}}{{.Module.Path}}@{{.Module.Version}}|{{.Module.Dir}}{{end}}{{end}}', '.'], { cwd: path.join(root, 'cli'), encoding: 'utf8' });
  const dependencies = modules.trim().split('\n').filter(Boolean).map(line => { const [id, directory] = line.split('|'); return { id, directory }; });
  const notices = collectNotices(dependencies, root, fs.readFileSync(goLicense, 'utf8'));
  const assets = Object.fromEntries(['main.js', 'main.css', 'browser.js', 'themes.js', 'themes.css'].map(name => [name, fs.readFileSync(path.join(root, 'media', name), 'utf8')]));
  assets['index.html'] = pageHTML({ resource: name => name, browser: true,
    csp: "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; worker-src 'none'; base-uri 'none'; form-action 'none'" });
  assets['licenses.txt'] = notices;
  const assetDirectory = path.join(root, 'cli', 'assets');
  fs.mkdirSync(assetDirectory, { recursive: true });
  for (const name of ['worker.js.gz', 'view.js.gz']) fs.rmSync(path.join(assetDirectory, name), { force: true });
  for (const [name, source] of Object.entries(assets)) fs.writeFileSync(path.join(assetDirectory, name + '.gz'), gzipSync(Buffer.from(source), { level: 9 }));
  const buildInputsSha256 = buildInputsHash(path.join(root, 'cli'));
  const temporary = fs.mkdtempSync(path.join(process.env.CODEX_AGENT_TMP || os.tmpdir(), 'gridiff-build-'));
  const results = [];
  try {
    for (const target of selected) {
      const [platform, arch] = target.split('-'), filename = platform === 'windows' ? 'gridiff.exe' : 'gridiff';
      const executable = path.join(temporary, `gridiff-${target}${platform === 'windows' ? '.exe' : ''}`);
      run('go', ['build', '-trimpath', '-buildvcs=false', '-ldflags', `-s -w -X main.version=${version} -X main.buildID=${buildInputsSha256}`, '-o', executable, '.'], {
        cwd: path.join(root, 'cli'), env: { ...process.env, CGO_ENABLED: '0', GOOS: platform === 'windows' ? 'windows' : platform, GOARCH: arch === 'x64' ? 'amd64' : arch }
      });
      if (buildInputsHash(path.join(root, 'cli')) !== buildInputsSha256) throw new Error('构建期间输入发生变化，请重新构建全部平台。');
      if (platform === 'darwin' && process.platform === 'darwin') run('/usr/bin/codesign', ['--force', '--sign', '-', executable]);
      const directory = path.join(root, 'dist', 'cli', `gridiff-${target}`);
      fs.mkdirSync(directory, { recursive: true });
      const output = path.join(directory, filename);
      fs.copyFileSync(executable, output); fs.chmodSync(output, 0o755);
      fs.writeFileSync(path.join(directory, 'LICENSES.txt'), notices);
      const bytes = fs.readFileSync(output);
      const receipt = { name: manifest.name, publisher: manifest.publisher, version, target, sourceCommit, sourceDirty, buildInputsSha256, runtime: goVersion, bundler: 'none', size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
      fs.writeFileSync(`${output}.json`, JSON.stringify(receipt, null, 2) + '\n');
      const Zip = require('jszip'), zip = new Zip();
      zip.file(filename, bytes, { unixPermissions: 0o100755 });
      zip.file('LICENSES.txt', notices);
      zip.file(`${filename}.json`, JSON.stringify(receipt, null, 2) + '\n');
      const archive = path.join(root, 'dist', 'cli', `gridiff-${target}.zip`);
      const compressed = await zip.generateAsync({ type: 'nodebuffer', platform: platform === 'windows' ? 'DOS' : 'UNIX', compression: 'DEFLATE', compressionOptions: { level: 9 } });
      fs.writeFileSync(archive, compressed);
      results.push({ output, archive, archiveSize: compressed.length, ...receipt });
      log(`${target}: ${(bytes.length / 1048576).toFixed(2)} MiB，下载包 ${(compressed.length / 1048576).toFixed(2)} MiB\n${output}`);
    }
    return results;
  } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
}
if (require.main === module) build(process.argv.slice(2)).catch(error => {
  console.error(error.message);
  if (error.errors) for (const detail of error.errors) console.error(detail.message || detail);
  process.exitCode = 1;
});
module.exports = { build, buildInputsHash, collectNotices };
