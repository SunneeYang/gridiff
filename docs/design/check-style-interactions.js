// Run this expression in the opened prototype's browser console or preview_evaluate.
// It checks rendered behavior and restores the original demo state afterwards.
(() => {
  const saved = {state: {...state}, appearance: {...appearance}, identity: visible[state.cursor]?.[0], gallery: document.getElementById('component-gallery').open};
  let passed = 0;
  const assert = (condition, name) => { if (!condition) throw new Error(name); passed++; };
  const change = (id, value) => { const input = document.getElementById(id); input.value = value; input.dispatchEvent(new Event('change')); };
  const choose = id => change('layout', id);
  const expected = {matrix: '.grid', paper: '.proof-document', focus: '.focus-workspace', terminal: '.patch-stream'};
  try {
    change('scenario', 'normal'); change('sheet', 'items'); change('field', 'price');
    document.getElementById('only').checked = true;
    document.getElementById('only').dispatchEvent(new Event('change'));
    choose('matrix');
    document.getElementById('next').click(); document.getElementById('next').click();
    const palette = appearance.palette;
    for (const id of Object.keys(expected)) {
      choose(id);
      assert(document.querySelector('#content ' + expected[id]), id + ': distinct renderer');
      assert(appearance.palette === palette, id + ': palette unchanged');
      assert(state.field === 'price' && visible.length === 4, id + ': filtered records preserved');
      assert(visible[state.cursor]?.[0] === '100102', id + ': record selection preserved');
      if (id === 'focus') {
        assert(document.querySelectorAll('.queue-item').length === 4, 'focus: complete queue');
        assert(document.querySelectorAll('.focus-detail').length === 1, 'focus: exactly one detail');
        assert(document.querySelector('.focus-detail').textContent.includes('魔力药水'), 'focus: selected record displayed');
      }
      document.getElementById('grid-view').click();
      assert(document.querySelector('#content .grid'), id + ': original table remains available');
      assert(visible[state.cursor]?.[0] === '100102', id + ': original-table toggle preserves record');
    }
    for (const id of Object.keys(expected)) {
      choose(id);
      const query = document.getElementById('query'); query.value = '没有这条记录'; query.dispatchEvent(new Event('input'));
      assert(document.querySelector('[data-empty]') && visible.length === 0, id + ': empty state');
      assert(document.getElementById('next').disabled, id + ': empty navigation disabled');
      document.querySelector('[data-empty]').click();
      assert(visible.length === 6, id + ': empty recovery includes schema-only record');
      assert(document.activeElement.id === 'query', id + ': empty recovery returns keyboard focus');
      change('scenario', 'loading');
      assert(document.getElementById('content').getAttribute('aria-busy') === 'true', id + ': loading state');
      assert(document.getElementById('field').disabled, id + ': loading controls disabled');
      change('scenario', 'error');
      assert(document.querySelector('#content [role="alert"]'), id + ': failure state');
      document.querySelector('[data-recover]').click();
      assert(visible.length === 6 && !document.getElementById('field').disabled, id + ': failure recovery');
      assert(document.activeElement.id === 'query', id + ': failure recovery returns keyboard focus');
      change('scenario', 'long');
      assert(document.getElementById('content').textContent.includes('这段文字只用于测试'), id + ': full long-text content exists');
      for (const details of document.querySelectorAll('#content .long-value')) details.open = true;
      assert(document.getElementById('content').textContent.includes('战斗中与战斗外都可使用'), id + ': appended change retained');
      change('scenario', 'normal');
    }
    choose('focus');
    document.querySelector('[data-select-record="2"]').click();
    assert(document.querySelector('.focus-detail').textContent.includes('祝福石'), 'focus: queue click selects record');
    document.getElementById('next').click();
    assert(document.querySelector('.focus-detail').textContent.includes('复苏药剂'), 'focus: next record');
    document.getElementById('previous').click();
    assert(document.querySelector('.focus-detail').textContent.includes('祝福石'), 'focus: previous record');
    const selectedVisible = () => {
      const queue = document.querySelector('.record-queue').getBoundingClientRect();
      const item = document.querySelector('.queue-item[aria-pressed="true"]').getBoundingClientRect();
      return item.left >= queue.left - 1 && item.right <= queue.right + 1 && item.top >= queue.top - 1 && item.bottom <= queue.bottom + 1;
    };
    document.querySelector('.record-queue').scrollLeft = 600;
    document.querySelector('[data-select-record="5"]').click();
    assert(document.querySelector('.focus-detail').textContent.includes('100106'), 'focus: last record selected');
    assert(selectedVisible(), 'focus: selected queue item remains visible after rebuild');
    document.getElementById('previous').click();
    assert(selectedVisible(), 'focus: previous queue item stays visible');
    document.getElementById('next').click();
    assert(selectedVisible(), 'focus: next queue item stays visible');
    choose('paper');
    const record = document.querySelector('.proof-record.current').getBoundingClientRect();
    const viewport = document.getElementById('content').getBoundingClientRect();
    assert(record.top < viewport.bottom && record.bottom > viewport.top, 'layout switch keeps selected record in view');
    choose('focus');
    assert(visible[state.cursor]?.[0] === '100106', 'focus: last selection survives style switch');
    assert(selectedVisible(), 'focus: restored selection stays visible');
    choose('matrix'); change('field', 'price');
    const query = document.getElementById('query'); query.value = '药'; query.dispatchEvent(new Event('input'));
    document.getElementById('next').click();
    const table = document.querySelector('#content .grid'), identity = visible[state.cursor][0];
    const signatures = [];
    for (const id of Object.keys(styles)) {
      change('style', id);
      assert(document.querySelector('[data-style-choice="' + id + '"]').getAttribute('aria-pressed') === 'true', id + ': compact selector syncs specimen');
      assert(document.querySelector('#content .grid') === table, id + ': style preserves the actual table DOM');
      assert(appearance.layout === 'matrix' && state.view === 'grid', id + ': style does not switch layout');
      assert(state.field === 'price' && state.query === '药' && visible[state.cursor][0] === identity, id + ': filters and record unchanged');
      const button = getComputedStyle(document.getElementById('next'));
      const input = getComputedStyle(query), tabs = getComputedStyle(document.getElementById('grid-view'));
      signatures.push([button.borderRadius, button.borderTopWidth, button.boxShadow, input.borderRadius, input.borderBottomWidth, tabs.borderBottomWidth].join('|'));
      assert(parseFloat(button.minHeight) >= 44, id + ': button target stays at least 44px');
      const before = document.querySelector('.value.before'), after = document.querySelector('.value.after');
      assert(getComputedStyle(before).backgroundColor !== getComputedStyle(after).backgroundColor, id + ': old/new semantics preserved');
      const next = document.getElementById('next'); next.disabled = true;
      assert(getComputedStyle(next).color === getComputedStyle(document.getElementById('footer')).color, id + ': primary disabled text uses muted role');
      assert(getComputedStyle(next).boxShadow === 'none', id + ': disabled button loses elevation');
      next.disabled = false;
    }
    assert(new Set(signatures).size === 4, 'four component families have distinct computed geometry and depth');
    document.getElementById('component-gallery').open = true;
    document.querySelector('[data-style-choice="material"]').click();
    assert(document.getElementById('style').value === 'material', 'specimen syncs compact selector');
    document.getElementById('component-gallery').open = false;
    assert(document.querySelector('tbody tr').getBoundingClientRect().top < innerHeight, 'table begins in first viewport with specimens collapsed');
    document.getElementById('reset').focus(); document.getElementById('reset').click();
    assert(document.activeElement.id === 'query', 'clear filters keeps keyboard focus in search');
    const settings = document.getElementById('settings'); settings.open = true;
    document.querySelector('#settings summary').focus();
    document.dispatchEvent(new KeyboardEvent('keydown', {key: 'Escape', bubbles: true}));
    assert(!settings.open, 'Escape closes settings');
    assert(document.activeElement === settings.querySelector('summary'), 'Escape returns focus to settings trigger');
    settings.open = true; document.getElementById('query').click();
    assert(!settings.open, 'outside click closes settings');
    return {passed, layouts: Object.keys(expected), styles: Object.keys(styles), note: 'DOM, component geometry and fixture behavior only; visual review is separate.'};
  } finally {
    Object.assign(state, saved.state); Object.assign(appearance, saved.appearance);
    document.getElementById('sheet').value = state.sheet; document.getElementById('scenario').value = state.scenario;
    document.getElementById('only').checked = state.only; document.getElementById('query').value = state.query;
    setFields(); document.getElementById('field').value = state.field;
    document.getElementById('component-gallery').open = saved.gallery;
    applyTheme(); applyStyle(); render(saved.identity);
  }
})();
