// One-time: log office@ironrocklaw.com outreach emails as contact attempts on
// the 29 "uncontacted" leads the Gmail audit (2026-07-22) found were actually
// emailed. Leads who replied get outcome "spoke" (a real two-way exchange —
// the cadence stops first-touch chasing and nudges instead) and a
// lastConnectedAt stamp; no-reply leads get "no_answer" email touches.
// Stages untouched. Safe to re-run: skips leads that already have email
// attempts.
import { execSync } from 'node:child_process';

const AUDIT = [
  { name: 'Gurpreet Singh', email: 'gs6261966@gmail.com', sent: 1, firstSent: '2026-07-02', lastSent: '2026-07-02', replyThreads: 0 },
  { name: 'Amit Amit', email: 'khanchiamit5@gmail.com', sent: 1, firstSent: '2026-07-15', lastSent: '2026-07-15', replyThreads: 0 },
  { name: 'Terry Sherrod', email: 'sherrodstrucking@gmail.com', sent: 1, firstSent: '2026-07-08', lastSent: '2026-07-08', replyThreads: 0 },
  { name: 'Avtar Singh Cheira', email: 'cheraavtar@gmail.com', sent: 1, firstSent: '2026-07-15', lastSent: '2026-07-15', replyThreads: 0 },
  { name: 'Raul Jimenez Pena', email: 'raulj121293@gmail.com', sent: 1, firstSent: '2026-07-02', lastSent: '2026-07-02', replyThreads: 0 },
  { name: 'SUKHDEV LNU', email: 'ds436946@gmail.com', sent: 1, firstSent: '2026-07-06', lastSent: '2026-07-06', replyThreads: 0 },
  { name: 'Mahareb Omreh', email: 'alibavi75@yahoo.com', sent: 2, firstSent: '2026-07-06', lastSent: '2026-07-08', replyThreads: 0 },
  { name: 'MANUEL ERNESTO COSTA', email: 'costaexpressinc@gmail.com', sent: 2, firstSent: '2026-07-14', lastSent: '2026-07-15', replyThreads: 0 },
  { name: 'Damon Williams', email: 'kingdamonwilliams@gmail.com', sent: 1, firstSent: '2026-07-09', lastSent: '2026-07-09', replyThreads: 0 },
  { name: 'Yusnier Adolfo Suarez Anuez', email: 'suarezanuez@yahoo.com', sent: 2, firstSent: '2026-07-09', lastSent: '2026-07-10', replyThreads: 1 },
  { name: 'Sekou Kaba', email: 'sekukhaba@gmail.com', sent: 3, firstSent: '2026-07-17', lastSent: '2026-07-17', replyThreads: 1 },
  { name: 'JABBAR M AL-HAYAWI', email: 'hamedibr@yahoo.com', sent: 1, firstSent: '2026-07-15', lastSent: '2026-07-15', replyThreads: 0 },
  { name: 'JORGE PEREZ', email: 'przlogs@gmail.com', sent: 1, firstSent: '2026-07-09', lastSent: '2026-07-09', replyThreads: 0 },
  { name: 'Cheru Tucho', email: 'korlw.llc@gmail.com', sent: 2, firstSent: '2026-07-10', lastSent: '2026-07-13', replyThreads: 0 },
  { name: 'Michael Davis', email: 'davismike418@gmail.com', sent: 1, firstSent: '2026-07-10', lastSent: '2026-07-10', replyThreads: 0 },
  { name: 'KHALID WELLINGTON', email: 'wellingtonkhalid@yahoo.com', sent: 3, firstSent: '2026-06-25', lastSent: '2026-06-26', replyThreads: 1 },
  { name: 'MULKU SESAY', email: 'mulkusesay2468@gmail.com', sent: 1, firstSent: '2026-07-15', lastSent: '2026-07-15', replyThreads: 0 },
  { name: 'EDGAR D HOLLAND', email: 'edgar.holland201@gmail.com', sent: 1, firstSent: '2026-07-17', lastSent: '2026-07-17', replyThreads: 0 },
  { name: 'Mykola Marysyak', email: 'mykolamarysyak@gmail.com', sent: 1, firstSent: '2026-06-25', lastSent: '2026-06-25', replyThreads: 0 },
  { name: 'Donquarius Richardson', email: 'donquarius94@gmail.com', sent: 1, firstSent: '2026-07-15', lastSent: '2026-07-15', replyThreads: 0 },
  { name: 'Islomjon Nuriddinov', email: 'islom1012@icloud.com', sent: 1, firstSent: '2026-07-15', lastSent: '2026-07-15', replyThreads: 0 },
  { name: "Au'Quincy Davis", email: 'auquincydavis11@gmail.com', sent: 1, firstSent: '2026-07-01', lastSent: '2026-07-01', replyThreads: 0 },
  { name: 'Kenyelle Walker', email: 'kenyelledwayne88@yahoo.com', sent: 1, firstSent: '2026-07-15', lastSent: '2026-07-15', replyThreads: 0 },
  { name: 'Ahmed Omar', email: 'young.omar8@gmail.com', sent: 1, firstSent: '2026-07-15', lastSent: '2026-07-15', replyThreads: 0 },
  { name: 'Jesus Rodriguez', email: 'padilla891004@gmail.com', sent: 1, firstSent: '2026-07-08', lastSent: '2026-07-08', replyThreads: 0 },
  { name: 'AMANJ F ABDULLAH', email: 'amanj.f.abdulla@gmail.com', sent: 6, firstSent: '2026-07-13', lastSent: '2026-07-17', replyThreads: 1 },
  { name: 'Enrique Sastre-Burgos', email: 'burgossastre2815@gmail.com', sent: 1, firstSent: '2026-06-29', lastSent: '2026-06-29', replyThreads: 0 },
  { name: 'LAWRENCE HARDWICK', email: 'lawrencehardwick@hotmail.com', sent: 2, firstSent: '2026-07-15', lastSent: '2026-07-17', replyThreads: 0 },
  { name: 'Abdideq Yussuf', email: 'mahdiciise0@gmail.com', sent: 1, firstSent: '2026-07-14', lastSent: '2026-07-14', replyThreads: 0 },
];

const PROJECT = 'tvchub-f2401';
const ROOT = `https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/(default)`;
const BASE = `${ROOT}/documents`;
const token = execSync('gcloud auth print-access-token').toString().trim();
const headers = {
  Authorization: `Bearer ${token}`,
  'x-goog-user-project': PROJECT,
  'Content-Type': 'application/json',
};

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
const noonCT = (d) => new Date(`${d}T12:00:00-05:00`).getTime();

// Load all leads, index by lowercased email.
const docs = [];
let pageToken = '';
do {
  const url = `${BASE}/leads?pageSize=300${pageToken ? `&pageToken=${pageToken}` : ''}`;
  const res = await fetch(url, { headers });
  const json = await res.json();
  (json.documents || []).forEach((d) => docs.push(d));
  pageToken = json.nextPageToken || '';
} while (pageToken);

const byEmail = new Map();
for (const d of docs) {
  const f = d.fields || {};
  if (f.deletedAt?.integerValue) continue;
  const email = (f.email?.stringValue || '').toLowerCase().trim();
  if (email) byEmail.set(email, d);
}

let updated = 0;
let attemptsAdded = 0;
for (const a of AUDIT) {
  const doc = byEmail.get(a.email);
  if (!doc) {
    console.error('lead not found for', a.email, a.name);
    continue;
  }
  const f = doc.fields || {};
  const attempts = dec(f.contactAttempts) || [];
  if (attempts.some((x) => x?.via === 'email')) {
    console.log('skip (already has email touches):', a.name);
    continue;
  }

  const replied = a.replyThreads > 0;
  const dates = a.firstSent === a.lastSent ? [a.firstSent] : [a.firstSent, a.lastSent];
  const newAttempts = dates.map((date, i) => {
    const isLast = i === dates.length - 1;
    return {
      ts: noonCT(date),
      outcome: replied && isLast ? 'spoke' : 'no_answer',
      notes:
        (replied && isLast
          ? `Email conversation — lead REPLIED. `
          : `Outreach email sent from office@ironrocklaw.com. `) +
        (a.sent > dates.length ? `(${a.sent} emails sent total.) ` : '') +
        `Backfilled from Gmail audit.`,
      by: 'Email audit (office@)',
      via: 'email',
    };
  });

  const all = [...attempts, ...newAttempts].sort((x, y) => (x.ts ?? 0) - (y.ts ?? 0));
  const fieldsPatch = {
    contactAttempts: enc(all),
    updatedAt: { integerValue: String(Date.now()) },
  };
  let mask = 'updateMask.fieldPaths=contactAttempts&updateMask.fieldPaths=updatedAt';
  if (replied) {
    const existing = Number(f.lastConnectedAt?.integerValue || 0);
    const connectedAt = noonCT(a.lastSent);
    if (connectedAt > existing) {
      fieldsPatch.lastConnectedAt = { integerValue: String(connectedAt) };
      mask += '&updateMask.fieldPaths=lastConnectedAt';
    }
  }
  const name = doc.name.split('/documents/')[1];
  const res = await fetch(`${ROOT}/documents/${name}?${mask}`, {
    method: 'PATCH',
    headers,
    body: JSON.stringify({ fields: fieldsPatch }),
  });
  if (!res.ok) {
    console.error('PATCH failed', a.name, res.status, await res.text());
  } else {
    updated++;
    attemptsAdded += newAttempts.length;
    console.log(
      `${replied ? 'REPLIED ' : 'touched '} ${a.name} — ${newAttempts.length} email attempt(s), ${a.sent} sent total`,
    );
  }
}
console.log(`\ndone. leads updated: ${updated}, email attempts logged: ${attemptsAdded}`);
