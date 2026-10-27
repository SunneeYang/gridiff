'use strict';

function sheetSelection(value = { mode: 'all' }) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).some(key => !['mode', 'names'].includes(key)) ||
      !['all', 'first', 'named'].includes(value.mode)) throw new Error('XLSX 工作表范围必须为 all、first 或 named。');
  const names = value.names ?? [];
  if (!Array.isArray(names) || names.some(name => typeof name !== 'string' || !name.length)) throw new Error('XLSX 工作表名称必须是非空字符串。');
  if (value.mode === 'named' ? !names.length : names.length) throw new Error('仅 named 范围需要指定至少一个工作表名称。');
  return value.mode === 'named' ? { mode: value.mode, names: [...new Set(names)] } : { mode: value.mode };
}

module.exports = { sheetSelection };
