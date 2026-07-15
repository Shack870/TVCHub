// One-off repair for the four "Needs Review" cards of 2026-07-15 (see chat):
//  - Ronald Brisa: full data, name missing from extraction -> rename, unflag
//  - Manuel Costa / Mahareb Omreh: PDF-only dupes of existing good leads ->
//    move attachments onto the good lead, delete the review card
//  - Alberta King: a "member has questions" message, not a referral -> name it
//    and set the case number, keep the review flag (no phone/court data)
//
// Dry run by default; pass --apply to execute.

import { execSync } from 'node:child_process';

const APPLY = process.argv.includes('--apply');
const PROJECT = 'tvchub-f2401';
const BASE = `https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/(default)/documents`;
const token = execSync('gcloud auth print-access-token').toString().trim();
const headers = { Authorization: `Bearer ${token}`, 'x-goog-user-project': PROJECT };

console.log(APPLY ? '*** APPLY MODE ***\n' : '(dry run — pass --apply to execute)\n');

async function getDoc(id) {
  const r = await fetch(`${BASE}/leads/${id}`, { headers });
  if (!r.ok) throw new Error(`GET ${id}: ${r.status}`);
  return r.json();
}

async function patchDoc(id, fields) {
  const mask = Object.keys(fields)
    .map((k) => `updateMask.fieldPaths=${encodeURIComponent(k)}`)
    .join('&');
  const r = await fetch(`${BASE}/leads/${id}?${mask}`, {
    method: 'PATCH',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields }),
  });
  console.log(r.ok ? `  patched ${id}` : `  PATCH FAILED ${id}: ${await r.text()}`);
  return r.ok;
}

async function deleteDoc(id) {
  const r = await fetch(`${BASE}/leads/${id}`, { method: 'DELETE', headers });
  console.log(r.ok ? `  deleted ${id}` : `  DELETE FAILED ${id}: ${await r.text()}`);
  return r.ok;
}

// 1. Ronald Brisa — rename + unflag.
console.log('Ronald Brisa (AaYLDfnWGdNhfbQtJ7JU): set name, clear review flag');
if (APPLY) {
  await patchDoc('AaYLDfnWGdNhfbQtJ7JU', {
    name: { stringValue: 'Ronald Brisa' },
    needsReview: { booleanValue: false },
  });
}

// 2 & 3. Merge dupes' attachments into the good lead, then delete the dupe.
const MERGES = [
  { review: 'liJyDtc87B7YncjrG4DE', good: '9UnxBDvbrQlZw0aY3fSD', label: 'Manuel Costa' },
  { review: 'ljAVYqVCMg3BbkhXtwVF', good: '8fAS9xAMspIHzlcxzTQJ', label: 'Mahareb Omreh' },
];
for (const m of MERGES) {
  const [rev, good] = await Promise.all([getDoc(m.review), getDoc(m.good)]);
  const attsOf = (d) => d.fields?.attachments?.arrayValue?.values ?? [];
  const nameOf = (a) => a?.mapValue?.fields?.name?.stringValue ?? '';
  const goodAtts = attsOf(good);
  const goodNames = new Set(goodAtts.map(nameOf));
  const add = attsOf(rev).filter((a) => !goodNames.has(nameOf(a)));
  console.log(`${m.label}: move ${add.length} attachment(s) ${m.review} -> ${m.good}, then delete dupe`);
  if (!APPLY) continue;
  if (add.length) {
    const ok = await patchDoc(m.good, {
      attachments: { arrayValue: { values: [...goodAtts, ...add] } },
    });
    if (!ok) continue;
  }
  await deleteDoc(m.review);
}

// 4. Alberta King — name + case number, keep the review flag.
console.log('Alberta King (u4xFz7HG3NIWf17fKgKe): set name + case 1525899, keep review flag');
if (APPLY) {
  await patchDoc('u4xFz7HG3NIWf17fKgKe', {
    name: { stringValue: 'Alberta King' },
    tvcCaseNumber: { stringValue: '1525899' },
  });
}

console.log('\nDone.');
