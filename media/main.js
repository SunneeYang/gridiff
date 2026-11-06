'use strict';
(() => {
  const host = typeof acquireVsCodeApi === 'function' ? acquireVsCodeApi() : window.gridiffHost;
  const $ = id => document.getElementById(id);
  const saved = host.getState() || {};
  const state = { view: saved.view || 'grid', onlyChanges: saved.onlyChanges !== false, onlyFields: saved.onlyFields !== false,
    query: saved.query || '', field: saved.field || '', page: 0 };
  let data = null, model = null, revision = -1, pageCount = 1;
  const root = document.documentElement;
  const ui = { rows: [], indexes: [], info: null, selected: null, edge: null, reveal: false };
  const rowID = row => JSON.stringify([row.identity, row.beforeRecord, row.afterRecord, row.unkeyed]);
  const isFocus = () => root.dataset.layout === 'focus' && state.view === 'list';
  if (!window.gridiffHost) {
    if (['github', 'material', 'soft', 'brutalist'].includes(saved.style)) root.dataset.style = saved.style;
    if (['matrix', 'paper', 'focus', 'terminal'].includes(saved.layout)) root.dataset.layout = saved.layout;
  }
  $('theme-style').value = root.dataset.style; $('read-layout').value = root.dataset.layout;
  const statusNames = { added: '+ 新增', removed: '− 删除', modified: '~ 修改', unchanged: '未变化' };
  const formatNames = { auto: '自动', csv: '一行表头', mova: 'Mova 四行表头', 'mova-vertical': 'Mova 竖表', headerless: '无表头', custom: '自定义表头' };
  const typeNames = { empty: '空值', string: '文本', number: '数字', boolean: '布尔值', date: '日期', error: '错误' };
  function element(tag, text, className) {
    const node = document.createElement(tag);
    if (text !== undefined) node.textContent = text;
    if (className) node.className = className;
    return node;
  }
  function persist() { host.setState({ view: state.view, onlyChanges: state.onlyChanges, onlyFields: state.onlyFields, query: state.query, field: state.field, style: root.dataset.style, layout: root.dataset.layout }); }
  function marked(value, other) {
    const span = element('span');
    if (value === null) { span.textContent = '不存在'; span.className = 'muted absent'; return span; }
    if (value === '') { span.textContent = '空值'; span.className = 'muted absent'; return span; }
    if (other === null || other === value) { span.textContent = value; return span; }
    const a = Array.from(value), b = Array.from(other);
    let start = 0, end = 0;
    while (start < a.length && start < b.length && a[start] === b[start]) start++;
    while (end < a.length - start && end < b.length - start && a[a.length - end - 1] === b[b.length - end - 1]) end++;
    span.append(document.createTextNode(a.slice(0, start).join('')),
      element('mark', a.slice(start, a.length - end).join('')), document.createTextNode(end ? a.slice(-end).join('') : ''));
    return span;
  }
  function delta(a, b) {
    if (a === null || b === null || a === b) return '';
    const numeric = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i;
    if (!numeric.test(a) || !numeric.test(b)) return '';
    // Suppress approximate math for identifiers and values beyond safe numeric precision.
    if ([a, b].some(v => v.replace(/[^0-9]/g, '').length > 15)) return '';
    const old = Number(a), next = Number(b), diff = next - old;
    if (![old, next, diff].every(n => Number.isFinite(n) && Math.abs(n) <= Number.MAX_SAFE_INTEGER)) return '';
    const number = Number(diff.toPrecision(12));
    const percent = old ? diff / Math.abs(old) * 100 : NaN;
    return `${number > 0 ? '+' : ''}${number}${Number.isFinite(percent) ? ` · ${percent > 0 ? '+' : ''}${Number(percent.toPrecision(6))}%` : ''}`;
  }
  function pair(cell, rowStatus, expanded = false) {
    const node = element('div', undefined, expanded ? 'pair expanded' : 'pair');
    const singleSide = rowStatus === 'added' ? 'after' : rowStatus === 'removed' ? 'before' : null;
    for (const [side, label, other] of [['before', '旧', 'after'], ['after', '新', 'before']]) {
      if (singleSide && side !== singleSide) continue;
      const line = element('div', undefined, `value-line ${side}`);
      if (singleSide) line.classList.add(rowStatus);
      if (!singleSide) line.append(element('span', label, 'version'));
      const value = marked(cell[side], cell[other]); line.append(value);
      const meta = cell[`${side}Meta`], otherMeta = cell[`${other}Meta`];
      if (meta) {
        const differentRaw = meta.raw !== null && String(meta.raw) !== cell[side];
        if ((otherMeta && meta.type !== otherMeta.type) || (cell.changed && cell.before === cell.after && meta.raw !== otherMeta?.raw) || differentRaw) {
          const raw = differentRaw ? ` · ${String(meta.raw)}` : '';
          value.append(element('span', `${typeNames[meta.type] || meta.type}${raw}`, 'cell-meta'));
        }
      }
      node.append(line);
    }
    const numeric = (!cell.beforeMeta && !cell.afterMeta) || (cell.beforeMeta?.type === 'number' && cell.afterMeta?.type === 'number');
    const change = numeric ? delta(cell.beforeMeta ? String(cell.beforeMeta.raw) : cell.before, cell.afterMeta ? String(cell.afterMeta.raw) : cell.after) : '';
    if (change) node.append(element('span', change, 'delta'));
    return node;
  }
  const numericField = field => /^(u?int(?:8|16|32|64)?|float(?:32|64)?|double|number|decimal)$/i.test((field.after || field.before).type || '');
  function fieldTitle(field, side) {
    const meta = (side && field[side]) || field.after || field.before;
    const node = element('div', meta.label, 'field-title');
    node.append(element('span', [field.name, meta.type, meta.flags].filter(Boolean).join(' · '), 'technical'));
    if (!field.before || !field.after) node.append(element('span', field.before ? '− 删除字段' : '+ 新增字段', field.before ? 'removed-label' : 'added-label'));
    return node;
  }
  const hasSchemaCells = row => row.schemaChanged || row.cells.some((cell, i) => cell.changed && (!model.fields[i].before || !model.fields[i].after));
  function recordLabel(row) {
    if (row.displayName !== undefined) return row.displayName;
    const nameIndex = model.fields.findIndex(f => model.formats.includes('mova-vertical') ? f.name === 'comment' : /^(name|名称|名字)$/i.test(f.name));
    return nameIndex < 0 ? '' : row.cells[nameIndex].after || row.cells[nameIndex].before || '';
  }
  function identity(row) {
    const node = element('div', undefined, 'identity');
    node.append(element('span', row.status === 'unchanged' && hasSchemaCells(row) ? '字段变化' : statusNames[row.status], `row-status ${row.status}`));
    if (row.moved) node.append(element('span', '↕ 顺序变化', 'moved'));
    const name = recordLabel(row);
    if (name) node.append(element('strong', name));
    node.append(element('span', row.unkeyed ? row.identity : `${model.alignment === 'position' ? '行号' : model.keys.join(' + ')}  ${row.identity}`, 'record-id'));
    return node;
  }
  function renderSchema() {
    const schema = $('schema'); schema.hidden = !model?.schema.length;
    const body = $('schema-content'); body.replaceChildren();
    if (schema.hidden) return;
    const kinds = { added: '新增字段', removed: '删除字段', label: '说明', type: '类型', flags: '标记', order: '顺序' };
    const counts = new Map();
    for (const item of model.schema) counts.set(item.kind, (counts.get(item.kind) || 0) + 1);
    $('schema-title').textContent = [...counts].map(([kind, count]) => `${kinds[kind]} ${count}`).join(' · ');
    const labels = { added: '+ 新增字段', removed: '− 删除字段', label: '说明变化', type: '类型变化', flags: '导出标记变化', order: '字段顺序变化' };
    const value = v => v === null ? '不存在' : typeof v === 'object' && !Array.isArray(v) ? `${v.label} · ${v.type || '无类型'} · ${v.flags || '无标记'}` : Array.isArray(v) ? v.join(' → ') : v || '空值';
    for (const item of model.schema) {
      const line = element('div', undefined, 'schema-line');
      line.append(element('span', labels[item.kind], 'schema-kind'), element('strong', item.name),
        element('span', `${value(item.before)} → ${value(item.after)}`, 'schema-value')); body.append(line);
    }
  }
  function renderSummary() {
    const container = $('summary'); container.replaceChildren();
    if (!model) return;
    container.append(element('span', '当前表全部变化', 'muted'));
    for (const [key, text] of [['modified', '记录修改'], ['added', '记录新增'], ['removed', '记录删除'], ['cells', '值修改'], ['moved', '顺序变化']]) {
      const item = element('div', undefined, 'stat'); item.append(element('strong', String(model.counts[key]), key), element('span', text)); container.append(item);
    }
  }
  function renderRecord(row, index) {
    const article = element('article', undefined, 'change-record'); article.dataset.record = index;
    article.append(identity(row));
    const values = element('div', undefined, 'change-fields');
    const changed = ui.indexes.filter(i => row.cells[i].changed || row.status === 'added' || row.status === 'removed' || !state.onlyFields || state.field);
    if (!changed.length) values.append(element('p', row.moved ? '字段值未变；共同记录的相对顺序发生变化。' : '字段值未变。', 'muted'));
    for (const i of changed) {
      const field = element('div', undefined, 'change-field');
      field.append(fieldTitle(model.fields[i], row.status === 'removed' ? 'before' : 'after'), pair(row.cells[i], row.status, true)); values.append(field);
    }
    article.append(values); return article;
  }
  function renderFocus() {
    const queue = element('nav', undefined, 'record-queue'); queue.setAttribute('aria-label', '本页记录');
    for (const [index, row] of ui.rows.entries()) {
      const button = element('button'); button.dataset.record = index;
      button.setAttribute('aria-pressed', String(rowID(row) === ui.selected)); button.append(identity(row)); queue.append(button);
    }
    const detail = element('section', undefined, 'focus-detail'); detail.tabIndex = 0; detail.setAttribute('aria-label', '当前记录详情');
    const index = ui.rows.findIndex(row => rowID(row) === ui.selected);
    if (index >= 0) detail.append(renderRecord(ui.rows[index], index));
    const workspace = element('div', undefined, 'focus-workspace'); workspace.append(queue, detail); $('content').append(workspace);
  }
  function updateNavigation() {
    const index = ui.rows.findIndex(row => rowID(row) === ui.selected), info = ui.info;
    $('previous-record').disabled = !info || data?.busy || (state.page === 0 && index <= 0);
    $('next-record').disabled = !info || data?.busy || !ui.rows.length || (state.page + 1 >= pageCount && index === ui.rows.length - 1);
    $('record-position').textContent = index < 0 ? '尚未定位' : `${state.page * info.pageSize + index + 1} / ${info.filteredRows}`;
    $('content').querySelectorAll('[data-record]').forEach(node => {
      const selected = Number(node.dataset.record) === index;
      if (node.tagName === 'BUTTON') node.setAttribute('aria-pressed', String(selected));
      else node.classList.toggle('current', selected);
    });
  }
  function revealRecord() {
    const index = ui.rows.findIndex(row => rowID(row) === ui.selected);
    if (index < 0) return;
    const container = $('content').querySelector('.record-queue') || $('content').querySelector('.grid-wrap') || $('content');
    const row = container.querySelector(`[data-record="${index}"]`);
    if (!row) return;
    const viewport = container.getBoundingClientRect(), box = row.getBoundingClientRect();
    const header = container.querySelector('thead')?.getBoundingClientRect().height || 0;
    container.scrollTop += Math.min(0, box.top - viewport.top - header) + Math.max(0, Math.min(box.bottom - viewport.bottom, box.top - viewport.top - header));
    if (container.classList.contains('record-queue')) container.scrollLeft += Math.min(0, box.left - viewport.left) + Math.max(0, box.right - viewport.right);
  }
  function selectRecord(index, reveal = true) {
    const selected = rowID(ui.rows[index]);
    const detail = $('content').querySelector('.focus-detail');
    if (detail && selected === ui.selected) return;
    ui.selected = selected;
    if (detail) {
      detail.replaceChildren(renderRecord(ui.rows[index], index)); detail.scrollTop = 0;
      if (matchMedia('(max-width: 700px)').matches) $('content').scrollTop = 0;
    }
    updateNavigation(); if (reveal) revealRecord();
  }
  function navigateRecord(step) {
    const index = ui.rows.findIndex(row => rowID(row) === ui.selected), next = index + step;
    if (next >= 0 && next < ui.rows.length) { selectRecord(next); return; }
    const page = state.page + step;
    if (page >= 0 && page < pageCount) { state.page = page; ui.edge = step > 0 ? 'first' : 'last'; ui.reveal = true; requestRender(); }
  }
  function resetFilters() {
    clearTimeout(searchTimer); state.query = ''; state.field = ''; state.page = 0;
    $('search').value = ''; $('field-filter').value = ''; requestRender(); $('search').focus({ preventScroll: true });
  }
  function render() {
    const perf = window.gridiffPerf, start = perf ? performance.now() : 0;
    persist();
    $('grid-tab').setAttribute('aria-pressed', String(state.view === 'grid'));
    $('list-tab').setAttribute('aria-pressed', String(state.view === 'list'));
    $('only-changes').checked = state.onlyChanges; $('only-fields').checked = state.onlyFields;
    const container = $('content'); container.replaceChildren(); container.tabIndex = state.view === 'list' ? 0 : -1;
    ui.rows = []; ui.info = null;
    if (!model) { updateNavigation(); $('results').textContent = ''; $('status').textContent = '只读比较'; $('page').textContent = ''; $('prev').disabled = $('next').disabled = true; return; }
    const filterStart = perf ? performance.now() : 0;
    const selected = data.pageInfo ? { rows: model.rows, pageInfo: data.pageInfo } : window.gridiffView(model, state);
    const { page, pages, fieldIndexes, totalRows, filteredRows } = selected.pageInfo;
    pageCount = pages;
    const visible = selected.rows; state.page = page;
    ui.rows = visible; ui.info = selected.pageInfo; ui.indexes = fieldIndexes;
    if (ui.edge && visible.length) ui.selected = rowID(visible[ui.edge === 'last' ? visible.length - 1 : 0]);
    ui.edge = null;
    if (!visible.some(row => rowID(row) === ui.selected)) ui.selected = isFocus() && visible.length ? rowID(visible[0]) : null;
    $('results').textContent = `显示 ${filteredRows} / ${totalRows} 条记录 · 本页 ${visible.length} 条`;
    $('filter-note').hidden = $('clear-filters').hidden = !state.query && !state.field;
    $('only-fields').disabled = !!state.field || !!data.busy;
    $('field-filter').value = state.field;
    const filteredAt = perf ? performance.now() : 0, columnsAt = filteredAt;
    $('page').textContent = `${state.page + 1} / ${pages}`; $('prev').disabled = !state.page; $('next').disabled = state.page + 1 >= pages;
    $('status').textContent = `只读 · ${model.alignment === 'position' ? '按行号对齐' : `按 ${model.keys.join(' + ')} 对齐`} · ${data.xlsx ? `已载入 ${data.sheets.length} 张表 · 当前 ${data.sheetName}` : '当前表'}`;
    if (!filteredRows) {
      const empty = element('div', undefined, 'empty-state');
      empty.append(element('h2', state.query || state.field ? '没有匹配的记录' : model.schema.length ? '没有记录值变化' : '当前表没有变化'),
        element('p', model.schema.length ? '字段结构变化仍可在上方展开查看。' : '可调整筛选范围，或显示未变化记录核对原表。'));
      const reset = element('button', state.query || state.field ? '清除筛选' : '显示全部记录');
      reset.addEventListener('click', () => { if (!state.query && !state.field) state.onlyChanges = false; resetFilters(); });
      empty.append(reset); container.append(empty);
    }
    if (visible.length && state.view === 'grid') {
      const wrap = element('div', undefined, 'grid-wrap'); wrap.tabIndex = 0; wrap.setAttribute('aria-label', '可横向滚动的差异表格');
      const table = element('table'); const caption = element('caption', '旧版本到新版本的原表对照', 'sr-only'); table.append(caption); const thead = element('thead'), tr = element('tr');
      const identityHeader = element('th', '记录', 'sticky'); identityHeader.scope = 'col'; tr.append(identityHeader);
      for (const i of fieldIndexes) { const th = element('th', undefined, numericField(model.fields[i]) ? 'numeric-field' : ''); th.scope = 'col'; th.append(fieldTitle(model.fields[i])); tr.append(th); }
      thead.append(tr); table.append(thead); const tbody = element('tbody');
      for (const [index, row] of visible.entries()) {
        const tr = element('tr', undefined, row.status); tr.dataset.record = index; const th = element('th', undefined, 'sticky'); th.scope = 'row'; th.append(identity(row)); tr.append(th);
        for (const i of fieldIndexes) {
          const cell = row.cells[i], td = element('td', undefined, cell.changed ? 'changed' : '');
          if (numericField(model.fields[i])) td.classList.add('numeric-field');
          const value = element('div', undefined, 'cell-value');
          if (cell.changed || row.status === 'added' || row.status === 'removed') value.append(pair(cell, row.status));
          else value.append(element('span', cell.after === '' ? '空值' : cell.after ?? '不存在', cell.after ? 'unchanged-value' : 'muted absent'));
          td.append(value); tr.append(td);
        }
        tbody.append(tr);
      }
      table.append(tbody); wrap.append(table); container.append(wrap);
    } else if (visible.length && isFocus()) renderFocus();
    else for (const [index, row] of visible.entries()) container.append(renderRecord(row, index));
    updateNavigation();
    if (ui.reveal) { revealRecord(); ui.reveal = false; }
    if (perf) {
      const done = performance.now(), counts = { revision, busy: !!data.busy, rows: totalRows, columns: fieldIndexes.length, visibleRows: visible.length, request: data.presentation, generation: data.generation };
      perf.add('render.setup', filterStart - start, counts);
      perf.add('render.filter', filteredAt - filterStart, counts);
      perf.add('render.columns', columnsAt - filteredAt, counts);
      perf.add('render.dom', done - columnsAt, counts);
      perf.add('render.total', done - start, counts);
      requestAnimationFrame(() => requestAnimationFrame(() => perf.add('render.frame', performance.now() - start, counts)));
    }
  }
  document.querySelectorAll('[data-action]').forEach(button => button.addEventListener('click', () => host.postMessage({ action: button.dataset.action })));
  function requestRender() {
    persist();
    if (window.gridiffHost) host.postMessage({ action: 'view', view: { ...state } });
    else render();
  }
  $('grid-tab').addEventListener('click', () => { state.view = 'grid'; ui.reveal = true; requestRender(); });
  $('list-tab').addEventListener('click', () => { state.view = 'list'; ui.reveal = true; requestRender(); });
  $('only-changes').addEventListener('change', e => { state.onlyChanges = e.target.checked; state.page = 0; requestRender(); });
  $('only-fields').addEventListener('change', e => { state.onlyFields = e.target.checked; requestRender(); });
  $('search').value = state.query;
  let searchTimer;
  function search(event) {
    clearTimeout(searchTimer);
    if (event.isComposing) return;
    state.query = event.target.value; state.page = 0;
    if (window.gridiffHost) host.postMessage({ action: 'view-pending', view: { ...state } });
    searchTimer = setTimeout(requestRender, 150);
  }
  $('search').addEventListener('input', search); $('search').addEventListener('compositionend', search);
  $('field-filter').addEventListener('change', event => { state.field = event.target.value; state.page = 0; requestRender(); });
  $('clear-filters').addEventListener('click', resetFilters);
  $('previous-record').addEventListener('click', () => navigateRecord(-1));
  $('next-record').addEventListener('click', () => navigateRecord(1));
  $('content').addEventListener('click', event => {
    const record = event.target.closest('[data-record]');
    if (record && (!$('content').querySelector('.focus-detail') || record.matches('.record-queue button')) && !event.target.closest('details') && !data.busy) selectRecord(Number(record.dataset.record), false);
  });
  function applyLayout() {
    persist();
    if (!model || state.view !== 'list') return;
    // Wait for the requested projection so a layout change cannot restore an old page/query.
    if (data.pageInfo && (data.busy || Object.keys(state).some(key => (state[key] ?? '') !== (data.viewState?.[key] ?? '')))) return;
    if (isFocus() !== !!$('content').querySelector('.focus-workspace')) { ui.reveal = true; render(); }
  }
  window.addEventListener('gridiff-layout', applyLayout);
  if (!window.gridiffHost) {
    $('theme-style').addEventListener('change', event => { root.dataset.style = event.target.value; persist(); });
    $('read-layout').addEventListener('change', event => { root.dataset.layout = event.target.value; window.dispatchEvent(new Event('gridiff-layout')); });
  }
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && $('settings').open && !document.querySelector('dialog[open]')) {
      $('settings').open = false; $('settings').querySelector('summary').focus({ preventScroll: true }); event.preventDefault();
    }
  });
  document.addEventListener('click', event => {
    if ($('settings').open && !$('settings').contains(event.target) && !document.querySelector('dialog[open]')) $('settings').open = false;
  });
  $('prev').addEventListener('click', () => { state.page = Math.max(0, state.page - 1); requestRender(); });
  $('next').addEventListener('click', () => { state.page = Math.min(pageCount - 1, state.page + 1); requestRender(); });
  $('sheet').addEventListener('change', event => host.postMessage({ action: 'sheet', name: event.target.value }));
  window.addEventListener('message', event => {
    if (window.gridiffHost && event.source !== null) return;
    if (event.data?.type === 'snapshot-replacing') {
      clearTimeout(searchTimer); state.query = ''; state.field = ''; state.page = 0; ui.selected = null; $('search').value = ''; persist(); return;
    }
    if (event.data?.type === 'session-ended') {
      data = model = null; state.query = ''; state.field = ''; clearTimeout(searchTimer);
      ui.rows = []; ui.info = null; ui.selected = null; $('field-filter').replaceChildren();
      $('content').setAttribute('aria-busy', 'false'); $('settings').inert = true;
      $('title').textContent = '比较已结束'; $('sources').replaceChildren(); $('source-details').replaceChildren(); $('settings').open = false;
      $('results').textContent = ''; $('record-position').textContent = '尚未定位'; $('filter-note').hidden = $('clear-filters').hidden = true;
      $('review-notice').textContent = event.data.message;
      $('summary').replaceChildren(); $('schema-content').replaceChildren(); $('schema-title').textContent = ''; $('schema').hidden = true;
      $('content').replaceChildren(); $('notice').textContent = event.data.message; $('error').hidden = true;
      $('status').textContent = '只读比较'; $('page').textContent = ''; $('search').value = '';
      $('sheet').replaceChildren(); $('sheet-label').hidden = true; $('keys').textContent = '主键'; $('format').textContent = '格式';
      document.querySelectorAll('button, input, select').forEach(node => { node.disabled = true; });
      return;
    }
    if (event.data?.type !== 'comparison') return;
    const changed = !data || revision !== event.data.revision || data.presentation !== event.data.presentation;
    const contextChanged = data && (data.generation !== event.data.generation || data.sheetName !== event.data.sheetName || JSON.stringify(data.sources) !== JSON.stringify(event.data.sources));
    if (contextChanged) { ui.selected = null; state.field = ''; }
    data = event.data; model = data.result;
    if (revision !== data.revision) { if (!data.pageInfo) state.page = 0; revision = data.revision; }
    if (changed && !data.busy && data.viewState) { Object.assign(state, data.viewState); $('search').value = state.query; }
    $('title').textContent = data.title;
    $('sources').replaceChildren(); $('source-details').replaceChildren();
    for (const [index, source] of data.sources.entries()) {
      const label = index ? '新版本' : '旧版本', name = source.split(/[\\/]/).at(-1) || source;
      const compact = element('span', undefined, `source ${index ? 'after' : 'before'}`);
      compact.append(element('span', label, 'version-label'), element('span', name)); compact.title = source; $('sources').append(compact);
      const full = element('p'); full.append(element('strong', label + ' '), document.createTextNode(source)); $('source-details').append(full);
    }
    if (changed && !data.busy) {
      const fields = data.filterFields || model?.fields.map(field => ({ name: field.name, label: (field.after || field.before).label })) || [];
      if (state.field && !fields.some(field => field.name === state.field)) { state.field = ''; state.page = 0; }
      const all = element('option', '全部字段'); all.value = ''; $('field-filter').replaceChildren(all);
      for (const field of fields) { const option = element('option', field.label === field.name ? field.name : `${field.label} · ${field.name}`); option.value = field.name; $('field-filter').append(option); }
      $('field-filter').value = state.field;
    }
    $('format').textContent = `格式：${formatNames[data.options.format]}${model && data.options.format === 'auto' ? ` (${model.formats.map(f => formatNames[f]).join(' / ')})` : ''}`;
    $('keys').textContent = data.options.alignment === 'position' ? '对齐：行号' : `主键：${model?.keys.join(' + ') || data.options.keyColumns?.join(' + ') || '自动'}`;
    document.querySelectorAll('[data-action]').forEach(button => { button.disabled = data.busy || (data.unsupported && button.dataset.action !== 'close'); });
    for (const id of ['grid-tab', 'list-tab', 'only-changes', 'only-fields', 'field-filter', 'search', 'clear-filters']) $(id).disabled = !model || (id !== 'search' && !!data.busy) || (id === 'only-fields' && !!state.field);
    $('content').setAttribute('aria-busy', String(!!data.busy));
    $('prev').disabled = data.busy || !state.page; $('next').disabled = data.busy || state.page + 1 >= pageCount;
    document.querySelector('[data-action="native"]').hidden = !!data.xlsx || !!data.readonlySnapshot;
    $('sheet-label').hidden = !data.xlsx;
    $('sheet').replaceChildren(); $('sheet').disabled = data.busy;
    for (const sheet of data.sheets || []) {
      const status = sheet.status === 'added' ? ' · 新增工作表' : sheet.status === 'removed' ? ' · 删除工作表' : '';
      const counts = sheet.counts ? ` · +${sheet.counts.added} −${sheet.counts.removed} ~${sheet.counts.modified}` : '';
      const option = element('option', `${sheet.name}${status}${sheet.error ? ' · 需调整设置' : counts}`);
      option.value = sheet.name; option.selected = sheet.name === data.sheetName; $('sheet').append(option);
    }
    $('error').hidden = !data.error; $('error').textContent = data.error ? data.unsupported ? data.error : `${data.error} ${data.xlsx ? '可调整当前工作表的表头、主键，或检查源文件。' : data.readonlySnapshot ? '可调整格式、主键，或检查源文件。' : '可调整格式、主键，或打开文本对比。'}` : '';
    const notices = [];
    if (data.busy) notices.push('正在读取并计算差异…');
    if (model?.alignment === 'position') notices.push('按行号对齐：插入或删除记录可能使后续记录错位。');
    if (data.skipped?.some(Boolean)) notices.push(`已忽略全空分隔记录：旧 ${data.skipped[0]} / 新 ${data.skipped[1]} 条。`);
    if (model?.unkeyed?.before || model?.unkeyed?.after) notices.push(`Mova 无主键行：旧 ${model.unkeyed.before} / 新 ${model.unkeyed.after} 条；按完整内容匹配并保留重复次数，未匹配的分别显示新增/删除，不推断顺序。`);
    if (data.xlsx) {
      const range = data.sheetSelection?.mode === 'first' ? '首个工作表' : data.sheetSelection?.mode === 'named' ? '指定工作表：' + data.sheetSelection.names.join('、') : '全部工作表';
      notices.push(`XLSX 读取范围：${range}。只比较已保存的单元格结果，不比较公式；缺少缓存结果时按空值处理，不重新计算。忽略字体、颜色、图表等样式变化。`);
    }
    if (!data.unsupported) notices.push(data.readonlySnapshot ? '当前显示内存中的只读快照；文件修改后请从 Fork 重新打开比较。' : '当前显示读取时的快照；文件修改后请重新读取。');
    $('notice').textContent = notices.join(' ');
    $('review-notice').textContent = notices.filter(note => !note.startsWith('XLSX') && !note.startsWith('当前显示')).join(' ');
    updateNavigation();
    if (changed) { renderSummary(); renderSchema(); render(); }
    else applyLayout();
  });
  host.postMessage({ action: 'ready', view: { ...state } });
})();
