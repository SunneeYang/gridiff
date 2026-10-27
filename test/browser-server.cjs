'use strict';
const path = require('node:path');
const { spawn } = require('node:child_process');
async function startComparisonServer({ files, binary: explicitBinary } = {}) {
  const platform = process.platform === 'win32' ? 'windows' : process.platform;
  const filename = process.platform === 'win32' ? 'gridiff.exe' : 'gridiff';
  const binary = explicitBinary || process.env.GRIDIFF_BINARY || path.join(__dirname, '..', 'dist', 'cli', `gridiff-${platform}-${process.arch}`, filename);
  const child = spawn(binary, ['diff', '--no-open', '--wait', ...files], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk; });
  const closed = new Promise(resolve => child.once('close', resolve));
  const url = await new Promise((resolve, reject) => {
    let stdout = '';
    const timeout = setTimeout(() => { child.kill(); reject(new Error('启动Gridiff超时。')); }, 15000);
    child.on('error', error => { clearTimeout(timeout); reject(error); });
    child.on('exit', code => { clearTimeout(timeout); reject(new Error(stderr || `Gridiff退出：${code}`)); });
    child.stdout.on('data', chunk => {
      stdout += chunk;
      if (!stdout.includes('\n')) return;
      clearTimeout(timeout);
      const value = stdout.split('\n')[0].trim();
      if (!/^http:\/\/127\.0\.0\.1:\d+\/s\/[a-f0-9]+\/$/.test(value)) { child.kill(); reject(new Error(`无效比较地址：${value}`)); }
      else resolve(value);
    });
  });
  const close = async () => {
    if (child.exitCode !== null || child.signalCode !== null) return closed;
    try { await fetch(url + 'close', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }); }
    catch { child.kill(); }
    const timer = setTimeout(() => child.kill(), 2000);
    try { await closed; } finally { clearTimeout(timer); }
  };
  return { url, origin: new URL(url).origin, closed, close };
}
module.exports = { startComparisonServer };
