'use strict';
const { readTableRows } = require('./csv');
const { readWorkbookData } = require('./xlsx-core');

const MAX_BYTES = 8 * 1024 * 1024;
const MAX_EXPANDED_BYTES = 64 * 1024 * 1024;
const MAX_CELLS = 1000000;

// Validate the expanded archive before the workbook library allocates its model.
async function validateArchive(buffer) {
  const zip = await require('yauzl').fromBufferPromise(buffer);
  const { SaxesParser } = require('saxes');
  let bytes = 0, declaredBytes = 0, entries = 0, cells = 0, rows = 0;
  const names = new Set();
  try {
    for await (const entry of zip.eachEntry()) {
      if (++entries > 10000) throw new Error('XLSX 压缩包文件数量超过 10000。');
      if (names.has(entry.fileName)) throw new Error('XLSX 压缩包包含重复文件。');
      names.add(entry.fileName);
      declaredBytes += entry.uncompressedSize;
      if (declaredBytes > MAX_EXPANDED_BYTES) throw new Error('XLSX 解压后超过 64 MiB，请缩小工作簿。');
      if (entry.isEncrypted()) throw new Error('暂不支持加密的 XLSX。');
      const xml = /\.(xml|rels)$/i.test(entry.fileName) ? new SaxesParser() : null;
      let decoder, prefix = Buffer.alloc(0);
      if (xml) {
        xml.on('doctype', () => { throw new Error('XLSX XML 不允许包含 DTD。'); });
        let currentRow;
        if (/^xl\/worksheets\/[^/]+\.xml$/.test(entry.fileName)) xml.on('opentag', tag => {
          const name = tag.name.split(':').at(-1);
          if (name === 'row') {
            const row = Number(tag.attributes.r);
            currentRow = row;
            if (++rows > MAX_CELLS || !Number.isInteger(row) || row < 1 || row > 1048576) throw new Error('XLSX 行范围过大或行号无效。');
          }
          if (name === 'c') {
            const address = /^([A-Z]{1,3})([1-9]\d*)$/.exec(tag.attributes.r || '');
            const col = address?.[1].split('').reduce((n, c) => n * 26 + c.charCodeAt(0) - 64, 0);
            if (++cells > MAX_CELLS || !address || col > 16384 || Number(address[2]) !== currentRow) throw new Error('XLSX 超过 100 万单元格或单元格坐标无效。');
          }
        });
      }
      const stream = await zip.openReadStreamPromise(entry);
      for await (let chunk of stream) {
        bytes += chunk.length;
        if (bytes > MAX_EXPANDED_BYTES) throw new Error('XLSX 解压后超过 64 MiB，请缩小工作簿。');
        if (!xml) continue;
        if (!decoder) {
          chunk = Buffer.concat([prefix, chunk]);
          if (chunk.length < 2) { prefix = chunk; continue; }
          // Excel customXml parts may use a UTF-16 BOM instead of UTF-8.
          const encoding = chunk[0] === 0xff && chunk[1] === 0xfe ? 'utf-16le' :
            chunk[0] === 0xfe && chunk[1] === 0xff ? 'utf-16be' : 'utf-8';
          decoder = new TextDecoder(encoding, { fatal: true });
        }
        xml.write(decoder.decode(chunk, { stream: true }));
      }
      xml?.write(decoder ? decoder.decode() : new TextDecoder('utf-8', { fatal: true }).decode(prefix)).close();
    }
    if (!names.has('xl/workbook.xml')) throw new Error('文件不是有效的 XLSX 工作簿。');
  } finally { zip.close(); }
}

async function readWorkbook(input) {
  const buffer = Buffer.from(input);
  if (buffer.length > MAX_BYTES) throw new Error('单侧文件超过 8 MiB，请缩小工作簿。');
  try {
    await validateArchive(buffer);
    // Use the pinned Workbook implementation without bundling unused streaming readers/writers.
    const Workbook = require('exceljs/lib/doc/workbook');
    return await readWorkbookData(Workbook, buffer);
  } catch (error) { throw new Error(`无法读取 XLSX：${error.message}`); }
}

function worksheetTable(sheet, options) {
  return readTableRows(sheet?.values || [], options, sheet?.metadata || []);
}

module.exports = { readWorkbook, worksheetTable };
