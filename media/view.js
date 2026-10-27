'use strict';
(() => {
  const cache = new WeakMap();
  function selectView(model, state) {
    let prepared = cache.get(model);
    if (!prepared) {
      const changed = new Set();
      for (const row of model.rows) {
        if (row.status === 'removed') continue;
        row.cells.forEach((cell, i) => {
          if (row.status === 'added' ? cell.after !== null && cell.after !== '' : cell.changed) changed.add(i);
        });
      }
      if (model.counts.removed && !model.counts.added && !changed.size) {
        for (const row of model.rows) if (row.status === 'removed') {
          row.cells.forEach((cell, i) => { if (cell.before !== null && cell.before !== '') changed.add(i); });
        }
      }
      prepared = { changed, query: null }; cache.set(model, prepared);
    }
    const query = state.query.toLocaleLowerCase();
    if (prepared.query !== query || prepared.onlyChanges !== state.onlyChanges) {
      prepared.filtered = model.rows.filter(row =>
        (!state.onlyChanges || row.status !== 'unchanged' || row.moved || row.cells.some((cell, i) => cell.changed && (!model.fields[i].before || !model.fields[i].after))) &&
        (!query || row.identity.toLocaleLowerCase().includes(query) || row.cells.some(c => [c.before, c.after, c.beforeMeta?.formula, c.afterMeta?.formula, c.beforeMeta?.raw, c.afterMeta?.raw].some(v => v != null && String(v).toLocaleLowerCase().includes(query)))));
      prepared.query = query; prepared.onlyChanges = state.onlyChanges;
    }
    const fieldIndexes = model.fields.map((_, i) => i).filter(i => !state.onlyFields || prepared.changed.has(i));
    const pageSize = Math.max(1, Math.min(100, Math.floor(3000 / Math.max(1, fieldIndexes.length))));
    const pages = Math.max(1, Math.ceil(prepared.filtered.length / pageSize));
    const page = Math.max(0, Math.min(state.page, pages - 1));
    return { rows: prepared.filtered.slice(page * pageSize, (page + 1) * pageSize),
      pageInfo: { page, pages, pageSize, fieldIndexes, totalRows: model.rows.length, filteredRows: prepared.filtered.length } };
  }
  if (typeof module === 'object') module.exports = { selectView };
  else window.gridiffView = selectView;
})();
