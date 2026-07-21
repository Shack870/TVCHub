// Align auto-logged CallRail attempt outcomes with the manual decision tree.
// For attempts whose stored AI analysis shows a pitched conversation, remap
// outcome: bought -> retained, declined -> declined, thinking -> thinking.
// Also stamps lastConnectedAt for any conversation outcome. Stages untouched.
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

const docs = [];
let pageToken = '';
do {
  const url = `${BASE}/leads?pageSize=300${pageToken ? `&pageToken=${pageToken}` : ''}`;
  const res = await fetch(url, { headers });
  const json = await res.json();
  (json.documents || []).forEach((d) => docs.push(d));
  pageToken = json.nextPageToken || '';
} while (pageToken);

const CONVO = ['spoke', 'thinking', 'declined', 'retained'];
let leadsPatched = 0;
let remapped = 0;

for (const d of docs) {
  const f = d.fields || {};
  const attempts = dec(f.contactAttempts) || [];
  const name = dec(f.name) || '(unnamed)';
  let changed = false;
  let connectedAt = dec(f.lastConnectedAt) || 0;

  for (const a of attempts) {
    if (a?.via !== 'callrail' || !a.ai) continue;
    const ai = a.ai;
    let want = a.outcome;
    if (ai.connection === 'conversation' && ai.pitched) {
      if (ai.pitchResult === 'bought') want = 'retained';
      else if (ai.pitchResult === 'declined') want = 'declined';
      else if (ai.pitchResult === 'thinking') want = 'thinking';
    }
    if (want !== a.outcome) {
      console.log(`  ${name}: ${a.outcome} -> ${want}  (${new Date(a.ts).toISOString().slice(0, 16)})`);
      a.outcome = want;
      changed = true;
      remapped++;
    }
    if (CONVO.includes(a.outcome) && (a.ts ?? 0) > connectedAt) {
      connectedAt = a.ts;
      changed = true;
    }
  }
  if (!changed) continue;

  const docName = d.name.split('/documents/')[1];
  const fieldsPatch = {
    contactAttempts: enc(attempts),
    updatedAt: { integerValue: String(Date.now()) },
    lastConnectedAt: { integerValue: String(connectedAt) },
  };
  const mask =
    'updateMask.fieldPaths=contactAttempts&updateMask.fieldPaths=updatedAt&updateMask.fieldPaths=lastConnectedAt';
  const res = await fetch(`${ROOT}/documents/${docName}?${mask}`, {
    method: 'PATCH',
    headers,
    body: JSON.stringify({ fields: fieldsPatch }),
  });
  if (!res.ok) console.error('PATCH failed', name, res.status, await res.text());
  else leadsPatched++;
}

console.log(`done. outcomes remapped: ${remapped} across ${leadsPatched} leads`);
