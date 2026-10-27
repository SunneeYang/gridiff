'use strict';
const { randomBytes } = require('node:crypto');
const vscode = require('vscode');

function webviewHTML(webview, extensionUri) {
  const nonce = randomBytes(24).toString('base64');
  const resource = name => webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', name));
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
<link rel="stylesheet" href="${resource('main.css')}"><title>Gridiff</title></head>
<body><main id="app">
<header><div><span class="brand">GRID IFF<span class="dot"> / </span>表格差异</span><h1 id="title">正在读取文件…</h1><p id="sources" class="muted"></p></div>
<div class="actions"><button data-action="swap">交换左右</button><button data-action="refresh">重新读取</button><button data-action="native">文本对比 ↗</button></div></header>
<section class="toolbar" aria-label="比较设置"><div class="tabs" role="group" aria-label="视图"><button id="grid-tab" aria-pressed="true">原表对照</button><button id="list-tab" aria-pressed="false">变更清单</button></div>
<button id="format" data-action="format">格式：自动</button><button id="keys" data-action="keys">主键：自动</button>
<label><input id="only-changes" type="checkbox" checked>仅看变动记录</label><label title="显示新增行的非空字段与修改字段的并集；仅有删除时显示删除行的非空字段。搜索和翻页不改变列集合"><input id="only-fields" type="checkbox" checked>仅看变动字段</label>
<label class="search-label"><span class="sr-only">搜索记录或值</span><input id="search" type="search" placeholder="搜索记录或值" aria-label="搜索记录或值"></label></section>
<div id="notice" role="status"></div><div id="error" role="alert" hidden></div>
<section id="summary" aria-label="变化统计"></section><details id="schema" hidden><summary id="schema-title"></summary><div id="schema-content" tabindex="0" role="region" aria-label="字段变化列表"></div></details>
<section id="content" aria-label="差异内容"></section>
<footer><span id="status"></span><nav aria-label="记录分页"><button id="prev">← 上一页</button><span id="page"></span><button id="next">下一页 →</button></nav></footer>
</main><script nonce="${nonce}" src="${resource('main.js')}"></script></body></html>`;
}
module.exports = { webviewHTML };
