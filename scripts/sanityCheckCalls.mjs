// Sanity check: for every active lead, does CallRail history (not just the
// 48h sync window) actually show zero calls in or out? Cross-matches lead
// phone numbers against months of CallRail call logs.
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const PROJECT = 'tvchub-f2401';
const BASE = `https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/(default)/documents`;
const token = execSync('gcloud auth print-access-token').toString().trim();
const fsHeaders = { Authorization: `Bearer ${token}`, 'x-goog-user-project': PROJECT };

const env = readFileSync('.env.local', 'utf8');
const CR_KEY = env.match(/^CALLRAIL_API_KEY=(.+)$/m)?.[1]?.trim();
if (!CR_KEY) throw new Error('CALLRAIL_API_KEY not found in .env.local');
const ACCOUNT = 'ACC0abdb2f39b9f45689f56e0e1eaea2ca3';

const last10 = (s) => String(s ?? '').replace(/\D/g, '').slice(-10);

// --- 1. All leads from Firestore -------------------------------------------
const docs = [];
let pageToken = '';
do {
  const url = `${BASE}/leads?pageSize=300${pageToken ? `&pageToken=${pageToken}` : ''}`;
  const res = await fetch(url, { headers: fsHeaders });
  const json = await res.json();
  (json.documents || []).forEach((d) => docs.push(d));
  pageToken = json.nextPageToken || '';
} while (pageToken);

const s = (f, k) => f?.[k]?.stringValue ?? null;
const ACTIVE = ['new', 'callback', 'pitched', 'attorney_call', 'nurture'];
const leads = docs
  .map((d) => {
    const f = d.fields || {};
    const attempts = f.contactAttempts?.arrayValue?.values || [];
    return {
      id: d.name.split('/').pop(),
      name: s(f, 'name'),
      stage: s(f, 'stage'),
      phone: last10(s(f, 'phone')),
      altPhone: last10(s(f, 'altPhone')),
      deleted: Boolean(f.deletedAt?.integerValue),
      createdAt: Number(f.createdAt?.integerValue || 0),
      attemptCount: attempts.length,
      attemptVias: attempts.map((a) => a.mapValue?.fields?.via?.stringValue || 'manual'),
    };
  })
  .filter((l) => !l.deleted && ACTIVE.includes(l.stage));

console.log('active leads:', leads.length);

// --- 2. Full CallRail history (last 12 months) -----------------------------
const startDate = new Date(Date.now() - 365 * 86400_000).toISOString().slice(0, 10);
const calls = [];
let page = 1;
for (;;) {
  const url =
    `https://api.callrail.com/v3/a/${ACCOUNT}/calls.json` +
    `?start_date=${startDate}&per_page=250&page=${page}` +
    `&fields=id,direction,answered,voicemail,duration,customer_phone_number,start_time`;
  const res = await fetch(url, { headers: { Authorization: `Token token="${CR_KEY}"` } });
  if (!res.ok) throw new Error(`CallRail ${res.status}: ${await res.text()}`);
  const json = await res.json();
  calls.push(...(json.calls || []));
  if (page >= (json.total_pages || 1)) break;
  page++;
}
console.log(`CallRail calls since ${startDate}:`, calls.length);

const callsByPhone = new Map();
for (const c of calls) {
  const key = last10(c.customer_phone_number);
  if (key.length !== 10) continue;
  if (!callsByPhone.has(key)) callsByPhone.set(key, []);
  callsByPhone.get(key).push(c);
}

// --- 3. Cross-match ----------------------------------------------------------
let trulyUncalled = 0;
let calledButUnlogged = 0;
let loggedOk = 0;
const unlogged = [];
const uncalled = [];
for (const l of leads) {
  const crCalls = [
    ...(callsByPhone.get(l.phone) || []),
    ...(l.altPhone && l.altPhone !== l.phone ? callsByPhone.get(l.altPhone) || [] : []),
  ];
  const hasLoggedAttempt = l.attemptCount > 0;
  if (crCalls.length === 0 && !hasLoggedAttempt) {
    trulyUncalled++;
    uncalled.push(l);
  } else if (crCalls.length > 0 && !hasLoggedAttempt) {
    calledButUnlogged++;
    const out = crCalls.filter((c) => c.direction === 'outbound').length;
    const inn = crCalls.length - out;
    unlogged.push({ ...l, crTotal: crCalls.length, out, inn });
  } else {
    loggedOk++;
  }
}

console.log('\n--- verdict on active leads ---');
console.log('has logged attempts (app knows):       ', loggedOk);
console.log('CallRail shows calls, app shows none:  ', calledButUnlogged);
console.log('no calls anywhere (truly uncontacted): ', trulyUncalled);

if (unlogged.length) {
  console.log('\nCalled in real life but invisible to the app (CallRail out/in):');
  for (const l of unlogged.sort((a, b) => b.crTotal - a.crTotal).slice(0, 40)) {
    console.log(
      ` ${String(l.crTotal).padStart(3)} calls (${l.out} out / ${l.inn} in)  ${l.name}  [${l.stage}]  created ${new Date(l.createdAt).toISOString().slice(0, 10)}`,
    );
  }
}
if (uncalled.length) {
  console.log('\nTruly uncontacted (first 20):');
  for (const l of uncalled.slice(0, 20)) {
    console.log(`  ${l.name}  [${l.stage}]  created ${new Date(l.createdAt).toISOString().slice(0, 10)}  phone ${l.phone || '(none)'}`);
  }
}
