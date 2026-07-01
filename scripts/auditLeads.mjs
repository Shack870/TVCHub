import { execSync } from 'node:child_process';

const PROJECT = 'tvchub-f2401';
const BASE = `https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/(default)/documents`;
const token = execSync('gcloud auth print-access-token').toString().trim();
const headers = { Authorization: `Bearer ${token}`, 'x-goog-user-project': PROJECT };

const docs = [];
let pageToken = '';
do {
  const url = `${BASE}/leads?pageSize=300${pageToken ? `&pageToken=${pageToken}` : ''}`;
  const res = await fetch(url, { headers });
  const json = await res.json();
  (json.documents || []).forEach((d) => docs.push(d));
  pageToken = json.nextPageToken || '';
} while (pageToken);

const s = (f, k) => f?.[k]?.stringValue ?? null;
const n = (f, k) => Number(f?.[k]?.integerValue ?? f?.[k]?.doubleValue ?? 0);
const b = (f, k) => f?.[k]?.booleanValue ?? false;

const leads = docs.map((d) => {
  const f = d.fields || {};
  return {
    id: d.name.split('/').pop(),
    name: s(f, 'name'),
    phone: s(f, 'phone'),
    email: s(f, 'email'),
    caseNum: s(f, 'tvcCaseNumber'),
    stage: s(f, 'stage'),
    needsReview: b(f, 'needsReview'),
    gmailMessageId: s(f, 'gmailMessageId'),
    courtName: s(f, 'courtName'),
    county: s(f, 'county'),
    createdAt: n(f, 'createdAt'),
    receivedAt: n(f, 'receivedAt'),
  };
});

console.log(`TOTAL LEADS: ${leads.length}\n`);

const norm = (x) => (x || '').toLowerCase().replace(/[^a-z0-9]/g, '');

// 1) Missing case number
const noCase = leads.filter((l) => !l.caseNum);
console.log(`--- No TVC case number (${noCase.length}) ---`);
noCase.forEach((l) =>
  console.log(`  ${l.name} | ${l.phone || '—'} | ${l.email || '—'} | review=${l.needsReview} | stage=${l.stage} | ${l.id}`),
);

// 2) needsReview cards
const review = leads.filter((l) => l.needsReview);
console.log(`\n--- needsReview cards (${review.length}) ---`);
review.forEach((l) => console.log(`  ${l.name} | ${l.id}`));

// 3) Duplicate by case number
const byCase = new Map();
leads.forEach((l) => {
  if (!l.caseNum) return;
  byCase.set(l.caseNum, [...(byCase.get(l.caseNum) || []), l]);
});
console.log(`\n--- Duplicate by case number ---`);
[...byCase].filter(([, g]) => g.length > 1).forEach(([c, g]) =>
  console.log(`  case ${c}: ${g.map((x) => x.name + '/' + x.id).join('  ||  ')}`),
);

// 4) Duplicate by normalized name
const byName = new Map();
leads.forEach((l) => {
  const k = norm(l.name);
  if (!k || k.includes('needsreview')) return;
  byName.set(k, [...(byName.get(k) || []), l]);
});
console.log(`\n--- Possible duplicate by name ---`);
[...byName].filter(([, g]) => g.length > 1).forEach(([, g]) =>
  console.log(`  ${g.map((x) => `${x.name} [case ${x.caseNum || '—'}, ${x.phone || 'no phone'}] ${x.id}`).join('  ||  ')}`),
);

// 5) Duplicate by phone / email
for (const key of ['phone', 'email']) {
  const m = new Map();
  leads.forEach((l) => {
    const v = norm(l[key]);
    if (!v) return;
    m.set(v, [...(m.get(v) || []), l]);
  });
  const dups = [...m].filter(([, g]) => g.length > 1);
  if (dups.length) {
    console.log(`\n--- Duplicate by ${key} ---`);
    dups.forEach(([v, g]) => console.log(`  ${v}: ${g.map((x) => x.name + '/' + x.id).join('  ||  ')}`));
  }
}

// 6) Find Nesly Gaillard specifically
console.log(`\n--- Search: Gaillard / Nesly ---`);
const hits = leads.filter((l) => /gaillard|nesly/i.test(l.name || ''));
if (!hits.length) console.log('  NONE FOUND in leads collection.');
hits.forEach((l) =>
  console.log(`  ${l.name} | case ${l.caseNum} | stage=${l.stage} | review=${l.needsReview} | msgId=${l.gmailMessageId} | ${l.id}`),
);
