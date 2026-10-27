'use strict';
(() => {
  const storageKey = `gridiff:${location.pathname}`;
  let current, busy = false, ended = false, heartbeat, worker, pending, requestId = 0;
  const emit = data => window.dispatchEvent(new MessageEvent('message', { data }));
  function savedState() {
    try { return JSON.parse(sessionStorage.getItem(storageKey)) || {}; } catch { return {}; }
  }
  function finish(message) {
    ended = true; current = null; clearInterval(heartbeat);
    worker?.terminate(); worker = null;
    pending?.reject(new Error(message)); pending = null;
    document.querySelector('dialog')?.remove();
    try { sessionStorage.removeItem(storageKey); sessionStorage.removeItem(`${storageKey}:comparison`); } catch { /* Storage may be disabled. */ }
    emit({ type: 'session-ended', message });
  }
  function showError(message) {
    const node = document.getElementById('error');
    node.hidden = false; node.textContent = message;
  }
  async function request(endpoint, body) {
    let response;
    try {
      response = await fetch(endpoint, { method: body === undefined ? 'GET' : 'POST',
        headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body), cache: 'no-store', credentials: 'omit', signal: AbortSignal.timeout(15000) });
    } catch {
      finish('无法连接本地 Gridiff 服务，会话可能已过期。请从 Fork 重新打开比较。');
      return null;
    }
    if (response.status === 404 || response.status === 410) {
      finish('比较会话已结束或过期。请从 Fork 重新打开比较。');
      return null;
    }
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      throw new Error(data.error || '操作未完成，请重试。');
    }
    return response.status === 204 ? null : response.json();
  }
  async function update(message) {
    if (ended || busy) return;
    busy = true;
    if (current) emit({ ...current, busy: true });
    try {
      if (!worker) {
        const snapshot = await request('snapshot');
        if (ended || !snapshot) return;
        worker = new Worker('worker.js', { type: 'module' });
        worker.onmessage = event => {
          if (!pending || pending.id !== event.data?.id) return;
          const request = pending; pending = null;
          if (event.data.error) request.reject(new Error(event.data.error)); else request.resolve(event.data.data);
        };
        worker.onerror = () => finish('比较程序无法运行。请从 Fork 重新打开比较。');
        let settings;
        try { settings = JSON.parse(sessionStorage.getItem(`${storageKey}:comparison`)); } catch { /* Ignore invalid preferences. */ }
        message = { action: 'load', snapshot, settings };
      } else {
        await request('heartbeat', {});
        if (ended) return;
      }
      const data = await new Promise((resolve, reject) => {
        const id = ++requestId;
        pending = { id, resolve, reject };
        worker.postMessage({ ...message, id });
      });
      if (data && !ended) {
        try { sessionStorage.setItem(`${storageKey}:comparison`, JSON.stringify(data.settings)); } catch { /* Storage may be disabled. */ }
        current = data; emit(data);
      }
    } catch (error) {
      if (current && !ended) emit(current);
      if (!ended) showError(error.message);
    } finally { busy = false; }
  }
  function element(tag, text) {
    const node = document.createElement(tag);
    if (text !== undefined) node.textContent = text;
    return node;
  }
  function field(form, text, input) {
    input.setAttribute('aria-label', text);
    const label = element('label', text); label.append(input); form.append(label); return input;
  }
  function select(values, value) {
    const node = element('select');
    for (const [key, title] of values) {
      const option = element('option', title); option.value = key; option.selected = key === value; node.append(option);
    }
    return node;
  }
  function dialog(title, populate) {
    if (ended || busy || !current || document.querySelector('dialog')) return;
    const popup = element('dialog'), form = element('form'), heading = element('h2', title);
    heading.id = 'settings-title'; popup.setAttribute('aria-labelledby', heading.id);
    form.append(heading);
    const read = populate(form);
    const error = element('p'); error.className = 'settings-error'; error.setAttribute('role', 'alert');
    const actions = element('div'); actions.className = 'settings-actions';
    const cancel = element('button', '取消'); cancel.type = 'button';
    const submit = element('button', '应用'); submit.type = 'submit';
    cancel.addEventListener('click', () => popup.close());
    actions.append(cancel, submit); form.append(error, actions); popup.append(form); document.body.append(popup);
    popup.addEventListener('close', () => popup.remove());
    form.addEventListener('submit', event => {
      event.preventDefault();
      try { const options = read(); popup.close(); void update({ action: 'options', options }); }
      catch (failure) { error.textContent = failure.message; }
    });
    popup.showModal();
  }
  function chooseFormat() {
    dialog('表头格式', form => {
      const options = current.options;
      const format = field(form, '格式', select([
        ['auto', '自动'], ['csv', '一行表头'], ['mova', 'Mova 四行表头'], ['mova-vertical', 'Mova 竖表'],
        ['headerless', '无表头'], ['custom', '自定义表头']
      ], options.format));
      const custom = element('fieldset'), legend = element('legend', '自定义记录位置'); custom.append(legend); form.append(custom);
      const inputs = {};
      for (const [name, label, fallback, minimum] of [
        ['headerRow', '字段名所在记录', 1, 1], ['dataStartRow', '数据起始记录', 2, 1], ['descriptionRow', '说明所在记录（0 表示无）', 0, 0]
      ]) {
        const input = element('input'); input.type = 'number'; input.min = minimum; input.step = 1;
        input.value = options[name] ?? fallback; input.required = true; inputs[name] = field(custom, label, input);
      }
      const toggle = () => { custom.hidden = format.value !== 'custom'; custom.disabled = custom.hidden; };
      format.addEventListener('change', toggle); toggle();
      return () => {
        const next = { ...options, format: format.value };
        if (next.format === 'custom') {
          for (const [name, input] of Object.entries(inputs)) next[name] = Number(input.value);
          if (next.dataStartRow <= next.headerRow || next.descriptionRow >= next.dataStartRow ||
            (next.descriptionRow && next.descriptionRow === next.headerRow)) throw new Error('字段名和说明须位于数据之前，且不能是同一记录。');
        }
        return next;
      };
    });
  }
  function chooseKeys() {
    dialog('记录对齐方式', form => {
      const options = current.options;
      const alignment = field(form, '对齐方式', select([
        ['auto', '自动选择主键'], ['key', '指定主键（可多选）'], ['position', '按行号对齐']
      ], options.alignment === 'position' ? 'position' : options.keyColumns?.length ? 'key' : 'auto'));
      const fields = element('fieldset'), legend = element('legend', '两侧共有的字段'); fields.append(legend); form.append(fields);
      const picks = [];
      for (const item of current.keyFields || []) {
        const input = element('input'); input.type = 'checkbox'; input.value = item.name;
        input.checked = options.keyColumns?.includes(item.name) || false;
        const label = element('label'); label.className = 'key-choice';
        label.append(input, document.createTextNode(item.label && item.label !== item.name ? `${item.name} · ${item.label}` : item.name));
        fields.append(label); picks.push(input);
      }
      if (!picks.length) fields.append(element('p', '没有可选字段，请先调整表头格式。'));
      const warning = element('p', '按行号对齐时，插入或删除记录可能使后续记录错位。'); warning.className = 'muted'; form.append(warning);
      const toggle = () => { fields.hidden = alignment.value !== 'key'; fields.disabled = fields.hidden; warning.hidden = alignment.value !== 'position'; };
      alignment.addEventListener('change', toggle); toggle();
      return () => {
        const keyColumns = alignment.value === 'key' ? picks.filter(input => input.checked).map(input => input.value) : [];
        if (alignment.value === 'key' && !keyColumns.length) throw new Error('请至少选择一个主键字段。');
        return { ...options, alignment: alignment.value === 'position' ? 'position' : 'key', keyColumns };
      };
    });
  }
  async function close() {
    if (ended || busy) return;
    busy = true;
    if (current) emit({ ...current, busy: true });
    try { await request('close', {}); if (!ended) finish('比较已结束，内存中的数据已释放。可以关闭此标签页。'); }
    catch (error) { if (current && !ended) emit(current); showError(error.message); }
    finally { busy = false; }
  }
  window.gridiffHost = {
    getState: savedState,
    setState(value) {
      // Only view preferences are persisted; source content stays in memory.
      try { sessionStorage.setItem(storageKey, JSON.stringify(value)); } catch { /* Storage may be disabled. */ }
    },
    postMessage(message) {
      if (ended) return;
      if (message.action === 'ready') {
        void update();
        heartbeat = setInterval(() => { void request('heartbeat', {}).catch(error => {
          clearInterval(heartbeat); showError(error.message);
        }); }, 30000);
      } else if (message.action === 'format') chooseFormat();
      else if (message.action === 'keys') chooseKeys();
      else if (message.action === 'close') void close();
      else if (['swap', 'sheet', 'refresh'].includes(message.action)) void update(message);
    }
  };
})();
