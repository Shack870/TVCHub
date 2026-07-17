// One-off repair for the 2026-07-17 extraction failures:
//  - Khadar Burale: the good card got the PDF filename (50843389) as its case
//    number, so the second email spawned a thin review card. Fix the case
//    number to 1563144, move the CamScanner PDF onto the good card, archive
//    the review card.
//  - Parmjeet Singh: the LLM hallucinated "John Doe" placeholder data for his
//    referral PDF. Move the real PDF onto his review card, re-extract it to
//    fill the fields, clear the flag, archive the John Doe card.
// Requires OPENAI_API_KEY in .env.local and gcloud auth. Applies immediately.

import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const PROJECT = 'tvchub-f2401';
const BASE = `https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/(default)/documents`;
const token = execSync('gcloud auth print-access-token').toString().trim();
const headers = {
  Authorization: `Bearer ${token}`,
  'x-goog-user-project': PROJECT,
  'Content-Type': 'application/json',
};

const OPENAI_KEY = readFileSync('.env.local', 'utf8').match(/^OPENAI_API_KEY=(.+)$/m)?.[1]?.trim();
if (!OPENAI_KEY) throw new Error('OPENAI_API_KEY not found in .env.local');

const IDS = {
  buraleGood: 'zfZFQBbkiUtWc4gmw1hf',
  buraleReview: 'Gd2jVKo1n90g8Xk7ykmk',
  singhReview: 'QEM7hqqjRWAiKEyaL7LU',
  johnDoe: 'GNg17i9NGHNB36OtPbOV',
};

async function getDoc(id) {
  const r = await fetch(`${BASE}/leads/${id}`, { headers });
  if (!r.ok) throw new Error(`GET ${id}: ${r.status}`);
  return r.json();
}

async function patchDoc(id, fields) {
  const mask = Object.keys(fields)
    .map((k) => `updateMask.fieldPaths=${encodeURIComponent(k)}`)
    .join('&');
  const r = await fetch(`${BASE}/leads/${id}?${mask}`, {
    method: 'PATCH',
    headers,
    body: JSON.stringify({ fields }),
  });
  if (!r.ok) throw new Error(`PATCH ${id}: ${r.status} ${await r.text()}`);
}

const SCALARS = [
  'name', 'phone', 'email', 'address', 'birthdate', 'language',
  'driversLicense', 'driversLicenseState', 'driversLicenseType', 'vehicleType',
  'violationDate', 'caseOpenedOn', 'charge', 'courtName', 'courtPhone',
  'courtAddress', 'courtCity', 'county', 'state', 'courtZip', 'nextCourtDate',
  'nextCourtTime', 'nextCourtType', 'tvcNotes',
];

const SYSTEM = `You extract structured data from a TVC Pro Driver traffic-law referral (PDF).
Return ONLY a JSON object with these keys: ${SCALARS.join(', ')}.
Rules:
- "name","phone","email","address","birthdate","language","driversLicense*","vehicleType" describe the MEMBER (client/driver) from "Member Info". NEVER use firm/attorney info.
- "courtName","courtPhone","courtAddress","courtCity","county","state","courtZip" come from "Court Info".
- "charge" is a short "; "-joined summary of the ticket violations.
- Dates as ISO yyyy-mm-dd. "nextCourtDate"/"nextCourtTime"/"nextCourtType" from the first row of "Court Dates".
- Use null for anything not present. Do not invent values.
- NEVER output placeholder or sample values (e.g. "John Doe", "Anytown"). If unreadable, return null for every field.`;

async function extractFromPdfUrl(url) {
  const pdfRes = await fetch(url);
  if (!pdfRes.ok) throw new Error(`PDF download ${pdfRes.status}`);
  const b64 = Buffer.from(await pdfRes.arrayBuffer()).toString('base64');
  const res = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: { Authorization: `Bearer ${OPENAI_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'gpt-4o',
      input: [{
        role: 'user',
        content: [
          { type: 'input_text', text: `${SYSTEM}\n\nExtract the referral into JSON.` },
          { type: 'input_file', filename: 'referral.pdf', file_data: `data:application/pdf;base64,${b64}` },
        ],
      }],
    }),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(json.error?.message || `OpenAI ${res.status}`);
  let raw = json.output_text || '';
  if (!raw && Array.isArray(json.output)) {
    raw = json.output
      .flatMap((o) => (o.content || []).filter((c) => c.type === 'output_text').map((c) => c.text || ''))
      .join('');
  }
  const m = raw.match(/\{[\s\S]*\}/);
  const fields = JSON.parse(m ? m[0] : '{}');
  for (const k of Object.keys(fields)) {
    if (fields[k] === null || fields[k] === '') delete fields[k];
  }
  return fields;
}

const now = Date.now();
const ts = { integerValue: String(now) };

// --- Khadar Burale ---
const buraleGood = await getDoc(IDS.buraleGood);
const buraleReview = await getDoc(IDS.buraleReview);
const goodAtts = buraleGood.fields.attachments?.arrayValue?.values ?? [];
const reviewAtts = buraleReview.fields.attachments?.arrayValue?.values ?? [];
await patchDoc(IDS.buraleGood, {
  tvcCaseNumber: { stringValue: '1563144' },
  attachments: { arrayValue: { values: [...goodAtts, ...reviewAtts] } },
  updatedAt: ts,
});
console.log('Khadar good card: case -> 1563144, attachments merged');
await patchDoc(IDS.buraleReview, { deletedAt: ts, updatedAt: ts });
console.log('Khadar review card: archived');

// --- Parmjeet Singh ---
const johnDoe = await getDoc(IDS.johnDoe);
const singhReview = await getDoc(IDS.singhReview);
const doeAtts = johnDoe.fields.attachments?.arrayValue?.values ?? [];
const singhAtts = singhReview.fields.attachments?.arrayValue?.values ?? [];
const realPdfUrl = doeAtts[0]?.mapValue?.fields?.url?.stringValue;
if (!realPdfUrl) throw new Error('John Doe card has no attachment URL');

console.log('Re-extracting Parmjeet referral PDF...');
const got = await extractFromPdfUrl(realPdfUrl);
console.log('Extracted:', Object.keys(got).join(', '));
if (/doe/i.test(String(got.name || ''))) throw new Error('Extraction hallucinated again — rerun');

const patch = {
  attachments: { arrayValue: { values: [...doeAtts, ...singhAtts] } },
  pdfUrl: { stringValue: realPdfUrl },
  updatedAt: ts,
};
for (const k of SCALARS) {
  const cur = singhReview.fields[k]?.stringValue;
  if (got[k] && (!cur || (k === 'name' && /needs review/i.test(cur)))) {
    patch[k] = { stringValue: String(got[k]) };
  }
}
const healedName = patch.name?.stringValue ?? singhReview.fields.name?.stringValue;
const healedCore = (k) => patch[k]?.stringValue ?? singhReview.fields[k]?.stringValue;
if (healedName && (healedCore('courtName') || healedCore('county') || healedCore('charge'))) {
  patch.needsReview = { booleanValue: false };
}
await patchDoc(IDS.singhReview, patch);
console.log(`Parmjeet card: filled ${Object.keys(patch).length - 3} field(s)${patch.needsReview ? ', flag cleared' : ''}`);
await patchDoc(IDS.johnDoe, { deletedAt: ts, updatedAt: ts });
console.log('John Doe card: archived');
console.log('Done.');
