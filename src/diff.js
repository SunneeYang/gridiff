'use strict';

function cellIdentity(row, index, includeFormula = true) {
  const meta = row.metadata?.[index];
  return meta ? [meta.type, meta.raw, ...(includeFormula ? [meta.formula ?? null] : [])] : row.values[index];
}

function compareTables(before, after, options = {}) {
  const oldFields = new Map(before.fields.map((f, i) => [f.name, { ...f, index: i }]));
  const newFields = new Map(after.fields.map((f, i) => [f.name, { ...f, index: i }]));
  const names = [...newFields.keys(), ...[...oldFields.keys()].filter(n => !newFields.has(n))];
  const fields = names.map(name => ({ name, before: oldFields.get(name) || null, after: newFields.get(name) || null }));
  let keys = options.keyColumns || [];
  const position = options.alignment === 'position';
  if (!position && !keys.length && names.length) {
    const table = after.fields.length ? after : before;
    keys = [table.format === 'mova-vertical' ? 'name' : table.fields.find(f => f.name.toLowerCase() === 'id')?.name || table.fields[0].name];
  }
  if (new Set(keys).size !== keys.length) throw new Error('主键字段不能重复。');
  function index(table, fieldMap, side) {
    if (!position && table.fields.length) for (const key of keys) {
      if (!fieldMap.has(key)) throw new Error(`${side}缺少主键字段「${key}」，请选择两侧共有的主键或按行号对齐。`);
    }
    const result = new Map();
    const occurrences = new Map();
    table.rows.forEach((row, i) => {
      const parts = position ? [String(i + 1)] : keys.map(k => row.values[fieldMap.get(k).index]);
      // Retain Mova source rows without an ID/name even when export omits them.
      const unkeyed = !position && keys.length === 1 && parts[0] === '' &&
        ((table.format === 'mova' && keys[0].toLowerCase() === 'id' && fieldMap.get(keys[0]).index === 0) ||
         (table.format === 'mova-vertical' && keys[0] === 'name'));
      if (!position && !unkeyed && keys.some(k => {
        const j = fieldMap.get(k).index, meta = row.metadata?.[j];
        return meta ? meta.raw == null || String(meta.raw).trim() === '' : !row.values[j].trim();
      })) throw new Error(`${side}第 ${row.record} 条记录缺少主键值，请选择其他主键或按行号对齐。`);
      let key = JSON.stringify(position ? parts : keys.map(k => cellIdentity(row, fieldMap.get(k).index, false)));
      if (unkeyed) {
        const values = names.map(name => fieldMap.has(name) ? cellIdentity(row, fieldMap.get(name).index) : null);
        const fingerprint = JSON.stringify(values);
        const occurrence = (occurrences.get(fingerprint) || 0) + 1;
        occurrences.set(fingerprint, occurrence);
        key = JSON.stringify({ values, occurrence });
      }
      if (result.has(key)) throw new Error(`${side}主键 ${parts.join(' / ')} 重复（第 ${result.get(key).record}、${row.record} 条记录），请使用复合主键或按行号对齐。`);
      result.set(key, { ...row, parts, index: i, unkeyed });
    });
    return result;
  }
  const oldRows = index(before, oldFields, '旧版本');
  const newRows = index(after, newFields, '新版本');
  const oldCommon = [...oldRows.keys()].filter(k => newRows.has(k) && !oldRows.get(k).unkeyed);
  const newCommon = [...newRows.keys()].filter(k => oldRows.has(k) && !newRows.get(k).unkeyed);
  const commonOrder = new Map(oldCommon.map((key, i) => [key, i]));
  const moved = new Set(newCommon.filter((key, i) => commonOrder.get(key) !== i));
  const schema = fields.flatMap(field => {
    if (!field.before || !field.after) return [{ name: field.name, kind: field.before ? 'removed' : 'added', before: field.before, after: field.after }];
    return ['label', 'type', 'flags'].filter(prop => field.before[prop] !== field.after[prop])
      .map(prop => ({ name: field.name, kind: prop, before: field.before[prop], after: field.after[prop] }));
  });
  const commonFields = [...oldFields.keys()].filter(k => newFields.has(k));
  const newCommonFields = [...newFields.keys()].filter(k => oldFields.has(k));
  if (commonFields.some((name, i) => newCommonFields[i] !== name)) schema.push({ kind: 'order', name: '字段顺序', before: commonFields, after: newCommonFields });
  const counts = { added: 0, removed: 0, modified: 0, unchanged: 0, moved: moved.size, cells: 0, schema: schema.length };
  // Anchor deleted blocks to their old neighbours without changing the new CSV's order.
  const removedBefore = new Map();
  let pending = [], lastCommon = null;
  for (const key of oldRows.keys()) {
    if (newRows.has(key)) {
      if (pending.length) removedBefore.set(key, pending);
      pending = []; lastCommon = key;
    } else pending.push(key);
  }
  const rowKeys = lastCommon === null ? [...pending] : [];
  for (const key of newRows.keys()) {
    for (const removed of removedBefore.get(key) || []) rowKeys.push(removed);
    rowKeys.push(key);
    if (key === lastCommon) for (const removed of pending) rowKeys.push(removed);
  }
  const rows = rowKeys.map(key => {
    const old = oldRows.get(key), next = newRows.get(key);
    let changes = 0;
    const cells = fields.map(field => {
      const a = old && field.before ? old.values[field.before.index] : null;
      const b = next && field.after ? next.values[field.after.index] : null;
      const oldValue = old && field.before ? cellIdentity(old, field.before.index) : null;
      const newValue = next && field.after ? cellIdentity(next, field.after.index) : null;
      const changed = old?.metadata || next?.metadata ? JSON.stringify(oldValue) !== JSON.stringify(newValue) : a !== b;
      if (old && next && field.before && field.after && changed) changes++;
      return { before: a, after: b, changed,
        ...(old?.metadata && field.before ? { beforeMeta: old.metadata[field.before.index] } : {}),
        ...(next?.metadata && field.after ? { afterMeta: next.metadata[field.after.index] } : {}) };
    });
    const status = !old ? 'added' : !next ? 'removed' : changes ? 'modified' : 'unchanged';
    counts[status]++; counts.cells += changes;
    const unkeyed = (next || old).unkeyed;
    return { key, unkeyed, identity: unkeyed ? `无主键记录 ${old?.record ?? '—'} → ${next?.record ?? '—'}` : (next || old).parts.join(' / '), beforeRecord: old?.record ?? null,
      afterRecord: next?.record ?? null, status, moved: moved.has(key), cells };
  });
  return { fields, rows, schema, counts, keys: position ? [] : keys, alignment: position ? 'position' : 'key',
    formats: [before.format, after.format], unkeyed: {
      before: [...oldRows.values()].filter(row => row.unkeyed).length,
      after: [...newRows.values()].filter(row => row.unkeyed).length
    } };
}

module.exports = { compareTables };
