// Dry run of the retryPdfHandoff sweep's candidate selection (see
// functions/src/pdfhandoff.ts): lists every intake_complete lead and which
// branch — failed-send retry, never-fired catch-up, flagged/skip, or not a
// candidate — the sweep would take. Reads only; writes nothing anywhere.
//
// Usage: node scripts/pdfRetryDryRun.mjs   (requires gcloud auth)

import { execSync } from 'node:child_process';

const PROJECT = 'tvchub-f2401';
const BASE = `https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/(default)/documents`;
const gtoken = execSync('gcloud auth print-access-token').toString().trim();
const headers = {
  Authorization: `Bearer ${gtoken}`,
  'x-goog-user-project': PROJECT,
  'Content-Type': 'application/json',
};

// Mirror the constants in pdfhandoff.ts.
const HANDOFF_LIVE_SINCE = Date.parse('2026-07-22T21:10:00Z');
const MAX_SEND_ATTEMPTS = 3;
const HOUR = 3600_000;

const res = await fetch(`${BASE}:runQuery`, {
  method: 'POST',
  headers,
  body: JSON.stringify({
    structuredQuery: {
      from: [{ collectionId: 'leads' }],
      where: {
        fieldFilter: {
          field: { fieldPath: 'stage' },
          op: 'EQUAL',
          value: { stringValue: 'intake_complete' },
        },
      },
    },
  }),
});
const rows = await res.json();
if (!res.ok) throw new Error(JSON.stringify(rows));

const num = (v) => (v?.integerValue ? Number(v.integerValue) : v?.doubleValue ?? null);
const str = (v) => v?.stringValue ?? null;

const now = Date.now();
let candidates = 0;
for (const row of rows) {
  if (!row.document) continue;
  const f = row.document.fields || {};
  const id = row.document.name.split('/').pop();
  const name = str(f.name) || '(unnamed)';
  const sentAt = num(f.pdfAppSentAt);
  const deletedAt = num(f.deletedAt);
  const err = str(f.pdfAppSendError);
  const attempts = num(f.pdfAppSendAttempts) ?? 0;
  const intakeAt = num(f.intakeCompleteAt);

  let verdict;
  if (deletedAt) verdict = 'skip (deleted)';
  else if (sentAt) verdict = `skip (sent ${new Date(sentAt).toLocaleString()})`;
  else if (attempts >= MAX_SEND_ATTEMPTS) verdict = `skip (flagged after ${attempts} attempts)`;
  else if (err) verdict = `RETRY — failed send (attempt ${attempts + 1}): ${err.slice(0, 80)}`;
  else if (
    typeof intakeAt === 'number' &&
    intakeAt > HANDOFF_LIVE_SINCE &&
    now - intakeAt > HOUR
  )
    verdict = `RETRY — trigger never fired (intake ${new Date(intakeAt).toLocaleString()})`;
  else if (typeof intakeAt === 'number' && intakeAt <= HANDOFF_LIVE_SINCE)
    verdict = 'skip (intake predates handoff feature)';
  else verdict = 'skip (intake < 1h ago or no intakeCompleteAt)';

  if (verdict.startsWith('RETRY')) candidates++;
  console.log(`${name.padEnd(30)} ${id}  ${verdict}`);
}
console.log(`\n${rows.filter((r) => r.document).length} intake_complete leads, ${candidates} retry candidate(s)`);
