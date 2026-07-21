import { execSync } from 'node:child_process';

const PROJECT = 'tvchub-f2401';
const BASE = `https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/(default)/documents`;
const token = execSync('gcloud auth print-access-token').toString().trim();
const headers = { Authorization: `Bearer ${token}`, 'x-goog-user-project': PROJECT };

const docs = [];
let pageToken = '';
do {
  const url = `${BASE}/messages?pageSize=300${pageToken ? `&pageToken=${pageToken}` : ''}`;
  const res = await fetch(url, { headers });
  const json = await res.json();
  (json.documents || []).forEach((d) => docs.push(d));
  pageToken = json.nextPageToken || '';
} while (pageToken);

const s = (f, k) => f?.[k]?.stringValue ?? null;
const n = (f, k) => Number(f?.[k]?.integerValue ?? f?.[k]?.doubleValue ?? 0);

const msgs = docs.map((d) => {
  const f = d.fields || {};
  return {
    id: d.name.split('/').pop(),
    kind: s(f, 'kind'),
    from: s(f, 'from'),
    subject: s(f, 'subject'),
    leadId: s(f, 'leadId'),
    callId: s(f, 'callrailCallId'),
    receivedAt: n(f, 'receivedAt'),
    createdAt: n(f, 'createdAt'),
    handled: f?.handled?.booleanValue ?? false,
    deletedAt: f?.deletedAt?.integerValue ? Number(f.deletedAt.integerValue) : null,
  };
});

console.log('total message docs:', msgs.length);
console.log('not archived:', msgs.filter((m) => !m.deletedAt).length);

const byKey = {};
for (const m of msgs.filter((m) => !m.deletedAt)) {
  const key = `${m.kind} | ${m.from} | ${(m.subject || '').slice(0, 55)}`;
  (byKey[key] ||= []).push(m);
}
const sorted = Object.entries(byKey).sort((a, b) => b[1].length - a[1].length);
for (const [k, v] of sorted.slice(0, 30)) {
  const times = v.map((m) => new Date(m.createdAt).toISOString().slice(5, 16)).sort();
  console.log(String(v.length).padStart(4), k, '| created:', times.slice(0, 3).join(', '), v.length > 3 ? '…' : '');
}
