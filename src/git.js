'use strict';
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

async function readHeadWorkbook(git, repository, uri) {
  const object = await repository.getObjectDetails('HEAD', uri.fsPath);
  if (object.size > 8 * 1024 * 1024) throw new Error('单侧文件超过 8 MiB，请缩小工作簿。');
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(object.object)) throw new Error('HEAD 对象无效。');
  // The Git extension's show/buffer paths use --textconv, which can turn XLSX into text.
  const { stdout } = await promisify(execFile)(git.git.path, ['cat-file', 'blob', object.object], {
    cwd: repository.rootUri.fsPath, encoding: 'buffer', maxBuffer: 8 * 1024 * 1024,
    timeout: 30000, windowsHide: true
  });
  return stdout;
}

module.exports = { readHeadWorkbook };
