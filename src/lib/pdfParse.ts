import * as pdfjs from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { assembleFields, type Cell, type ParseResult } from './tvcSpatial';

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

// TVC referral sheets are a fixed two-column form whose PDF text layer, when
// flattened, interleaves columns and splits wrapped labels across lines. We
// keep each text run's (x, y) coordinates and reconstruct the form spatially in
// tvcSpatial.ts. This module only handles pdf.js extraction.

async function extractCells(file: File): Promise<Cell[]> {
  const data = await file.arrayBuffer();
  const pdf = await pdfjs.getDocument({ data }).promise;
  const cells: Cell[] = [];
  for (let p = 1; p <= pdf.numPages; p++) {
    const page = await pdf.getPage(p);
    const content = await page.getTextContent();
    for (const it of content.items) {
      const item = it as { str?: string; width?: number; transform?: number[] };
      if (typeof item.str !== 'string' || !item.transform) continue;
      const str = item.str.replace(/\s+/g, ' ').trim();
      if (!str) continue;
      cells.push({
        page: p,
        x: Math.round(item.transform[4]),
        y: Math.round(item.transform[5]),
        w: Math.round(item.width ?? 0),
        str,
      });
    }
  }
  return cells;
}

export type { ParseResult };

export async function parsePdfFile(file: File): Promise<ParseResult> {
  const cells = await extractCells(file);
  return assembleFields(cells);
}
