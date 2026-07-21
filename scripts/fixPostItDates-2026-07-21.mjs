// One-off: repair receivedAt on Cadence Engine post-its that were stamped
// with sweep-run time instead of the underlying event time. Billing
// escalations get the lead's salePromisedAt (the CallRail promise call).
import { execSync } from 'node:child_process';

const PROJECT = 'tvchub-f2401';
const ROOT = `https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/(default)`;
const BASE = `${ROOT}/documents`;
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

let fixed = 0;
for (const d of docs) {
  const f = d.fields || {};
  if (f.deletedAt?.integerValue) continue;
  if (f.from?.stringValue !== 'TVCHub Cadence') continue;

  const leadId = f.leadId?.stringValue;
  if (!leadId) continue;
  const leadRes = await fetch(`${BASE}/leads/${leadId}`, { headers });
  if (!leadRes.ok) continue;
  const lf = (await leadRes.json()).fields || {};

  let eventAt = null;
  if (f.kind?.stringValue === 'billing_escalation') {
    eventAt =
      Number(lf.salePromisedAt?.integerValue || 0) ||
      Number(lf.saleStatusAt?.integerValue || 0) ||
      null;
  } else if ((f.subject?.stringValue || '').startsWith('Court date passed')) {
    const cd = lf.nextCourtDate?.stringValue;
    if (cd) eventAt = new Date(`${cd}T09:00:00-05:00`).getTime();
  } else if ((f.subject?.stringValue || '').startsWith('No connection after')) {
    const atts = lf.contactAttempts?.arrayValue?.values || [];
    eventAt = atts.reduce((m, a) => Math.max(m, Number(a.mapValue?.fields?.ts?.integerValue || 0)), 0) || null;
  }
  if (!eventAt) continue;

  const current = Number(f.receivedAt?.integerValue || 0);
  if (Math.abs(current - eventAt) < 60_000) continue; // already right

  const name = d.name.split('/documents/')[1];
  const res = await fetch(
    `${ROOT}/documents/${name}?updateMask.fieldPaths=receivedAt&updateMask.fieldPaths=updatedAt`,
    {
      method: 'PATCH',
      headers,
      body: JSON.stringify({
        fields: {
          receivedAt: { integerValue: String(eventAt) },
          updatedAt: { integerValue: String(Date.now()) },
        },
      }),
    },
  );
  if (!res.ok) {
    console.error('PATCH failed', name, res.status, await res.text());
  } else {
    fixed++;
    console.log(
      'fixed:',
      f.subject?.stringValue,
      '|',
      new Date(current).toLocaleString('en-US', { timeZone: 'America/Chicago' }),
      '->',
      new Date(eventAt).toLocaleString('en-US', { timeZone: 'America/Chicago' }),
    );
  }
}
console.log('done. post-its fixed:', fixed);
