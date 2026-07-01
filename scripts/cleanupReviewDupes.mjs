// One-off cleanup for "Needs Review" cards that are actually the PDF-only second
// email of a lead we already captured. Pairs each review card with the real
// lead received within a short window, moves the review card's attachments onto
// that lead, then deletes the review card.
//
// Dry run by default. Pass --apply to write/delete.
//   node scripts/cleanupReviewDupes.mjs
//   node scripts/cleanupReviewDupes.mjs --apply

import { execSync } from 'node:child_process';

const APPLY = process.argv.includes('--apply');
const WINDOW_MS = 180_000; // pair review card to a lead received within 3 min
const PROJECT = 'tvchub-f2401';
const BASE = `https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/(default)/documents`;
const token = execSync('gcloud auth print-access-token').toString().trim();
const headers = { Authorization: `Bearer ${token}`, 'x-goog-user-project': PROJECT };

const s = (f, k) => f?.[k]?.stringValue ?? null;
const num = (f, k) => Number(f?.[k]?.integerValue ?? f?.[k]?.doubleValue ?? 0);
const bool = (f, k) => f?.[k]?.booleanValue ?? false;
const attsOf = (f) => f?.attachments?.arrayValue?.values ?? [];
const attName = (a) => a?.mapValue?.fields?.name?.stringValue ?? '';

const docs = [];
let pt = '';
do {
  const r = await fetch(`${BASE}/leads?pageSize=300${pt ? `&pageToken=${pt}` : ''}`, { headers });
  const j = await r.json();
  (j.documents || []).forEach((d) => docs.push(d));
  pt = j.nextPageToken || '';
} while (pt);

const leads = docs.map((d) => ({ id: d.name.split('/').pop(), name: d.name, f: d.fields || {} }));
const reviews = leads.filter((l) => bool(l.f, 'needsReview'));
const goods = leads.filter((l) => !bool(l.f, 'needsReview'));

console.log(`Total ${leads.length} | review ${reviews.length} | good ${goods.length}`);
console.log(APPLY ? '\n*** APPLY MODE ***\n' : '\n(dry run — pass --apply to execute)\n');

for (const rev of reviews) {
  const rt = num(rev.f, 'receivedAt');
  const candidates = goods
    .map((g) => ({ g, dt: Math.abs(num(g.f, 'receivedAt') - rt) }))
    .filter((c) => c.dt <= WINDOW_MS)
    .sort((a, b) => a.dt - b.dt);

  if (candidates.length === 0) {
    console.log(`SKIP review ${rev.id} — no lead within ${WINDOW_MS / 1000}s; leave for manual review`);
    continue;
  }
  if (candidates.length > 1 && candidates[0].dt === candidates[1].dt) {
    console.log(`SKIP review ${rev.id} — ambiguous (multiple leads equidistant)`);
    continue;
  }

  const good = candidates[0].g;
  const goodAtts = attsOf(good.f);
  const goodNames = new Set(goodAtts.map(attName));
  const addAtts = attsOf(rev.f).filter((a) => !goodNames.has(attName(a)));

  console.log(
    `PAIR review ${rev.id} -> "${s(good.f, 'name')}" case ${s(good.f, 'tvcCaseNumber')} (${good.id}), ` +
      `${candidates[0].dt / 1000}s apart | moving ${addAtts.length} attachment(s) | then DELETE review`,
  );

  if (!APPLY) continue;

  if (addAtts.length) {
    const merged = [...goodAtts, ...addAtts];
    const fields = { attachments: { arrayValue: { values: merged } } };
    let mask = 'updateMask.fieldPaths=attachments';
    if (!s(good.f, 'pdfUrl') && addAtts[0]?.mapValue?.fields?.url) {
      fields.pdfUrl = { stringValue: addAtts[0].mapValue.fields.url.stringValue };
      mask += '&updateMask.fieldPaths=pdfUrl';
    }
    const pr = await fetch(`https://firestore.googleapis.com/v1/${good.name}?${mask}`, {
      method: 'PATCH',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ fields }),
    });
    console.log(pr.ok ? `  moved attachments to ${good.id}` : `  PATCH FAILED ${await pr.text()}`);
    if (!pr.ok) continue;
  }

  const dr = await fetch(`https://firestore.googleapis.com/v1/${rev.name}`, {
    method: 'DELETE',
    headers,
  });
  console.log(dr.ok ? `  deleted review ${rev.id}` : `  DELETE FAILED ${await dr.text()}`);
}

console.log('\nDone.');
