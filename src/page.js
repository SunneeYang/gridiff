'use strict';

const escape = value => String(value).replace(/[&<>"]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[char]));

function pageHTML({ resource, nonce = '', csp, browser = false }) {
  return `<!doctype html>
<html lang="zh-CN" data-style="material" data-layout="matrix"${browser ? ' data-host="browser"' : ''}><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="${escape(csp)}">
<link rel="stylesheet" href="${escape(resource('main.css'))}">${browser ? `<link rel="stylesheet" href="${escape(resource('themes.css'))}"><script src="${escape(resource('themes.js'))}"></script>` : ''}<title>Gridiff</title></head>
<body><main id="app">
<header class="page-header"><div class="heading"><h1 id="title">正在读取文件…</h1><div id="sources" aria-label="旧版本与新版本"></div></div>
<div class="actions"><details id="settings"><summary>来源与设置</summary><div class="settings-body">
<h2>比较来源</h2><div id="source-details"></div><p id="notice" class="muted"></p>
<h2>读取设置</h2><div class="actions"><button id="format" data-action="format">格式：自动</button><button id="keys" data-action="keys">主键：自动</button></div>
<h2>阅读与外观</h2><div class="theme-controls">
<label>组件风格<select id="theme-style" aria-label="组件风格"><option value="github">GitHub</option><option value="material" selected>Material</option><option value="soft">Soft UI</option><option value="brutalist">Neo Brutalist</option></select></label>
<label>阅读布局<select id="read-layout" aria-label="阅读布局"><option value="matrix">精密矩阵</option><option value="paper">纸面校对</option><option value="focus">焦点审阅</option><option value="terminal">紧凑终端</option></select></label>
${browser ? '<label>明暗<select id="theme-mode" aria-label="明暗"><option value="system">跟随系统</option><option value="light">浅色</option><option value="dark">深色</option></select></label><label>配色<select id="theme-palette" aria-label="配色"><option value="default">默认</option><option value="github">GitHub</option><option value="catppuccin">Catppuccin</option><option value="solarized">Solarized</option><option value="nord">Nord</option></select></label>' : '<p class="muted">配色与明暗跟随编辑器主题。</p>'}
</div><span id="theme-save-status" role="status"></span></div></details>
<button data-action="swap">交换左右</button><button data-action="refresh">${browser ? '重新计算' : '重新读取'}</button><button data-action="native"${browser ? ' hidden' : ''}>文本对比 ↗</button>${browser ? '<button data-action="close">结束比较</button>' : ''}</div></header>
<section id="summary" aria-label="当前表全部变化"></section>
<details id="schema" hidden><summary id="schema-title"></summary><div id="schema-content" tabindex="0" role="region" aria-label="字段变化列表"></div></details>
<section class="toolbar" aria-label="筛选与视图"><div class="tabs" role="group" aria-label="视图"><button id="grid-tab" aria-pressed="true">原表对照</button><button id="list-tab" aria-pressed="false">变更清单</button></div>
<label id="sheet-label" hidden>工作表 <select id="sheet" aria-label="工作表"></select></label>
<label>字段 <select id="field-filter" aria-label="按字段筛选记录"><option value="">全部字段</option></select></label>
<label><input id="only-changes" type="checkbox" checked>仅看变动记录</label><label title="保留新增记录的非空字段与修改字段的并集；仅有删除时保留删除记录的非空字段。搜索和翻页不改变列集合"><input id="only-fields" type="checkbox" checked>仅看变动字段</label>
<label class="search-label"><span class="sr-only">搜索记录或值</span><input id="search" type="search" placeholder="搜索记录或值" aria-label="搜索记录或值"></label></section>
<div id="review-notice" role="status"></div><div id="error" role="alert" hidden></div>
<div class="result-bar"><span id="results" role="status"></span><button id="clear-filters" hidden>清除筛选</button><nav aria-label="记录定位"><button id="previous-record" disabled>上一条</button><span id="record-position">尚未定位</span><button id="next-record" disabled>下一条</button></nav></div>
<p id="filter-note" class="muted" hidden>当前仅显示筛选命中的记录；上方统计仍是当前表的全部变化。</p>
<section id="content" aria-label="差异内容" aria-busy="true"></section>
<footer><span id="status">只读比较</span><nav aria-label="记录分页"><button id="prev">← 上一页</button><span id="page"></span><button id="next">下一页 →</button></nav></footer>
</main>${(browser ? ['browser.js', 'main.js'] : ['view.js', 'main.js']).map(name => `<script${nonce ? ` nonce="${escape(nonce)}"` : ''} src="${escape(resource(name))}"></script>`).join('')}</body></html>`;
}

module.exports = { pageHTML };
