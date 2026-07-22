// One-time re-evaluation of the "Unmatched Square payment" post-its created
// by the first syncSquare backfill run (2026-07-22).
//
// The Square account also takes general law-firm charges unrelated to TVC
// intake, so the sync's unmatched rule was tightened: a post-it now requires
// suggestive TVC evidence — a CallRail call within 24h before the charge, an
// amount matching (or half of) an open promised/partial fee, or a partial
// identity match (payer last name, or phone last-7, against a lead). This
// script grades each existing post-it against those same rules and archives
// (deletedAt) the ones that don't meet the new bar.
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

const DAY = 86400_000;
const AMOUNT_TOLERANCE = 5; // dollars

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

const lc = (s) => String(s ?? '').toLowerCase().trim();
const last7 = (s) => String(s ?? '').replace(/\D/g, '').slice(-7);
const lastName = (s) => {
  const parts = lc(s).split(/\s+/).filter(Boolean);
  return parts.length >= 2 ? parts[parts.length - 1] : '';
};

// --- Load all leads (evidence base) ------------------------------------------
const leads = [];
let pageToken = '';
do {
  const url = `${BASE}/leads?pageSize=300${pageToken ? `&pageToken=${pageToken}` : ''}`;
  const res = await fetch(url, { headers: fsHeaders });
  const json = await res.json();
  (json.documents || []).forEach((d) => leads.push(d.fields || {}));
  pageToken = json.nextPageToken || '';
} while (pageToken);

const live = leads.filter((f) => !dec(f.deletedAt));
const callrailTs = [];
const leadLastNames = new Set();
const leadPhone7 = new Set();
const openSaleAmounts = [];
for (const f of live) {
  for (const a of dec(f.contactAttempts) || []) {
    if (a?.via === 'callrail' && typeof a.ts === 'number') callrailTs.push(a.ts);
  }
  const ln = lastName(dec(f.name));
  if (ln) leadLastNames.add(ln);
  for (const p of [dec(f.phone), dec(f.altPhone)]) {
    if (last7(p).length === 7) leadPhone7.add(last7(p));
  }
  const saleStatus = dec(f.saleStatus);
  const saleAmount = dec(f.saleAmount);
  if ((saleStatus === 'promised_unpaid' || saleStatus === 'paid_partial') && saleAmount > 0) {
    openSaleAmounts.push(saleAmount);
  }
}

function tvcEvidence({ paidTs, dollars, payerName, payerPhone, noteText }) {
  if (callrailTs.some((t) => t >= paidTs - DAY && t <= paidTs)) {
    return 'a CallRail call happened within 24h before the charge';
  }
  for (const fee of openSaleAmounts) {
    if (Math.abs(dollars - fee) <= AMOUNT_TOLERANCE) return `amount matches an open $${fee} fee`;
    if (Math.abs(dollars * 2 - fee) <= AMOUNT_TOLERANCE)
      return `amount is half of an open $${fee} fee`;
  }
  for (const candidate of [payerName, noteText]) {
    const ln = lastName(candidate);
    if (ln && leadLastNames.has(ln)) return `payer last name "${ln}" matches a lead`;
  }
  if (last7(payerPhone).length === 7 && leadPhone7.has(last7(payerPhone))) {
    return 'payer phone (last 7) matches a lead';
  }
  return null;
}

// --- Load the Square Sync unmatched post-its ----------------------------------
const res = await fetch(`${BASE}:runQuery`, {
  method: 'POST',
  headers: fsHeaders,
  body: JSON.stringify({
    structuredQuery: {
      from: [{ collectionId: 'messages' }],
      where: {
        fieldFilter: {
          field: { fieldPath: 'from' },
          op: 'EQUAL',
          value: { stringValue: 'Square Sync' },
        },
      },
    },
  }),
});
const rows = await res.json();

let kept = 0;
let archived = 0;
for (const r of rows) {
  if (!r.document) continue;
  const f = r.document.fields || {};
  if (dec(f.deletedAt)) continue;
  const subject = dec(f.subject) || '';
  if (!subject.startsWith('Unmatched Square payment')) continue;

  const dollars = Number((subject.match(/\$([\d,]+\.?\d*)/) || [])[1]?.replace(/,/g, '') ?? 0);
  const noteText = (dec(f.message)?.match(/note: "([^"]*)"/) || [])[1] ?? null;
  const info = {
    paidTs: dec(f.receivedAt),
    dollars,
    payerName: dec(f.memberName),
    payerPhone: dec(f.phone),
    noteText,
  };
  const evidence = tvcEvidence(info);
  const label = `${subject} · ${info.payerName || '(no payer info)'} · ${new Date(info.paidTs).toISOString().slice(0, 10)}`;

  if (evidence) {
    console.log(`KEEP    ${label}\n        evidence: ${evidence}`);
    kept++;
    continue;
  }

  const now = Date.now();
  const docName = r.document.name.split('/documents/')[1];
  const patch = {
    deletedAt: { integerValue: String(now) },
    updatedAt: { integerValue: String(now) },
  };
  const mask = Object.keys(patch)
    .map((k) => `updateMask.fieldPaths=${k}`)
    .join('&');
  const upd = await fetch(`${ROOT}/documents/${docName}?${mask}`, {
    method: 'PATCH',
    headers: fsHeaders,
    body: JSON.stringify({ fields: patch }),
  });
  if (!upd.ok) {
    console.error('PATCH failed', label, upd.status, await upd.text());
    continue;
  }
  console.log(`ARCHIVE ${label}\n        no TVC evidence — general firm business`);
  archived++;
}

console.log(`\nkept: ${kept} · archived: ${archived}`);
