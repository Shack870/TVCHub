// One-time stage backfill for the pipeline honesty fix (2026-07-23).
//
// The syncs (CallRail / email) now promote a lead new -> callback when the
// first contact activity is auto-logged, so "Initial Leads" means genuinely
// uncontacted. This backfill applies the same rule to history: every
// non-deleted lead still sitting in stage 'new' with at least one logged
// contactAttempt (any kind — call, email, hand-logged) moves to 'callback'.
// Leads with zero attempts stay 'new'. Only stage + updatedAt are written.
//
// Usage: node scripts/backfillNewToCallback-2026-07-23.mjs [--live]
// (dry-run by default: prints what it would change, writes nothing)
import { execSync } from 'node:child_process';

const LIVE = process.argv.includes('--live');
const PROJECT = 'tvchub-f2401';
const ROOT = `https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/(default)`;
const BASE = `${ROOT}/documents`;
const token = execSync('gcloud auth print-access-token').toString().trim();
const fsHeaders = {
  Authorization: `Bearer ${token}`,
  'x-goog-user-project': PROJECT,
  'Content-Type': 'application/json',
};

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

let pageToken = '';
let scanned = 0;
let stayedNew = 0;
let moved = 0;
do {
  const url = `${BASE}/leads?pageSize=300${pageToken ? `&pageToken=${pageToken}` : ''}`;
  const res = await fetch(url, { headers: fsHeaders });
  const json = await res.json();
  if (!res.ok) throw new Error(`list leads ${res.status}: ${JSON.stringify(json)}`);

  for (const doc of json.documents || []) {
    scanned++;
    const f = doc.fields || {};
    if (dec(f.deletedAt)) continue;
    if (dec(f.stage) !== 'new') continue;
    const attempts = dec(f.contactAttempts);
    const count = Array.isArray(attempts) ? attempts.length : 0;
    if (count === 0) {
      stayedNew++;
      continue;
    }

    const name = dec(f.name) || '(unnamed)';
    const docPath = doc.name.split('/documents/')[1];
    console.log(
      `${LIVE ? 'MOVE   ' : 'DRY    '}${name} — ${count} attempt${count === 1 ? '' : 's'} logged, new -> callback (${docPath})`,
    );
    moved++;
    if (!LIVE) continue;

    const patch = {
      stage: { stringValue: 'callback' },
      updatedAt: { integerValue: String(Date.now()) },
    };
    const mask = Object.keys(patch)
      .map((k) => `updateMask.fieldPaths=${k}`)
      .join('&');
    const upd = await fetch(`${ROOT}/documents/${docPath}?${mask}`, {
      method: 'PATCH',
      headers: fsHeaders,
      body: JSON.stringify({ fields: patch }),
    });
    if (!upd.ok) {
      console.error('PATCH failed', docPath, upd.status, await upd.text());
      process.exitCode = 1;
    }
  }
  pageToken = json.nextPageToken || '';
} while (pageToken);

console.log(
  `\n${LIVE ? '' : '[DRY RUN] '}scanned: ${scanned} leads · moved new->callback: ${moved} · stayed new (zero attempts): ${stayedNew}`,
);
