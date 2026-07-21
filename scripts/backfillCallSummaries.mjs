// Backfill AI summaries onto existing CallRail-logged contact attempts.
// For each attempt with via=callrail: fetch the transcript from CallRail,
// run the same GPT-4o-mini analysis the sync uses, store it in the `ai`
// field, and trim notes back to the bare facts (the UI renders the summary
// from `ai` now, so summary text embedded in notes would duplicate).
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const PROJECT = 'tvchub-f2401';
const BASE = `https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/(default)/documents`;
const token = execSync('gcloud auth print-access-token').toString().trim();
const fsHeaders = {
  Authorization: `Bearer ${token}`,
  'x-goog-user-project': PROJECT,
  'Content-Type': 'application/json',
};

const env = readFileSync('.env.local', 'utf8');
const CR_KEY = env.match(/^CALLRAIL_API_KEY=(.+)$/m)?.[1]?.trim();
const OPENAI_KEY = env.match(/^OPENAI_API_KEY=(.+)$/m)?.[1]?.trim();
if (!CR_KEY || !OPENAI_KEY) throw new Error('missing keys in .env.local');
const ACCOUNT = 'ACC0abdb2f39b9f45689f56e0e1eaea2ca3';

const ANALYSIS_SYSTEM = `You analyze a phone call transcript between a law firm (Agent) and a traffic-case lead (Caller). The firm's funnel is: reach the lead ("connect"), pitch representation, then the lead buys, declines, or thinks about it.
Return ONLY a JSON object:
- "connection": "conversation" (a real two-way exchange), "brief" (answered but no real exchange, e.g. hung up in seconds), "voicemail" (reached voicemail/answering service), "wrong_number", or "unclear".
- "pitched": true if representation/fees/retainer were discussed as an offer.
- "pitchResult": "bought" (agreed to retain/sign), "declined", "thinking", or "not_pitched".
- "summary": 1-2 tight sentences a colleague can act on. Facts only.
- "commitments": array of concrete promises made by either side. [] if none.
- "callbackAt": ISO date (yyyy-mm-dd) ONLY if a specific callback day was agreed, else null.
- "upset": true if the caller is angry/frustrated with the firm.
Do not invent facts. If the transcript is empty or useless, use connection "unclear", empty summary.`;

async function analyze(transcript, direction, startTime) {
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${OPENAI_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'gpt-4o-mini',
      temperature: 0,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: ANALYSIS_SYSTEM },
        {
          role: 'user',
          content: `Call direction: ${direction}. Call date: ${startTime}.\n\nTranscript:\n${transcript.slice(0, 24000)}`,
        },
      ],
    }),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(json.error?.message || `OpenAI ${res.status}`);
  const p = JSON.parse(json.choices?.[0]?.message?.content || '{}');
  return {
    connection: p.connection ?? 'unclear',
    pitched: Boolean(p.pitched),
    pitchResult: p.pitchResult ?? 'not_pitched',
    summary: String(p.summary ?? ''),
    commitments: Array.isArray(p.commitments) ? p.commitments.map(String) : [],
    callbackAt: p.callbackAt || null,
    upset: Boolean(p.upset),
  };
}

async function fetchCall(id) {
  const res = await fetch(
    `https://api.callrail.com/v3/a/${ACCOUNT}/calls/${id}.json?fields=id,direction,transcription,start_time`,
    { headers: { Authorization: `Token token="${CR_KEY}"` } },
  );
  if (!res.ok) return null;
  return res.json();
}

// --- Firestore value encoding (JS -> REST proto) ----------------------------
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

// --- Walk all leads ----------------------------------------------------------
const docs = [];
let pageToken = '';
do {
  const url = `${BASE}/leads?pageSize=300${pageToken ? `&pageToken=${pageToken}` : ''}`;
  const res = await fetch(url, { headers: fsHeaders });
  const json = await res.json();
  (json.documents || []).forEach((d) => docs.push(d));
  pageToken = json.nextPageToken || '';
} while (pageToken);

let patched = 0;
for (const d of docs) {
  const f = d.fields || {};
  const attempts = dec(f.contactAttempts) || [];
  if (!attempts.some((a) => a?.via === 'callrail')) continue;

  let changed = false;
  for (const a of attempts) {
    if (a?.via !== 'callrail' || !a.callId) continue;

    // Trim any summary text previously appended into notes.
    const m = String(a.notes || '').match(/^((?:In|Out)bound call via CallRail(?: — [^.]*)?\.)/);
    const baseNotes = m ? m[1] : a.notes;

    if (!a.ai) {
      const call = await fetchCall(a.callId);
      const transcript = call?.transcription || '';
      if (transcript.length > 40) {
        try {
          a.ai = await analyze(transcript, call.direction, call.start_time);
          changed = true;
          console.log(`  + summary for ${a.callId}: ${a.ai.summary.slice(0, 90)}`);
        } catch (e) {
          console.error(`  ! analysis failed for ${a.callId}: ${e.message}`);
        }
      } else {
        console.log(`  - no transcript available for ${a.callId} (notes stay factual)`);
      }
    }
    if (baseNotes !== a.notes) {
      a.notes = baseNotes;
      changed = true;
    }
  }
  if (!changed) continue;

  const name = d.name.split('/documents/')[1];
  const url = `${BASE.replace(/\/documents$/, '')}/documents/${name}?updateMask.fieldPaths=contactAttempts&updateMask.fieldPaths=updatedAt`;
  const res = await fetch(url, {
    method: 'PATCH',
    headers: fsHeaders,
    body: JSON.stringify({
      fields: {
        contactAttempts: enc(attempts),
        updatedAt: { integerValue: String(Date.now()) },
      },
    }),
  });
  if (!res.ok) {
    console.error('PATCH failed', name, res.status, await res.text());
  } else {
    patched++;
    console.log(`updated lead ${dec(f.name) || name}`);
  }
}
console.log('done. leads updated:', patched);
