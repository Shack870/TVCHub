/**
 * Experiment: multimodal LLM extraction of a TVC referral PDF.
 * Rasterizes the PDF to page images, sends them to OpenAI, and prints clean JSON.
 *
 * Usage:
 *   node scripts/llmextract.mjs "/path/to/referral.pdf"
 *
 * Reads OPENAI_API_KEY (and optional OPENAI_MODEL) from .env.local or the env.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

function loadEnv() {
  const env = { ...process.env };
  for (const file of ['.env.local', '.env']) {
    if (!fs.existsSync(file)) continue;
    for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m && !env[m[1]]) env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  }
  return env;
}

const env = loadEnv();
const apiKey = env.OPENAI_API_KEY;
const model = env.OPENAI_MODEL || 'gpt-4o';
const pdfPath = process.argv[2];

if (!apiKey) {
  console.error('Missing OPENAI_API_KEY. Paste it into .env.local and retry.');
  process.exit(1);
}
if (!pdfPath || !fs.existsSync(pdfPath)) {
  console.error('Pass a PDF path: node scripts/llmextract.mjs "<file.pdf>"');
  process.exit(1);
}

// 1) Rasterize the PDF to PNG pages.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tvcllm-'));
execFileSync('pdftoppm', ['-png', '-r', '160', pdfPath, path.join(tmp, 'p')]);
const images = fs
  .readdirSync(tmp)
  .filter((f) => f.endsWith('.png'))
  .sort()
  .map((f) => fs.readFileSync(path.join(tmp, f)).toString('base64'));
console.error(`Rasterized ${images.length} page(s); calling ${model}…`);

// 2) Build the extraction request.
const SCHEMA_KEYS = [
  'tvcCaseNumber', 'name', 'phone', 'email', 'address', 'birthdate', 'language',
  'driversLicense', 'driversLicenseState', 'driversLicenseType', 'vehicleType',
  'violationDate', 'caseOpenedOn', 'familyMemberName', 'familyMemberRelationship',
  'tickets', 'charge', 'courtName', 'courtPhone', 'courtAddress', 'courtCity',
  'county', 'state', 'courtZip', 'movingViolation', 'preExisting',
  'accidentInvolved', 'examinationReport', 'nextCourtDate', 'nextCourtTime',
  'nextCourtType', 'attorneyNames', 'firmName', 'firmAddress', 'firmPhone',
  'firmFax', 'attorneyMobile', 'attorneyEmail', 'lawType', 'tvcNotes',
];

const system = `You extract structured data from a TVC Pro Driver traffic-law referral sheet (images of the pages).
Return ONLY a JSON object with these keys: ${SCHEMA_KEYS.join(', ')}.
Rules:
- "name", "phone", "email", "address", "birthdate", "language", "driversLicense*", "vehicleType" describe the MEMBER (the client/driver) — the "Member Info" column. NEVER use the firm/attorney info for these.
- "attorney*"/"firm*"/"lawType" come from the "Attorney Info" column (our firm).
- "courtName", "courtPhone", "courtAddress", "courtCity", "county", "state", "courtZip" come from "Court Info".
- "movingViolation", "preExisting", "accidentInvolved", "examinationReport" come from "Driver Info".
- "tickets" is an array of {number, violation, code} from the Tickets table; "charge" is a short "; "-joined summary of the violations.
- Dates as ISO yyyy-mm-dd. "nextCourtDate"/"nextCourtTime"/"nextCourtType" from the first row of "Court Dates".
- "tvcNotes" = the "Description/Entry/Date" activity log as readable text.
- Use null for anything not present. Do not invent values. Strip the internal "FLEET" tag from city names.`;

const content = [
  { type: 'text', text: 'Extract the referral into JSON per the schema.' },
  ...images.map((b64) => ({
    type: 'image_url',
    image_url: { url: `data:image/png;base64,${b64}`, detail: 'high' },
  })),
];

const res = await fetch('https://api.openai.com/v1/chat/completions', {
  method: 'POST',
  headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({
    model,
    temperature: 0,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: system },
      { role: 'user', content },
    ],
  }),
});

const json = await res.json();
if (!res.ok) {
  console.error('OpenAI error:', JSON.stringify(json, null, 2));
  process.exit(1);
}
const out = json.choices?.[0]?.message?.content || '{}';
const usage = json.usage || {};
let parsed;
try {
  parsed = JSON.parse(out);
} catch {
  console.log(out);
  process.exit(0);
}
console.error(
  `tokens: prompt=${usage.prompt_tokens} completion=${usage.completion_tokens}`,
);
console.log(JSON.stringify(parsed, null, 2));
