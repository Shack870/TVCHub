// Heals "Needs Review" cards whose PDFs couldn't be read at ingest time (e.g.
// during an OpenAI outage): re-runs the same LLM extraction on each card's
// stored PDF, fills in missing scalar fields, and clears the review flag once
// the card has a real name and core referral data. Cards without attachments
// are left alone. Requires OPENAI_API_KEY in .env.local and gcloud auth.
//
// Dry run by default; pass --apply to write.

import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const APPLY = process.argv.includes('--apply');
const PROJECT = 'tvchub-f2401';
const BASE = `https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/(default)/documents`;
const token = execSync('gcloud auth print-access-token').toString().trim();
const headers = { Authorization: `Bearer ${token}`, 'x-goog-user-project': PROJECT };

const env = readFileSync('.env.local', 'utf8');
const OPENAI_KEY = env.match(/^OPENAI_API_KEY=(.+)$/m)?.[1]?.trim();
if (!OPENAI_KEY) throw new Error('OPENAI_API_KEY not found in .env.local');

// Scalar fields we patch from a heal (arrays like tickets are skipped — the
// "charge" summary is what the card displays).
const SCALARS = [
  'tvcCaseNumber', 'name', 'phone', 'email', 'address', 'birthdate', 'language',
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
- Use null for anything not present. Do not invent values. Strip the internal "FLEET" tag from city names.`;

async function extractFromPdf(base64Pdf) {
  const res = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: { Authorization: `Bearer ${OPENAI_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'gpt-4o',
      input: [{
        role: 'user',
        content: [
          { type: 'input_text', text: `${SYSTEM}\n\nExtract the referral into JSON.` },
          { type: 'input_file', filename: 'referral.pdf', file_data: `data:application/pdf;base64,${base64Pdf}` },
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

const s = (f, k) => f?.[k]?.stringValue ?? null;
const b = (f, k) => f?.[k]?.booleanValue ?? false;

const docs = [];
let pt = '';
do {
  const r = await fetch(`${BASE}/leads?pageSize=300${pt ? `&pageToken=${pt}` : ''}`, { headers });
  const j = await r.json();
  (j.documents || []).forEach((d) => docs.push(d));
  pt = j.nextPageToken || '';
} while (pt);

const reviews = docs.filter((d) => b(d.fields, 'needsReview'));
console.log(`needsReview cards: ${reviews.length}`);
console.log(APPLY ? '*** APPLY MODE ***\n' : '(dry run — pass --apply to write)\n');

for (const d of reviews) {
  const f = d.fields || {};
  const id = d.name.split('/').pop();
  const atts = f.attachments?.arrayValue?.values ?? [];
  const pdfAtts = atts
    .map((a) => a.mapValue?.fields)
    .filter((af) => /\.pdf$/i.test(af?.name?.stringValue ?? '') && af?.url?.stringValue);
  console.log(`===== ${s(f, 'name')} (${id}) — ${atts.length} attachment(s)`);
  if (!pdfAtts.length) {
    console.log('  no PDF attachment; leaving as-is\n');
    continue;
  }

  // Try every PDF (referral form vs citation scans), keep first non-empty
  // value per field.
  const extracted = {};
  for (const af of pdfAtts) {
    const pdfRes = await fetch(af.url.stringValue);
    if (!pdfRes.ok) {
      console.log(`  ${af.name.stringValue}: download failed (${pdfRes.status})`);
      continue;
    }
    const b64 = Buffer.from(await pdfRes.arrayBuffer()).toString('base64');
    try {
      const got = await extractFromPdf(b64);
      let added = 0;
      for (const [k, v] of Object.entries(got)) {
        if (!extracted[k] && v) {
          extracted[k] = v;
          added++;
        }
      }
      console.log(`  ${af.name.stringValue}: ${added} new field(s)`);
    } catch (e) {
      console.log(`  ${af.name.stringValue}: extraction failed: ${e.message}`);
    }
  }

  // Fill only fields the card is missing (placeholder name counts as missing).
  const patch = {};
  for (const k of SCALARS) {
    const cur = s(f, k);
    const curEmpty = !cur || (k === 'name' && /needs review/i.test(cur));
    if (extracted[k] && curEmpty) patch[k] = { stringValue: String(extracted[k]) };
  }
  const merged = (k) => patch[k]?.stringValue ?? s(f, k);
  const healed =
    merged('name') &&
    !/needs review/i.test(merged('name')) &&
    Boolean(merged('courtName') || merged('county') || merged('charge'));
  if (healed) patch.needsReview = { booleanValue: false };

  console.log(`  filling: ${Object.keys(patch).join(', ') || '(nothing new)'}${healed ? '  -> flag cleared' : ''}`);
  if (APPLY && Object.keys(patch).length) {
    const mask = Object.keys(patch)
      .map((k) => `updateMask.fieldPaths=${encodeURIComponent(k)}`)
      .join('&');
    const r = await fetch(`https://firestore.googleapis.com/v1/${d.name}?${mask}`, {
      method: 'PATCH',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ fields: patch }),
    });
    console.log(r.ok ? '  patched ✓' : `  PATCH FAILED: ${await r.text()}`);
  }
  console.log('');
}

console.log('Done.');
