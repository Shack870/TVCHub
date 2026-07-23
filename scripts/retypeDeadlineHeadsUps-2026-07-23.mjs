// One-time retype of the motions-deadline heads-up follow-ups (2026-07-23).
//
// The cadence remarket pass used to write the deadline−6 "Free deadline
// heads-up call" with type 'week_before', which collided with the real court
// week_before reminder under the type-scoped 3-day dedupe. The type union now
// has a dedicated 'motions' type and the sweep writes it going forward; this
// script retypes the live pending follow-ups so the already-scheduled ones
// dedupe (and label) correctly.
//
// Match rule: type 'week_before' AND not done AND note starts with
// "Free deadline heads-up call" — on non-deleted leads.
//
// Usage: node scripts/retypeDeadlineHeadsUps-2026-07-23.mjs [--live]
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

const NOTE_PREFIX = 'Free deadline heads-up call';

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

function enc(v) {
  if (v === null || v === undefined) return { nullValue: null };
  if (typeof v === 'boolean') return { booleanValue: v };
  if (typeof v === 'number')
    return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
  if (typeof v === 'string') return { stringValue: v };
  if (Array.isArray(v)) return { arrayValue: { values: v.map(enc) } };
  return { mapValue: { fields: Object.fromEntries(Object.entries(v).map(([k, x]) => [k, enc(x)])) } };
}

// --- Walk every lead ----------------------------------------------------------
let pageToken = '';
let scanned = 0;
let leadsTouched = 0;
let retyped = 0;
do {
  const url = `${BASE}/leads?pageSize=300${pageToken ? `&pageToken=${pageToken}` : ''}`;
  const res = await fetch(url, { headers: fsHeaders });
  const json = await res.json();
  if (!res.ok) throw new Error(`list leads ${res.status}: ${JSON.stringify(json)}`);

  for (const doc of json.documents || []) {
    scanned++;
    const f = doc.fields || {};
    if (dec(f.deletedAt)) continue;
    const followUps = dec(f.followUps);
    if (!Array.isArray(followUps) || followUps.length === 0) continue;

    let changed = 0;
    const next = followUps.map((fu) => {
      const isTarget =
        fu &&
        fu.type === 'week_before' &&
        !fu.done &&
        typeof fu.note === 'string' &&
        fu.note.startsWith(NOTE_PREFIX);
      if (!isTarget) return fu;
      changed++;
      return { ...fu, type: 'motions' };
    });
    if (changed === 0) continue;

    const name = dec(f.name) || '(unnamed)';
    const docPath = doc.name.split('/documents/')[1];
    console.log(
      `${LIVE ? 'RETYPE ' : 'DRY    '}${name} — ${changed} heads-up follow-up${changed === 1 ? '' : 's'} (${docPath})`,
    );
    leadsTouched++;
    retyped += changed;
    if (!LIVE) continue;

    const patch = {
      followUps: enc(next),
      updatedAt: enc(Date.now()),
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
  `\n${LIVE ? '' : '[DRY RUN] '}scanned: ${scanned} leads · retyped: ${retyped} follow-ups on ${leadsTouched} leads`,
);
