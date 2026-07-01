import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import fs from 'node:fs';

const path = process.argv[2];
const data = new Uint8Array(fs.readFileSync(path));
const pdf = await getDocument({ data, useSystemFonts: true }).promise;
let out = '';
for (let p = 1; p <= pdf.numPages; p++) {
  const page = await pdf.getPage(p);
  const content = await page.getTextContent();
  const rows = content.items
    .map((it) => (typeof it.str === 'string' && it.transform ? { x: it.transform[4], y: it.transform[5], str: it.str } : null))
    .filter((r) => r && r.str.trim().length > 0);
  rows.sort((a, b) => (Math.abs(a.y - b.y) > 3 ? b.y - a.y : a.x - b.x));
  let lastY = null;
  for (const r of rows) {
    if (lastY !== null) out += Math.abs(r.y - lastY) > 3 ? '\n' : ' ';
    out += r.str;
    lastY = r.y;
  }
  out += '\n';
}
console.log(out);
