import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import fs from 'node:fs';
import { assembleFields, type Cell } from '../src/lib/tvcSpatial.ts';

const path = process.argv[2];
const data = new Uint8Array(fs.readFileSync(path));
const pdf = await getDocument({ data, useSystemFonts: true }).promise;
const cells: Cell[] = [];
for (let p = 1; p <= pdf.numPages; p++) {
  const page = await pdf.getPage(p);
  const content = await page.getTextContent();
  for (const it of content.items as Array<{ str?: string; width?: number; transform?: number[] }>) {
    if (typeof it.str !== 'string' || !it.transform) continue;
    const str = it.str.replace(/\s+/g, ' ').trim();
    if (!str) continue;
    cells.push({ page: p, x: Math.round(it.transform[4]), y: Math.round(it.transform[5]), w: Math.round(it.width ?? 0), str });
  }
}
const r = assembleFields(cells);
console.log('matched:', r.matchedCount);
console.log(JSON.stringify(r.fields, null, 2));
