import { execSync } from 'node:child_process';

const PROJECT = 'tvchub-f2401';
const BASE = `https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/(default)/documents`;
const token = execSync('gcloud auth print-access-token').toString().trim();
const headers = { Authorization: `Bearer ${token}`, 'x-goog-user-project': PROJECT };

const docs = [];
let pageToken = '';
do {
  const url = `${BASE}/leads?pageSize=300${pageToken ? `&pageToken=${pageToken}` : ''}`;
  const json = await (await fetch(url, { headers })).json();
  (json.documents || []).forEach((d) => docs.push(d.name));
  pageToken = json.nextPageToken || '';
} while (pageToken);

console.log(`Deleting ${docs.length} leads…`);
for (const name of docs) {
  const res = await fetch(`https://firestore.googleapis.com/v1/${name}`, { method: 'DELETE', headers });
  if (!res.ok) console.log('FAILED', name);
}
console.log('Done — leads collection cleared.');
