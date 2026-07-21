// Backfill sale detection over historical "bought" calls.
//
// For every CallRail-logged attempt whose stored analysis said the lead bought
// (ai.pitchResult === "bought"), re-fetch the transcript and re-run the
// extended classifier (now with the sale block). Updates each attempt's ai
// fields + outcome (retained -> verbal_yes when no payment was taken on the
// call) and rolls the newest evidence up to the lead: saleStatus,
// salePromisedAt, saleAmount, saleStatusAt. Never touches lead.stage.
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const PROJECT = 'tvchub-f2401';
const ROOT = `https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/(default)`;
const BASE = `${ROOT}/documents`;
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

// Same prompt as functions/src/callrail.ts ANALYSIS_SYSTEM (sale block included).
const ANALYSIS_SYSTEM = `You analyze a phone call transcript between a law firm (Agent) and a traffic-case lead (Caller). The firm's funnel is: reach the lead ("connect"), pitch representation, then the lead buys, declines, or thinks about it.
Return ONLY a JSON object:
- "connection": "conversation" (a real two-way exchange), "brief" (answered but no real exchange, e.g. hung up in seconds), "voicemail" (reached voicemail/answering service), "wrong_number", or "unclear".
- "pitched": true if representation/fees/retainer were discussed as an offer.
- "pitchResult": "bought" (agreed to retain/sign), "declined", "thinking", or "not_pitched".
- "summary": 1-2 tight sentences a colleague can act on. Facts only.
- "commitments": array of concrete promises made by either side ("Member emailing signed retainer today", "Agent to confirm fee with Jody"). [] if none.
- "callbackAt": ISO date (yyyy-mm-dd) ONLY if a specific callback day was agreed, else null.
- "upset": true if the caller is angry/frustrated with the firm.
- "saleStatus": "paid_full" (payment for the FULL fee was actually taken on this call — card number read, payment processed/confirmed), "paid_partial" (a partial/first payment was actually taken on this call), "promised_unpaid" (they agreed to buy/retain but NO payment was taken on this call — e.g. "I'll pay Friday", "my boss will pay", "I'll do the DocuSign later"), or "none" (no sale). CRITICAL: a verbal yes does NOT count as paid. Only mark paid_full/paid_partial when the transcript shows money actually changing hands on this call.
- "saleAmount": the dollar amount quoted or collected as a number (e.g. 1625), or null if no figure was stated.
- "paymentPlan": "full" (paying in one payment), "financed" (payment plan / installments discussed), or "unknown".
- "paymentPromise": for promised_unpaid only — a short quote of what they committed to ("will pay Friday after payday"), else null.
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
  const saleAmount = Number(p.saleAmount);
  return {
    connection: p.connection ?? 'unclear',
    pitched: Boolean(p.pitched),
    pitchResult: p.pitchResult ?? 'not_pitched',
    summary: String(p.summary ?? ''),
    commitments: Array.isArray(p.commitments) ? p.commitments.map(String) : [],
    callbackAt: p.callbackAt || null,
    upset: Boolean(p.upset),
    saleStatus: ['paid_full', 'paid_partial', 'promised_unpaid'].includes(p.saleStatus)
      ? p.saleStatus
      : 'none',
    saleAmount: Number.isFinite(saleAmount) && saleAmount > 0 ? saleAmount : null,
    paymentPlan: ['full', 'financed'].includes(p.paymentPlan) ? p.paymentPlan : 'unknown',
    paymentPromise: p.paymentPromise ? String(p.paymentPromise) : null,
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

let leadsPatched = 0;
let callsAnalyzed = 0;
let promisedLeads = 0;
let promisedTotal = 0;
const promisedList = [];

for (const d of docs) {
  const f = d.fields || {};
  const name = dec(f.name) || '(unnamed)';
  const stage = dec(f.stage);
  const attempts = dec(f.contactAttempts) || [];
  const bought = attempts.filter((a) => a?.via === 'callrail' && a.callId && a.ai?.pitchResult === 'bought');
  if (!bought.length) continue;

  let changed = false;
  // Newest evidence wins the lead rollup — walk chronologically.
  let rollup = null; // { saleStatus, ts, amount }

  for (const a of attempts) {
    if (!bought.includes(a)) continue;
    const call = await fetchCall(a.callId);
    const transcript = call?.transcription || '';
    if (transcript.length <= 40) {
      console.log(`  - ${name}: no transcript for ${a.callId}, leaving as-is`);
      continue;
    }
    let ai;
    try {
      ai = await analyze(transcript, call.direction, call.start_time);
      callsAnalyzed++;
    } catch (e) {
      console.error(`  ! ${name}: analysis failed for ${a.callId}: ${e.message}`);
      continue;
    }
    a.ai = ai;
    const newOutcome =
      ai.pitched && ai.pitchResult === 'bought'
        ? ai.saleStatus === 'promised_unpaid'
          ? 'verbal_yes'
          : 'retained'
        : a.outcome;
    if (newOutcome !== a.outcome) {
      console.log(`  ${name}: ${a.outcome} -> ${newOutcome} (${ai.saleStatus}${ai.saleAmount ? ` $${ai.saleAmount}` : ''})`);
      a.outcome = newOutcome;
    }
    changed = true;
    if (ai.saleStatus !== 'none' && (a.ts ?? 0) >= (rollup?.ts ?? 0)) {
      rollup = { saleStatus: ai.saleStatus, ts: a.ts ?? 0, amount: ai.saleAmount };
    }
  }
  if (!changed) continue;

  const fieldsPatch = {
    contactAttempts: enc(attempts),
    updatedAt: { integerValue: String(Date.now()) },
  };
  let mask = 'updateMask.fieldPaths=contactAttempts&updateMask.fieldPaths=updatedAt';
  if (rollup) {
    fieldsPatch.saleStatus = { stringValue: rollup.saleStatus };
    fieldsPatch.saleStatusAt = { integerValue: String(rollup.ts) };
    mask += '&updateMask.fieldPaths=saleStatus&updateMask.fieldPaths=saleStatusAt';
    if (rollup.amount) {
      fieldsPatch.saleAmount = { integerValue: String(rollup.amount) };
      mask += '&updateMask.fieldPaths=saleAmount';
    }
    if (rollup.saleStatus === 'promised_unpaid') {
      fieldsPatch.salePromisedAt = { integerValue: String(rollup.ts) };
      mask += '&updateMask.fieldPaths=salePromisedAt';
      const active = !['retained', 'intake_complete', 'lost'].includes(stage);
      if (active) {
        promisedLeads++;
        promisedTotal += rollup.amount ?? 0;
        promisedList.push(
          `${name} [${stage}] — ${rollup.amount ? `$${rollup.amount}` : 'amount unknown'} promised ${new Date(rollup.ts).toISOString().slice(0, 10)}`,
        );
      }
    }
  }
  const docName = d.name.split('/documents/')[1];
  const res = await fetch(`${ROOT}/documents/${docName}?${mask}`, {
    method: 'PATCH',
    headers: fsHeaders,
    body: JSON.stringify({ fields: fieldsPatch }),
  });
  if (!res.ok) console.error('PATCH failed', name, res.status, await res.text());
  else leadsPatched++;
}

console.log('\n--- sale backfill complete ---');
console.log('bought-calls re-analyzed:', callsAnalyzed);
console.log('leads updated:           ', leadsPatched);
console.log('ACTIVE leads promised-unpaid (money on the table):', promisedLeads);
console.log('total promised:          ', `$${promisedTotal}`);
if (promisedList.length) {
  console.log('\nMoney on the table:');
  for (const l of promisedList) console.log('  ' + l);
}
