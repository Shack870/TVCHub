// One-time repair (2026-07-21): the first run of sortSoldCases.mjs stamped
// intakeCompleteAt (and sometimes retainedAt) with Date.now() at sort time,
// so the Intake Complete screen shows today's date for every auto-moved case.
// Rewrite those fields to the ts of the CallRail call where payment was
// actually collected. Only leads auto-moved by the classifier whose date
// field currently falls on 2026-07-21 are touched.
import { execSync } from 'node:child_process';

const PROJECT = 'tvchub-f2401';
const ROOT = `https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/(default)`;
const BASE = `${ROOT}/documents`;
const token = execSync('gcloud auth print-access-token').toString().trim();
const headers = {
  Authorization: `Bearer ${token}`,
  'x-goog-user-project': PROJECT,
  'Content-Type': 'application/json',
};

const DRY_RUN = process.argv.includes('--dry-run');
const TODAY = '2026-07-21';

function enc(v) {
  if (v === null || v === undefined) return { nullValue: null };
  if (typeof v === 'boolean') return { booleanValue: v };
  if (typeof v === 'number')
    return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
  if (typeof v === 'string') return { stringValue: v };
  if (Array.isArray(v)) return { arrayValue: { values: v.map(enc) } };
  return { mapValue: { fields: Object.fromEntries(Object.entries(v).map(([k, x]) => [k, enc(x)])) } };
}
function dec(v) {
  if (!v || 'nullValue' in v) return null;
  if ('booleanValue' in v) return v.booleanValue;
  if ('integerValue' in v) return Number(v.integerValue);
  if ('doubleValue' in v) return v.doubleValue;
  if ('stringValue' in v) return v.stringValue;
  if ('arrayValue' in v) return (v.arrayValue.values || []).map(dec);
  if ('mapValue' in v)
    return Object.fromEntries(Object.entries(v.mapValue.fields || {}).map(([k, x]) => [k, dec(x)]));
  return null;
}

const dayOf = (ms) =>
  new Date(ms).toLocaleDateString('en-CA', { timeZone: 'America/Chicago' }); // YYYY-MM-DD
const isToday = (ms) => typeof ms === 'number' && dayOf(ms) === TODAY;
const fmt = (ms) => (typeof ms === 'number' ? new Date(ms).toISOString().slice(0, 10) : '—');

// The call where money moved: latest attempt whose AI read shows payment
// collected; fall back to the latest attempt logged with outcome "retained".
function paidCallOf(attempts) {
  let paid = null;
  let retained = null;
  for (const a of attempts) {
    if (!a || typeof a.ts !== 'number') continue;
    const s = a.ai?.saleStatus;
    if ((s === 'paid_full' || s === 'paid_partial') && (!paid || a.ts > paid.ts)) paid = a;
    if (a.outcome === 'retained' && (!retained || a.ts > retained.ts)) retained = a;
  }
  if (paid) return { attempt: paid, basis: `ai.saleStatus=${paid.ai.saleStatus}` };
  if (retained) return { attempt: retained, basis: 'outcome=retained' };
  return null;
}

// --- Walk all leads ----------------------------------------------------------
const docs = [];
let pageToken = '';
do {
  const url = `${BASE}/leads?pageSize=300${pageToken ? `&pageToken=${pageToken}` : ''}`;
  const res = await fetch(url, { headers });
  const json = await res.json();
  (json.documents || []).forEach((d) => docs.push(d));
  pageToken = json.nextPageToken || '';
} while (pageToken);

const rows = [];
const skipped = [];
let failed = 0;

for (const d of docs) {
  const f = d.fields || {};
  if (dec(f.deletedAt)) continue;
  const stage = dec(f.stage);
  if (stage !== 'intake_complete' && stage !== 'financed') continue;

  // Only cases the classifier auto-moved (sort script + syncCallRail both
  // stamp this audit note); manually completed cases have no autoStageNote.
  const autoNote = dec(f.autoStageNote) || '';
  if (!autoNote.includes('by classifier')) continue;

  const name = dec(f.name) || '(unnamed)';
  const intakeAt = dec(f.intakeCompleteAt);
  const retainedAt = dec(f.retainedAt);

  // Only repair fields wrongly stamped with today's run time.
  const fixIntake = stage === 'intake_complete' && isToday(intakeAt);
  const fixRetained = isToday(retainedAt);
  if (!fixIntake && !fixRetained) {
    skipped.push(`${name} (${stage}) — dates not from today, left alone`);
    continue;
  }

  const found = paidCallOf(dec(f.contactAttempts) || []);
  if (!found) {
    skipped.push(`${name} (${stage}) — NO paid/retained call found, left alone`);
    continue;
  }
  const callTs = found.attempt.ts;

  const fieldsPatch = {};
  if (fixIntake) fieldsPatch.intakeCompleteAt = { integerValue: String(callTs) };
  if (fixRetained) fieldsPatch.retainedAt = { integerValue: String(callTs) };

  rows.push({
    name,
    stage,
    oldIntake: fixIntake ? fmt(intakeAt) : null,
    oldRetained: fixRetained ? fmt(retainedAt) : null,
    newDate: fmt(callTs),
    basis: found.basis,
    id: d.name.split('/').pop(),
  });

  if (DRY_RUN) continue;

  const mask = Object.keys(fieldsPatch)
    .map((k) => `updateMask.fieldPaths=${k}`)
    .join('&');
  const docName = d.name.split('/documents/')[1];
  const res = await fetch(`${ROOT}/documents/${docName}?${mask}`, {
    method: 'PATCH',
    headers,
    body: JSON.stringify({ fields: fieldsPatch }),
  });
  if (!res.ok) {
    failed++;
    console.error('PATCH failed', name, res.status, await res.text());
  }
}

// --- Report ------------------------------------------------------------------
console.log(`--- fix completed dates (${DRY_RUN ? 'DRY RUN' : 'LIVE'}) ---`);
console.log(`repaired: ${rows.length}${failed ? ` (${failed} FAILED)` : ''}`);
for (const r of rows) {
  const olds = [
    r.oldIntake ? `intakeCompleteAt ${r.oldIntake}` : null,
    r.oldRetained ? `retainedAt ${r.oldRetained}` : null,
  ]
    .filter(Boolean)
    .join(', ');
  console.log(`  ${r.name} [${r.stage}] (${r.id}): ${olds} -> ${r.newDate}  (from call: ${r.basis})`);
}
if (skipped.length) {
  console.log(`untouched: ${skipped.length}`);
  for (const s of skipped) console.log(`  ${s}`);
}
