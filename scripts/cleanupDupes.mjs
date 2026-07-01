// One-off + reusable cleanup for duplicate lead cards that slipped in before the
// fallback identity dedup existed. Finds leads with NO TVC case number that
// duplicate a lead WITH a case number (same name + county / phone / email),
// merges any fields the good card is missing (including the PDF) into it, then
// deletes the junk card.
//
// Dry run by default. Pass --apply to actually write/delete.
//   node scripts/cleanupDupes.mjs          # preview
//   node scripts/cleanupDupes.mjs --apply  # execute

import { execSync } from 'node:child_process';

const APPLY = process.argv.includes('--apply');
const PROJECT = 'tvchub-f2401';
const BASE = `https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/(default)/documents`;
const token = execSync('gcloud auth print-access-token').toString().trim();
const headers = { Authorization: `Bearer ${token}`, 'x-goog-user-project': PROJECT };

const MERGEABLE = [
  'tvcCaseNumber', 'name', 'phone', 'email', 'address', 'birthdate', 'language',
  'driversLicense', 'driversLicenseState', 'driversLicenseType', 'vehicleType',
  'violationDate', 'caseOpenedOn', 'tickets', 'charge', 'courtName', 'courtPhone',
  'courtAddress', 'courtCity', 'county', 'state', 'courtZip', 'nextCourtDate',
  'nextCourtTime', 'nextCourtType', 'tvcNotes', 'attachments', 'pdfUrl',
];

const digits = (s) => String(s ?? '').replace(/\D/g, '');
const lower = (s) => String(s ?? '').trim().toLowerCase();
const countyKey = (s) => lower(s).replace(/[^a-z]/g, '');
const nameTokens = (s) =>
  lower(s).replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter((t) => t.length > 1);

function nameMatches(a, b) {
  const ta = new Set(nameTokens(a));
  const tb = new Set(nameTokens(b));
  if (ta.size < 2 || tb.size < 2) return false;
  const [small, big] = ta.size <= tb.size ? [ta, tb] : [tb, ta];
  let shared = 0;
  for (const t of small) if (big.has(t)) shared++;
  return shared === small.size && shared >= 2;
}

const s = (f, k) => f?.[k]?.stringValue ?? null;
function fieldEmpty(typed) {
  if (!typed) return true;
  if ('stringValue' in typed) return typed.stringValue === '';
  if ('nullValue' in typed) return true;
  if ('arrayValue' in typed) return !(typed.arrayValue.values?.length);
  return false;
}

// Load all leads.
const docs = [];
let pageToken = '';
do {
  const url = `${BASE}/leads?pageSize=300${pageToken ? `&pageToken=${pageToken}` : ''}`;
  const res = await fetch(url, { headers });
  const json = await res.json();
  (json.documents || []).forEach((d) => docs.push(d));
  pageToken = json.nextPageToken || '';
} while (pageToken);

const leads = docs.map((d) => ({ id: d.name.split('/').pop(), name: d.name, f: d.fields || {} }));
const withCase = leads.filter((l) => s(l.f, 'tvcCaseNumber'));
const noCase = leads.filter((l) => !s(l.f, 'tvcCaseNumber'));

console.log(`Total ${leads.length} | with case ${withCase.length} | no case ${noCase.length}`);
console.log(APPLY ? '\n*** APPLY MODE — changes will be written ***\n' : '\n(dry run — pass --apply to execute)\n');

for (const junk of noCase) {
  const jn = s(junk.f, 'name');
  const jPhone = digits(s(junk.f, 'phone'));
  const jEmail = lower(s(junk.f, 'email'));
  const jCounty = countyKey(s(junk.f, 'county'));

  const good = withCase.find((g) => {
    if (!nameMatches(jn, s(g.f, 'name'))) return false;
    const samePhone = jPhone && digits(s(g.f, 'phone')) === jPhone;
    const sameEmail = jEmail && lower(s(g.f, 'email')) === jEmail;
    const sameCounty = jCounty && countyKey(s(g.f, 'county')) === jCounty;
    return samePhone || sameEmail || sameCounty;
  });

  if (!good) {
    console.log(`KEEP  "${jn}" (${junk.id}) — no confident match; leaving it for manual review`);
    continue;
  }

  // Fields the good card is missing that the junk card can supply.
  const update = {};
  const mask = [];
  for (const k of MERGEABLE) {
    if (!fieldEmpty(junk.f[k]) && fieldEmpty(good.f[k])) {
      update[k] = junk.f[k];
      mask.push(k);
    }
  }

  console.log(
    `MERGE "${jn}" (${junk.id}) -> "${s(good.f, 'name')}" case ${s(good.f, 'tvcCaseNumber')} (${good.id})` +
      (mask.length ? ` | filling: ${mask.join(', ')}` : ' | nothing to fill') +
      ` | then DELETE junk`,
  );

  if (!APPLY) continue;

  if (mask.length) {
    const qs = mask.map((k) => `updateMask.fieldPaths=${encodeURIComponent(k)}`).join('&');
    const r = await fetch(`https://firestore.googleapis.com/v1/${good.name}?${qs}`, {
      method: 'PATCH',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ fields: update }),
    });
    console.log(r.ok ? `  merged into ${good.id}` : `  MERGE FAILED ${await r.text()}`);
    if (!r.ok) continue; // don't delete junk if merge failed
  }

  const del = await fetch(`https://firestore.googleapis.com/v1/${junk.name}`, {
    method: 'DELETE',
    headers,
  });
  console.log(del.ok ? `  deleted junk ${junk.id}` : `  DELETE FAILED ${await del.text()}`);
}

console.log('\nDone.');
