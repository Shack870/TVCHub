// One-time sort of sold cases off the main working board (phase two).
//
// For every lead still in an active working stage whose rolled-up saleStatus
// shows payment actually collected:
//   paid_full    -> stage intake_complete (handed off)
//   paid_partial -> stage financed        (actively paying, not paid off)
// promised_unpaid and saleStatus none/missing are NOT touched — a verbal yes
// stays on the board under the gold ribbon until money moves.
//
// Every move gets the same audit trail the syncCallRail auto-move writes:
// autoStageNote / autoStageAt on the lead (shown in the detail drawer),
// retainedAt if missing, intake/financed flags, and open follow-ups closed.
import { execSync } from 'node:child_process';

const PROJECT = 'tvchub-f2401';
const ROOT = `https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/(default)`;
const BASE = `${ROOT}/documents`;
const token = execSync('gcloud auth print-access-token').toString().trim();
const fsHeaders = {
  Authorization: `Bearer ${token}`,
  'x-goog-user-project': PROJECT,
  'Content-Type': 'application/json',
};

const WORKING_STAGES = ['new', 'callback', 'pitched', 'attorney_call', 'nurture'];

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

// --- Walk all leads ----------------------------------------------------------
const docs = [];
let pageToken = '';
do {
  const url = `${BASE}/leads?pageSize=300${pageToken ? `&pageToken=${pageToken}` : ''}`;
  const res = await fetch(url, { headers: fsHeaders });
  const json = await res.json();
  (json.documents || []).forEach((d) => docs.push(d));
  pageToken = json.nextPageToken || '';
} while (pageToken);

const onBoard = (f) => !dec(f.deletedAt) && WORKING_STAGES.includes(dec(f.stage));
const boardBefore = docs.filter((d) => onBoard(d.fields || {})).length;

const moved = [];
let failed = 0;

for (const d of docs) {
  const f = d.fields || {};
  if (!onBoard(f)) continue;
  const saleStatus = dec(f.saleStatus);
  if (saleStatus !== 'paid_full' && saleStatus !== 'paid_partial') continue;

  const name = dec(f.name) || '(unnamed)';
  const stage = dec(f.stage);
  const amount = dec(f.saleAmount);
  const saleAt = dec(f.saleStatusAt);
  const to = saleStatus === 'paid_full' ? 'intake_complete' : 'financed';
  const label = to === 'intake_complete' ? 'Intake Complete' : 'Financed';
  const day = saleAt
    ? new Date(saleAt).toLocaleDateString('en-US', {
        month: 'short',
        day: 'numeric',
        timeZone: 'America/Chicago',
      })
    : null;
  const note = `Stage moved to ${label} by classifier — payment confirmed${day ? ` on ${day} call` : ' by call transcript'}`;

  const now = Date.now();
  const followUps = (dec(f.followUps) || []).map((fu) =>
    fu?.done ? fu : { ...fu, done: true, doneAt: now },
  );

  const fieldsPatch = {
    stage: { stringValue: to },
    autoStageNote: { stringValue: note },
    autoStageAt: { integerValue: String(now) },
    retainedAt: { integerValue: String(dec(f.retainedAt) ?? saleAt ?? now) },
    followUps: enc(followUps),
    updatedAt: { integerValue: String(now) },
  };
  if (to === 'financed') fieldsPatch.isFinanced = { booleanValue: true };
  if (to === 'intake_complete') {
    fieldsPatch.intakeComplete = { booleanValue: true };
    fieldsPatch.intakeCompleteAt = { integerValue: String(now) };
  }
  const mask = Object.keys(fieldsPatch)
    .map((k) => `updateMask.fieldPaths=${k}`)
    .join('&');

  const docName = d.name.split('/documents/')[1];
  const res = await fetch(`${ROOT}/documents/${docName}?${mask}`, {
    method: 'PATCH',
    headers: fsHeaders,
    body: JSON.stringify({ fields: fieldsPatch }),
  });
  if (!res.ok) {
    failed++;
    console.error('PATCH failed', name, res.status, await res.text());
    continue;
  }
  moved.push({ name, from: stage, to, amount, saleAt });
}

// --- Report ------------------------------------------------------------------
console.log('--- sort sold cases ---');
console.log(`board before: ${boardBefore} cards in working stages`);
console.log(`moved off board: ${moved.length}${failed ? ` (${failed} FAILED)` : ''}`);
for (const m of moved) {
  console.log(
    `  ${m.name}: ${m.from} -> ${m.to}` +
      `${m.amount ? ` · $${m.amount}` : ' · amount unknown'}` +
      `${m.saleAt ? ` · paid on ${new Date(m.saleAt).toISOString().slice(0, 10)}` : ''}`,
  );
}
console.log(`board after: ${boardBefore - moved.length} cards remain on the main board`);
const byStage = moved.reduce((m, x) => ((m[x.to] = (m[x.to] || 0) + 1), m), {});
for (const [k, v] of Object.entries(byStage)) console.log(`  -> ${k}: ${v}`);
