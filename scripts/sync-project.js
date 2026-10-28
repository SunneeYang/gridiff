'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomBytes } = require('node:crypto');
const { parseArgs } = require('node:util');

const targets = ['darwin-arm64', 'darwin-x64', 'linux-arm64', 'linux-x64', 'windows-x64'];
const guideFiles = ['guide.css', 'guide.js', 'theme.js', 'tokens.css', 'assets/fork-custom-default.png', 'assets/gridiff-example.png'];
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const attributes = `/bin/**/gridiff filter=lfs diff=lfs merge=lfs -text
/bin/**/gridiff.exe filter=lfs diff=lfs merge=lfs -text
/gridiff text eol=lf
/gridiff.cmd text eol=crlf
/README.md text eol=lf
/manifest.json text eol=lf
/LICENSES.txt text eol=lf
/安装与使用.html text eol=lf
/guide/*.css text eol=lf
/guide/*.js text eol=lf
`;

function inspectPath(file, type, allowMissing = false) {
  const absolute = path.resolve(file), parsed = path.parse(absolute);
  const parts = absolute.slice(parsed.root.length).split(path.sep).filter(Boolean);
  let current = parsed.root;
  for (let i = 0; i < parts.length; i++) {
    current = path.join(current, parts[i]);
    let stat;
    try { stat = fs.lstatSync(current); }
    catch (error) { if (error.code === 'ENOENT' && allowMissing) return null; throw error; }
    if (stat.isSymbolicLink()) throw new Error(`拒绝符号链接路径：${current}`);
    const expected = i === parts.length - 1 ? type : 'directory';
    if (expected === 'directory' ? !stat.isDirectory() : !stat.isFile()) throw new Error(`路径类型不符：${current}`);
  }
  return fs.statSync(absolute);
}

function readFile(file) { inspectPath(file, 'file'); return fs.readFileSync(file); }
function readJSON(file) {
  try { return JSON.parse(readFile(file).toString('utf8')); }
  catch (error) { throw new Error(`无法读取校验清单 ${file}：${error.message}`); }
}

function prepare(root, project) {
  const packageFile = readJSON(path.join(root, 'package.json'));
  if (packageFile.name !== 'gridiff' || packageFile.publisher !== 'sunneeyang' || !/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(packageFile.version)) throw new Error('当前工程不是有效的 sunneeyang.gridiff。');
  inspectPath(project, 'directory');
  const destination = path.join(project, 'gridiff');
  inspectPath(destination, 'directory', true);
  const files = new Map();
  const add = (name, bytes, mode = 0o644) => files.set(name, { bytes: Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes), mode });
  const builds = [];
  let license, provenance;
  for (const target of targets) {
    const filename = target.startsWith('windows-') ? 'gridiff.exe' : 'gridiff';
    const directory = path.join(root, 'dist', 'cli', `gridiff-${target}`);
    const receipt = readJSON(path.join(directory, `${filename}.json`));
    if (receipt.name !== packageFile.name || receipt.publisher !== packageFile.publisher || receipt.version !== packageFile.version || receipt.target !== target || !/^[a-f0-9]{64}$/.test(receipt.sha256 || '')) throw new Error(`制品身份、版本或目标不符：${target}`);
    if (receipt.sourceCommit !== undefined && receipt.sourceCommit !== null && !/^[a-f0-9]{40,64}$/.test(receipt.sourceCommit)) throw new Error(`来源提交无效：${target}`);
    if (receipt.sourceDirty !== undefined && receipt.sourceDirty !== null && typeof receipt.sourceDirty !== 'boolean') throw new Error(`来源工作区状态无效：${target}`);
    if (!/^[a-f0-9]{64}$/.test(receipt.buildInputsSha256 || '')) throw new Error(`构建输入摘要不完整，请重新构建：${target}`);
    const source = { sourceCommit: receipt.sourceCommit ?? null, sourceDirty: receipt.sourceDirty ?? null, buildInputsSha256: receipt.buildInputsSha256 };
    if (provenance && JSON.stringify(provenance) !== JSON.stringify(source)) throw new Error(`五个平台来源不一致：${target}`);
    provenance = source;
    const executable = readFile(path.join(directory, filename));
    if (!executable.length || hash(executable) !== receipt.sha256 || (receipt.size !== undefined && receipt.size !== executable.length)) throw new Error(`安装包 SHA-256 或大小不符：${target}`);
    const notices = readFile(path.join(directory, 'LICENSES.txt'));
    if (!notices.includes(Buffer.from('Gridiff')) || !notices.includes(Buffer.from('Permission is hereby granted')) || !notices.includes(Buffer.from('Go standard library and runtime'))) throw new Error(`许可证不完整：${target}`);
    if (receipt.licensesSha256 !== undefined && hash(notices) !== receipt.licensesSha256) throw new Error(`许可证校验失败：${target}`);
    if (license && !license.equals(notices)) throw new Error(`五个平台许可证不一致：${target}`);
    license = notices;
    const relative = `bin/${target}/${filename}`;
    add(relative, executable, 0o755);
    builds.push({ ...receipt, path: relative });
  }
  add('gridiff', readFile(path.join(root, 'launchers', 'gridiff')).toString('utf8').replace(/\r\n/g, '\n'), 0o755);
  add('gridiff.cmd', readFile(path.join(root, 'launchers', 'gridiff.cmd')).toString('utf8').replace(/\r?\n/g, '\r\n'));
  add('LICENSES.txt', license);
  add('.gitattributes', attributes);
  add('安装与使用.html', readFile(path.join(root, '安装与使用.html')).toString('utf8').replaceAll('docs/guide/', 'guide/'));
  for (const name of guideFiles) add(`guide/${name}`, readFile(path.join(root, 'docs', 'guide', name)));
  const sourceState = provenance.sourceDirty === true ? '含未提交修改的本地开发构建' : provenance.sourceDirty === false ? '源码工作区干净的构建；不代表已正式发布' : '来源工作区状态未知的构建';
  add('README.md', `# Gridiff 策划仓库入口

版本：${packageFile.version}。${sourceState}。
来源提交：${provenance.sourceCommit || '未知'}。各平台 SHA-256、构建来源与许可见 manifest.json 和 LICENSES.txt。

无需单独下载程序，也不需要安装 Node.js、Bun、Go、Mova 或 VS Code。程序已随此目录提供，网页由程序在本机提供；Go 完成解析、比较、搜索和分页，浏览器只接收当前页及可见字段，比较数据只保存在内存。

## 图文安装与使用指南

双击本目录与 README 同级的 [安装与使用.html](安装与使用.html)，按系统和工具查看分步说明，包含 VS Code、Cursor 和仓库自带 Gridiff 的安装、Fork 配置、快捷键及故障排查。指南默认跟随系统明暗，也可在页内切换浅色、深色和多套配色。指南可离线打开；安装编辑器扩展时需要联网。浏览器仅辅助识别系统，不能自动检查本机安装或修改 Fork 设置。

## Fork 配置

1. 打开 Fork 设置 → Integration → External Diff Tool，选择自定义工具，打开 Edit Diff Tool 对话框。
2. File Path 点击文件夹图标：macOS / Linux 选择本目录的 gridiff，Windows x64 选择本目录的 gridiff.cmd。
3. Arguments 设置为 \`$REMOTE $LOCAL\`：旧文件在前，新文件在后。无需添加 diff、--wait 或其他参数，也不要给占位符加引号。
4. 点击 Edit 保存；在 Fork 中选中 CSV 或 XLSX 文件，使用“外部 Diff”打开，即可在默认浏览器中查看表格差异。

配置位置是 External Diff Tool；Merge Tool 保持原来的设置即可。Gridiff 始终将第一文件作为旧版本、第二文件作为新版本，以第一份为基准查看第二份的变化，与 VS Code / Cursor 的 --diff 和插件顺序一致，不根据路径或内容猜方向。兼容 \`diff $REMOTE $LOCAL\` 写法。

独立版仅按扩展名识别 CSV（.csv）和 XLSX（.xlsx），不区分大小写，不根据内容猜测。其他后缀、无后缀或 CSV/XLSX 混合比较会在网页提示不支持并列出支持格式，不读取内容或自动转交其他工具。新增/删除使用的同类型空文件及 /dev/null（Windows 为 NUL）仍支持。Fork 临时文件须保留原扩展名；非表格文件请使用 Fork 内置对比。

XLSX 默认只读首表（含隐藏首表），两侧按位置配对。可用 \`--sheets all\` 读取全部表，或重复 \`--sheet "表名"\` 读取指定多表；全部/指定模式按名称配对，未选表不解压、不解析。Fork 读取全部表时 Arguments 使用 \`--sheets all $REMOTE $LOCAL\`。公式只使用已保存的结果，不重新计算。

Unix 入口自动选择 macOS/Linux 的 ARM64 或 x64 程序。Windows 目前提供 x64；ARM64 入口会明确提示未提供原生版本，不会静默选择错误程序。

命令行也可运行 \`./gridiff "旧版本.csv" "新版本.csv"\`，支持 CSV 和 XLSX。默认读取完整快照后返回，Fork 随后清理临时文件不影响页面。后续比较复用服务和页签，替换当前内容；页签是否自动切到前台取决于系统与浏览器。需要独立比较并等待审阅时加 \`--wait\`，并在网页点击“结束比较”。

程序文件由 Git LFS 跟踪。如果只取到 LFS 指针，入口会提示在策划仓库运行 \`git lfs pull\`，不会自行下载或改权限。若 Unix 程序权限丢失，按入口提示恢复执行权限。

## 性能诊断

比较页地址末尾加 \`#profile=1\` 后重新加载，浏览器 Console 显示 Debug/Verbose 级别即可看到 \`[Gridiff perf]\` 阶段耗时。日志只含阶段、耗时和数字计数，不含表格内容、路径或表名；默认关闭，不自动落盘，当前页面最多保留 500 条。

## 更新

由 Gridiff 工程的 \`scripts/sync-project.js\` 校验完整平台制品后同步。本目录里的未知文件会保留；同步前必须解决已被手工修改的受管文件。脚本不会提交或推送 Git。
`);
  const manifest = { schemaVersion: 1, name: packageFile.name, publisher: packageFile.publisher, version: packageFile.version, ...provenance,
    builds, files: Object.fromEntries([...files].map(([name, file]) => [name, { sha256: hash(file.bytes), mode: file.mode }])) };
  add('manifest.json', JSON.stringify(manifest, null, 2) + '\n');
  const manifestPath = path.join(destination, 'manifest.json');
  let previous;
  if (inspectPath(manifestPath, 'file', true)) {
    previous = readJSON(manifestPath);
    if (previous.schemaVersion !== 1 || previous.name !== 'gridiff' || previous.publisher !== 'sunneeyang' || !previous.files || typeof previous.files !== 'object') throw new Error('目标 manifest.json 不是本同步脚本的清单，请先保留并处理现有文件。');
  }
  for (const [name, file] of files) {
    const target = path.join(destination, name);
    if (!inspectPath(target, 'file', true) || name === 'manifest.json') continue;
    const current = hash(readFile(target));
    if (current !== hash(file.bytes) && current !== previous?.files?.[name]?.sha256) throw new Error(`目标文件有未登记或手工修改，未覆盖：${target}`);
  }
  const obsolete = [];
  const oldEntry = 'guide/index.html', oldPath = path.join(destination, oldEntry);
  if (inspectPath(oldPath, 'file', true)) {
    if (hash(readFile(oldPath)) !== previous?.files?.[oldEntry]?.sha256) throw new Error(`目标旧指南有未登记或手工修改，未删除：${oldPath}`);
    obsolete.push(oldEntry);
  }
  return { destination, files, manifest, obsolete };
}

function applyFiles(destination, files, obsolete) {
  for (const [name, file] of files) {
    const target = path.join(destination, name), directory = path.dirname(target);
    inspectPath(directory, 'directory', true);
    inspectPath(target, 'file', true);
    fs.mkdirSync(directory, { recursive: true });
    const temporary = path.join(directory, `.gridiff-sync-${randomBytes(12).toString('hex')}`);
    try {
      fs.writeFileSync(temporary, file.bytes, { flag: 'wx', mode: file.mode });
      fs.chmodSync(temporary, file.mode);
      fs.renameSync(temporary, target);
    } finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
  }
  for (const name of obsolete) fs.unlinkSync(path.join(destination, name));
}

function syncProject(args, { root = path.resolve(__dirname, '..'), log = console.log } = {}) {
  const { values } = parseArgs({ args, options: { project: { type: 'string' }, apply: { type: 'boolean' }, help: { type: 'boolean' } } });
  if (values.help) { log('node scripts/sync-project.js --project /path/to/design [--apply]\n默认只校验并预览；--apply 才同步，不执行 Git 提交或推送。'); return; }
  if (!values.project) throw new Error('必须通过 --project 指定策划工程目录。');
  const result = prepare(path.resolve(root), path.resolve(values.project));
  const paths = [...result.files.keys()];
  log(`${values.apply ? '同步' : '预览'} Gridiff ${result.manifest.version} → ${result.destination}`);
  log(`来源：${result.manifest.sourceCommit || '未知'}；未提交修改：${result.manifest.sourceDirty === null ? '未知' : result.manifest.sourceDirty}`);
  log(paths.join('\n'));
  if (result.obsolete.length) log(`移除旧入口：${result.obsolete.join('、')}`);
  if (values.apply) { applyFiles(result.destination, result.files, result.obsolete); log('同步完成；未提交或推送 Git。'); }
  else log('校验通过，尚未写入。追加 --apply 执行同步。');
  return { destination: result.destination, applied: !!values.apply, manifest: result.manifest, paths, obsolete: result.obsolete };
}

if (require.main === module) {
  try { syncProject(process.argv.slice(2)); }
  catch (error) { console.error(`Gridiff 同步失败：${error.message}`); process.exitCode = 1; }
}
module.exports = { syncProject };
