import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import fs from 'node:fs';

const path = process.argv[2];
const pageNum = parseInt(process.argv[3] || '2', 10);
const data = new Uint8Array(fs.readFileSync(path));
const pdf = await getDocument({ data, useSystemFonts: true }).promise;
const page = await pdf.getPage(pageNum);
const content = await page.getTextContent();
const items = content.items
  .map((it) => (typeof it.str === 'string' && it.transform ? { x: Math.round(it.transform[4]), y: Math.round(it.transform[5]), w: Math.round(it.width), str: it.str } : null))
  .filter((r) => r && r.str.trim().length > 0);

// group rows by y
const rows = [];
for (const it of items) {
  let row = rows.find((r) => Math.abs(r.y - it.y) <= 3);
  if (!row) { row = { y: it.y, cells: [] }; rows.push(row); }
  row.cells.push(it);
}
rows.sort((a, b) => b.y - a.y);
for (const r of rows) {
  r.cells.sort((a, b) => a.x - b.x);
  console.log(
    'y=' + r.y,
    r.cells.map((c) => `[x${c.x} w${c.w}] ${c.str}`).join('  ||  '),
  );
}
