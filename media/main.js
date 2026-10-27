'use strict';
(() => {
  const host = typeof acquireVsCodeApi === 'function' ? acquireVsCodeApi() : window.gridiffHost;
  const $ = id => document.getElementById(id);
  const saved = host.getState() || {};
  const state = { view: saved.view || 'grid', onlyChanges: saved.onlyChanges !== false, onlyFields: saved.onlyFields !== false,
    query: saved.query || '', page: 0 };
  let data = null, model = null, revision = -1, pageCount = 1;
  const statusNames = { added: '+ 新增', removed: '− 删除', modified: '~ 修改', unchanged: '未变化' };
  const formatNames = { auto: '自动', csv: '一行表头', mova: 'Mova 四行表头', 'mova-vertical': 'Mova 竖表', headerless: '无表头', custom: '自定义表头' };
  const typeNames = { empty: '空值', string: '文本', number: '数字', boolean: '布尔值', date: '日期', error: '错误' };
  function element(tag, text, className) {
    const node = document.createElement(tag);
    if (text !== undefined) node.textContent = text;
    if (className) node.className = className;
    return node;
  }
  function persist() { host.setState({ view: state.view, onlyChanges: state.onlyChanges, onlyFields: state.onlyFields, query: state.query }); }
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
    $('schema-title').textContent = `${model.schema.length} 项字段变化 · 新增 / 删除 / 类型 / 标记 / 顺序`;
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
    for (const [key, text] of [['modified', '记录修改'], ['added', '记录新增'], ['removed', '记录删除'], ['cells', '值修改'], ['moved', '顺序变化']]) {
      const item = element('div', undefined, 'stat'); item.append(element('strong', String(model.counts[key]), key), element('span', text)); container.append(item);
    }
  }
  function render() {
    const perf = window.gridiffPerf, start = perf ? performance.now() : 0;
    persist();
    $('grid-tab').setAttribute('aria-pressed', String(state.view === 'grid'));
    $('list-tab').setAttribute('aria-pressed', String(state.view === 'list'));
    $('only-changes').checked = state.onlyChanges; $('only-fields').checked = state.onlyFields;
    const container = $('content'); container.replaceChildren(); container.tabIndex = state.view === 'list' ? 0 : -1;
    if (!model) { $('status').textContent = '只读比较'; $('page').textContent = ''; $('prev').disabled = $('next').disabled = true; return; }
    const filterStart = perf ? performance.now() : 0;
    const selected = data.pageInfo ? { rows: model.rows, pageInfo: data.pageInfo } : window.gridiffView(model, state);
    const { page, pages, fieldIndexes, totalRows, filteredRows } = selected.pageInfo;
    pageCount = pages;
    const visible = selected.rows; state.page = page;
    const filteredAt = perf ? performance.now() : 0, columnsAt = filteredAt;
    $('page').textContent = `${state.page + 1} / ${pages}`; $('prev').disabled = !state.page; $('next').disabled = state.page + 1 >= pages;
    $('status').textContent = `只读 · ${model.alignment === 'position' ? '按行号对齐' : `按 ${model.keys.join(' + ')} 对齐`} · ${filteredRows} / ${totalRows} 条记录 · 本页 ${visible.length} 条`;
    if (!filteredRows) container.append(element('div', state.query ? '没有匹配的记录。' : '没有变动记录。可取消“仅看变动记录”查看原表；字段变化见上方。', 'empty-state'));
    if (visible.length && state.view === 'grid') {
      const wrap = element('div', undefined, 'grid-wrap'); wrap.tabIndex = 0; wrap.setAttribute('aria-label', '可横向滚动的差异表格');
      const table = element('table'); const thead = element('thead'), tr = element('tr');
      const identityHeader = element('th', '记录', 'sticky'); identityHeader.scope = 'col'; tr.append(identityHeader);
      for (const i of fieldIndexes) { const th = element('th'); th.scope = 'col'; th.append(fieldTitle(model.fields[i])); tr.append(th); }
      thead.append(tr); table.append(thead); const tbody = element('tbody');
      for (const row of visible) {
        const tr = element('tr', undefined, row.status); const th = element('th', undefined, 'sticky'); th.scope = 'row'; th.append(identity(row)); tr.append(th);
        for (const i of fieldIndexes) {
          const cell = row.cells[i], td = element('td', undefined, cell.changed ? 'changed' : '');
          const value = element('div', undefined, 'cell-value');
          if (cell.changed || row.status === 'added' || row.status === 'removed') value.append(pair(cell, row.status));
          else value.append(element('span', cell.after === '' ? '空值' : cell.after ?? '不存在', cell.after ? 'unchanged-value' : 'muted absent'));
          td.append(value); tr.append(td);
        }
        tbody.append(tr);
      }
      table.append(tbody); wrap.append(table); container.append(wrap);
    } else {
      for (const row of visible) {
        const article = element('article', undefined, 'change-record'); article.append(identity(row));
        const values = element('div', undefined, 'change-fields');
        const changed = fieldIndexes.filter(i => row.cells[i].changed || row.status === 'added' || row.status === 'removed' || !state.onlyFields);
        if (!changed.length) values.append(element('p', row.moved ? '字段值未变；共同记录的相对顺序发生变化。' : '字段值未变。', 'muted'));
        for (const i of changed) {
          const field = element('div', undefined, 'change-field');
          field.append(fieldTitle(model.fields[i], row.status === 'removed' ? 'before' : 'after'), pair(row.cells[i], row.status, true)); values.append(field);
        }
        article.append(values); container.append(article);
      }
    }
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
  $('grid-tab').addEventListener('click', () => { state.view = 'grid'; requestRender(); });
  $('list-tab').addEventListener('click', () => { state.view = 'list'; requestRender(); });
  $('only-changes').addEventListener('change', e => { state.onlyChanges = e.target.checked; state.page = 0; requestRender(); });
  $('only-fields').addEventListener('change', e => { state.onlyFields = e.target.checked; requestRender(); });
  $('search').value = state.query;
  let searchTimer;
  $('search').addEventListener('input', e => { state.query = e.target.value; state.page = 0; if (window.gridiffHost) host.postMessage({ action: 'view-pending', view: { ...state } }); clearTimeout(searchTimer); searchTimer = setTimeout(requestRender, 150); });
  $('prev').addEventListener('click', () => { state.page = Math.max(0, state.page - 1); requestRender(); });
  $('next').addEventListener('click', () => { state.page = Math.min(pageCount - 1, state.page + 1); requestRender(); });
  $('sheet').addEventListener('change', event => host.postMessage({ action: 'sheet', name: event.target.value }));
  window.addEventListener('message', event => {
    if (window.gridiffHost && event.source !== null) return;
    if (event.data?.type === 'snapshot-replacing') {
      clearTimeout(searchTimer); state.query = ''; state.page = 0; $('search').value = ''; persist(); return;
    }
    if (event.data?.type === 'session-ended') {
      data = model = null; state.query = ''; clearTimeout(searchTimer);
      $('title').textContent = '比较已结束'; $('sources').textContent = ''; $('sources').title = '';
      $('summary').replaceChildren(); $('schema-content').replaceChildren(); $('schema-title').textContent = ''; $('schema').hidden = true;
      $('content').replaceChildren(); $('notice').textContent = event.data.message; $('error').hidden = true;
      $('status').textContent = '只读比较'; $('page').textContent = ''; $('search').value = '';
      $('sheet').replaceChildren(); $('sheet-label').hidden = true; $('keys').textContent = '主键'; $('format').textContent = '格式';
      document.querySelectorAll('button, input, select').forEach(node => { node.disabled = true; });
      return;
    }
    if (event.data?.type !== 'comparison') return;
    const changed = !data || revision !== event.data.revision || data.presentation !== event.data.presentation;
    data = event.data; model = data.result;
    if (revision !== data.revision) { if (!data.pageInfo) state.page = 0; revision = data.revision; }
    if (changed && !data.busy && data.viewState) { Object.assign(state, data.viewState); $('search').value = state.query; }
    $('title').textContent = data.title;
    $('sources').textContent = `旧 ${data.sources[0]} → 新 ${data.sources[1]}`; $('sources').title = $('sources').textContent;
    $('format').textContent = `格式：${formatNames[data.options.format]}${model && data.options.format === 'auto' ? ` (${model.formats.map(f => formatNames[f]).join(' / ')})` : ''}`;
    $('keys').textContent = data.options.alignment === 'position' ? '对齐：行号' : `主键：${model?.keys.join(' + ') || data.options.keyColumns?.join(' + ') || '自动'}`;
    document.querySelectorAll('[data-action]').forEach(button => { button.disabled = data.busy || (data.unsupported && button.dataset.action !== 'close'); });
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
    if (changed) { renderSummary(); renderSchema(); render(); }
  });
  host.postMessage({ action: 'ready', view: { ...state } });
})();
