import { execSync } from 'node:child_process';

const PROJECT = 'tvchub-f2401';
const BASE = `https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/(default)/documents`;
const token = execSync('gcloud auth print-access-token').toString().trim();
const headers = { Authorization: `Bearer ${token}`, 'x-goog-user-project': PROJECT };

// List all leads (paginated).
const docs = [];
let pageToken = '';
do {
  const url = `${BASE}/leads?pageSize=300${pageToken ? `&pageToken=${pageToken}` : ''}`;
  const res = await fetch(url, { headers });
  const json = await res.json();
  (json.documents || []).forEach((d) => docs.push(d));
  pageToken = json.nextPageToken || '';
} while (pageToken);

console.log(`Total leads: ${docs.length}`);

// Group by tvcCaseNumber; keep the earliest createdAt, delete the rest.
const byCase = new Map();
for (const d of docs) {
  const caseNum = d.fields?.tvcCaseNumber?.stringValue;
  if (!caseNum) continue;
  if (!byCase.has(caseNum)) byCase.set(caseNum, []);
  byCase.get(caseNum).push(d);
}

const toDelete = [];
for (const [, group] of byCase) {
  if (group.length <= 1) continue;
  group.sort((a, b) => {
    const ca = Number(a.fields?.createdAt?.integerValue || a.fields?.createdAt?.doubleValue || 0);
    const cb = Number(b.fields?.createdAt?.integerValue || b.fields?.createdAt?.doubleValue || 0);
    return ca - cb;
  });
  group.slice(1).forEach((d) => toDelete.push(d.name));
}

console.log(`Duplicate docs to delete: ${toDelete.length}`);
for (const name of toDelete) {
  const res = await fetch(`https://firestore.googleapis.com/v1/${name}`, {
    method: 'DELETE',
    headers,
  });
  console.log(res.ok ? `deleted ${name.split('/').pop()}` : `FAILED ${name}`);
}
console.log('Done.');
