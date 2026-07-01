import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import fs from 'node:fs';
import { assembleFields, type Cell } from '../src/lib/tvcSpatial.ts';
import { parseTvc } from '../functions/src/parser.ts';

async function cellsOf(path: string): Promise<Cell[]> {
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
  return cells;
}

// Column-split: separate left/right columns, reconstruct clean per-column text.
function columnText(cells: Cell[]): string {
  const pages = [...new Set(cells.map((c) => c.page))].sort((a, b) => a - b);
  let out = '';
  for (const pg of pages) {
    const pcells = cells.filter((c) => c.page === pg);
    const rightHeaders = pcells.filter((c) =>
      /^(Attorney Info|Driver Info|Tickets|Case Coverage Type)$/i.test(c.str),
    );
    const splitX = rightHeaders.length
      ? Math.min(...rightHeaders.map((c) => c.x)) - 8
      : 9999;
    for (const side of [pcells.filter((c) => c.x < splitX), pcells.filter((c) => c.x >= splitX)]) {
      const rows: Cell[][] = [];
      for (const c of side.sort((a, b) => b.y - a.y || a.x - b.x)) {
        let row = rows.find((r) => Math.abs(r[0].y - c.y) <= 3);
        if (!row) { row = []; rows.push(row); }
        row.push(c);
      }
      for (const row of rows) out += row.sort((a, b) => a.x - b.x).map((c) => c.str).join(' ') + '\n';
    }
  }
  return out;
}

const FIELDS = ['name', 'address', 'phone', 'email', 'language', 'driversLicense', 'driversLicenseState', 'driversLicenseType', 'courtName', 'courtCity', 'county', 'state', 'courtZip', 'nextCourtDate', 'charge'];

async function run(path: string, ocrFile: string) {
  const cells = await cellsOf(path);
  const geo = assembleFields(cells).fields as Record<string, unknown>;
  const col = parseTvc(columnText(cells)).fields as Record<string, unknown>;
  const ocr = parseTvc(fs.readFileSync(ocrFile, 'utf8')).fields as Record<string, unknown>;
  console.log('\n===== ' + path.split('/').pop() + ' =====');
  console.log('field'.padEnd(20), 'GEOMETRIC'.padEnd(28), 'COLUMN-SPLIT'.padEnd(28), 'OCR');
  for (const f of FIELDS) {
    console.log(
      f.padEnd(20),
      String(geo[f] ?? '—').slice(0, 26).padEnd(28),
      String(col[f] ?? '—').slice(0, 26).padEnd(28),
      String(ocr[f] ?? '—').slice(0, 26),
    );
  }
}

await run(
  '/Users/jodyshackelford/Downloads/ironrocklaw.com Mail - 25%-TVC Legal Case_ 1540425 Luis Dionisio Garcia.pdf',
  '/tmp/ocr_email.txt',
);
await run('/Users/jodyshackelford/Downloads/50526533.PDF', '/tmp/ocr_attach.txt');
