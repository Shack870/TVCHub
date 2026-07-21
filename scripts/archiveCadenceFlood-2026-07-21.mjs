// One-off: archive the "Court date passed" post-its from the first cadence
// sweep (2026-07-21). The courtPassedNotifiedAt flags are already set on the
// leads, so these will not be recreated.
import { execSync } from 'node:child_process';

const PROJECT = 'tvchub-f2401';
const BASE = `https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/(default)/documents`;
const token = execSync('gcloud auth print-access-token').toString().trim();
const headers = {
  Authorization: `Bearer ${token}`,
  'x-goog-user-project': PROJECT,
  'Content-Type': 'application/json',
};

const docs = [];
let pageToken = '';
do {
  const url = `${BASE}/messages?pageSize=300${pageToken ? `&pageToken=${pageToken}` : ''}`;
  const res = await fetch(url, { headers });
  const json = await res.json();
  (json.documents || []).forEach((d) => docs.push(d));
  pageToken = json.nextPageToken || '';
} while (pageToken);

const now = Date.now();
let archived = 0;
for (const d of docs) {
  const f = d.fields || {};
  const from = f.from?.stringValue ?? '';
  const subject = f.subject?.stringValue ?? '';
  const deleted = f.deletedAt?.integerValue;
  if (deleted) continue;
  if (from !== 'TVCHub Cadence' || !subject.startsWith('Court date passed:')) continue;
  const name = d.name.split('/documents/')[1];
  const url = `${BASE.replace(/\/documents$/, '')}/documents/${name}?updateMask.fieldPaths=deletedAt&updateMask.fieldPaths=handled&updateMask.fieldPaths=updatedAt`;
  const res = await fetch(url, {
    method: 'PATCH',
    headers,
    body: JSON.stringify({
      fields: {
        deletedAt: { integerValue: String(now) },
        handled: { booleanValue: true },
        updatedAt: { integerValue: String(now) },
      },
    }),
  });
  if (!res.ok) {
    console.error('failed', name, res.status, await res.text());
  } else {
    archived++;
    console.log('archived:', subject);
  }
}
console.log('done. archived', archived, 'post-its');
