'use strict';
const { Workbook } = require('exceljs');

async function workbook(sheets, edit = () => {}) {
  const book = new Workbook();
  for (const [name, rows] of Object.entries(sheets)) book.addWorksheet(name).addRows(rows);
  edit(book);
  return Buffer.from(await book.xlsx.writeBuffer());
}

async function rewriteZip(buffer, edit) {
  const JSZip = require(require.resolve('jszip', { paths: [require.resolve('exceljs')] }));
  const zip = await JSZip.loadAsync(buffer);
  await edit(zip);
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

module.exports = { workbook, rewriteZip };
