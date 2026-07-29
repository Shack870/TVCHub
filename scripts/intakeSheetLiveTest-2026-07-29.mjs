// Live end-to-end test of the DEPLOYED intakeSheet callable (2026-07-29).
//
// Builds a real docket for the given date straight from Firestore (open
// follow-ups due that day + court appearances), calls the deployed callable
// as a throwaway auth user (same trick as askPostItLiveTest), then renders
// the returned sheet through the REAL client renderer (esbuild-bundled
// src/lib/intakeSheetPdf.ts) with jsPDF.save patched to write into
// ~/Downloads — exactly the file a user would get from the button.
//
// Usage: node scripts/intakeSheetLiveTest-2026-07-29.mjs <yyyy-MM-dd>

import { execSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';

const PROJECT = 'tvchub-f2401';
const REGION = 'us-central1';
const date = process.argv[2];
if (!/^\d{4}-\d{2}-\d{2}$/.test(date ?? '')) {
  console.error('usage: node scripts/intakeSheetLiveTest-2026-07-29.mjs <yyyy-MM-dd>');
  process.exit(1);
}

const apiKey = readFileSync(new URL('../.env.local', import.meta.url), 'utf8')
  .match(/^VITE_FIREBASE_API_KEY=(.+)$/m)[1]
  .trim();
const gtoken = execSync('gcloud auth print-access-token').toString().trim();
const gheaders = {
  Authorization: `Bearer ${gtoken}`,
  'Content-Type': 'application/json',
  'x-goog-user-project': PROJECT,
};

async function jfetch(url, opts) {
  const res = await fetch(url, opts);
  const json = await res.json();
  if (!res.ok) throw new Error(`${url} -> ${res.status}: ${JSON.stringify(json).slice(0, 300)}`);
  return json;
}

// --- Build the docket for the date, same universe as the day card ---
const dec = (v) => {
  if (v == null || 'nullValue' in v) return null;
  if ('booleanValue' in v) return v.booleanValue;
  if ('integerValue' in v) return Number(v.integerValue);
  if ('doubleValue' in v) return v.doubleValue;
  if ('stringValue' in v) return v.stringValue;
  if ('arrayValue' in v) return (v.arrayValue.values ?? []).map(dec);
  if ('mapValue' in v) return Object.fromEntries(Object.entries(v.mapValue.fields ?? {}).map(([k, x]) => [k, dec(x)]));
};
const chicagoDay = (ms) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ms));

let docs = [];
let tok = '';
do {
  const url = `https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/(default)/documents/leads?pageSize=300${tok ? `&pageToken=${tok}` : ''}`;
  const d = await jfetch(url, { headers: gheaders });
  docs = docs.concat(d.documents ?? []);
  tok = d.nextPageToken ?? '';
} while (tok);

const docket = [];
for (const doc of docs) {
  const f = Object.fromEntries(Object.entries(doc.fields ?? {}).map(([k, v]) => [k, dec(v)]));
  if (f.deletedAt) continue;
  const id = doc.name.split('/').pop();
  const activeCase = !f.caseDismissed && f.stage !== 'intake_complete' && f.stage !== 'lost';
  if (activeCase && f.nextCourtDate === date) {
    docket.push({ leadId: id, event: `Court appearance today${f.courtName ? ` — ${f.courtName}` : ''}` });
  }
  for (const fu of f.followUps ?? []) {
    if (fu.done || chicagoDay(fu.dueAt) !== date) continue;
    docket.push({ leadId: id, event: `Follow-up due: ${fu.type}${fu.note ? ` — ${fu.note}` : ''}` });
  }
}
console.log(`docket for ${date}: ${docket.length} item(s)`);
for (const d of docket) console.log(`  ${d.leadId}  ${d.event.slice(0, 90)}`);
if (!docket.length) {
  console.error('nothing on the docket that day — pick another date');
  process.exit(1);
}

// --- Throwaway user, call the deployed callable ---
const email = `intakesheet-livetest-${Date.now()}@goironrock.com`;
const password = randomBytes(18).toString('base64url');
const created = await jfetch(`https://identitytoolkit.googleapis.com/v1/projects/${PROJECT}/accounts`, {
  method: 'POST',
  headers: gheaders,
  body: JSON.stringify({ email, password }),
});
const localId = created.localId;
console.log('temp user created:', email);

try {
  const signIn = await jfetch(
    `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${apiKey}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password, returnSecureToken: true }),
    },
  );
  const t0 = Date.now();
  const result = await jfetch(`https://${REGION}-${PROJECT}.cloudfunctions.net/intakeSheet`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${signIn.idToken}` },
    body: JSON.stringify({ data: { date, docket } }),
  });
  const sheet = result.result.sheet;
  console.log(`\nsheet built in ${((Date.now() - t0) / 1000).toFixed(1)}s — ${sheet.items.length} item(s)`);
  console.log(`headline: ${sheet.headline}`);
  console.log(`pep talk: ${sheet.pep_talk}`);
  for (const it of sheet.items) console.log(`  • ${it.name} — ${it.event.slice(0, 60)}`);
  console.log(`closer: ${sheet.closer}`);

  // --- Render through the REAL client renderer, save into ~/Downloads ---
  const { jsPDF } = await import('jspdf');
  jsPDF.API.save = function (filename) {
    const path = `${process.env.HOME}/Downloads/${filename}`;
    writeFileSync(path, Buffer.from(this.output('arraybuffer')));
    console.log(`\nPDF written: ${path}`);
  };
  const { downloadIntakeSheet } = await import('./intakeSheetPdf.bundle.mjs');
  downloadIntakeSheet(date, sheet);
} finally {
  await jfetch(`https://identitytoolkit.googleapis.com/v1/projects/${PROJECT}/accounts:delete`, {
    method: 'POST',
    headers: gheaders,
    body: JSON.stringify({ localId }),
  });
  console.log('temp user deleted');
}
