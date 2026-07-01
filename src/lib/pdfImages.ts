// Polyfill the TC39 Map/WeakMap "upsert" methods that recent pdf.js builds use
// but most browsers don't implement yet (otherwise page.render throws
// "getOrInsertComputed is not a function").
function patchUpsert(proto: { has: (k: unknown) => boolean; get: (k: unknown) => unknown; set: (k: unknown, v: unknown) => unknown }) {
  const p = proto as unknown as Record<string, unknown>;
  if (typeof p.getOrInsertComputed !== 'function') {
    p.getOrInsertComputed = function (this: typeof proto, key: unknown, fn: (k: unknown) => unknown) {
      if (!this.has(key)) this.set(key, fn(key));
      return this.get(key);
    };
  }
  if (typeof p.getOrInsert !== 'function') {
    p.getOrInsert = function (this: typeof proto, key: unknown, val: unknown) {
      if (!this.has(key)) this.set(key, val);
      return this.get(key);
    };
  }
}
patchUpsert(Map.prototype);
patchUpsert(WeakMap.prototype as unknown as { has: (k: unknown) => boolean; get: (k: unknown) => unknown; set: (k: unknown, v: unknown) => unknown });

import * as pdfjs from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

// Renders each PDF page to a base64 PNG (no data: prefix) for the LLM extractor.
// Done in the browser so the OpenAI key can stay server-side.
export async function pdfToImages(file: File, scale = 2): Promise<string[]> {
  const data = await file.arrayBuffer();
  const pdf = await pdfjs.getDocument({ data }).promise;
  const images: string[] = [];
  for (let p = 1; p <= pdf.numPages; p++) {
    const page = await pdf.getPage(p);
    const viewport = page.getViewport({ scale });
    const canvas = document.createElement('canvas');
    canvas.width = Math.ceil(viewport.width);
    canvas.height = Math.ceil(viewport.height);
    const ctx = canvas.getContext('2d');
    if (!ctx) continue;
    await page.render({ canvas, canvasContext: ctx, viewport }).promise;
    images.push(canvas.toDataURL('image/png').split(',')[1]);
  }
  return images;
}
