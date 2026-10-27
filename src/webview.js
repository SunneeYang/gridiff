'use strict';
const { randomBytes } = require('node:crypto');
const vscode = require('vscode');
const { pageHTML } = require('./page');

function webviewHTML(webview, extensionUri) {
  const nonce = randomBytes(24).toString('base64');
  const resource = name => webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', name));
  return pageHTML({ resource, nonce, csp: `default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';` });
}
module.exports = { webviewHTML };
