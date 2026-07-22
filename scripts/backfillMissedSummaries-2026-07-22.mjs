// One-off backfill (2026-07-22): two outbound calls were processed by the
// CallRail sync WHILE STILL IN PROGRESS (duration/recording_duration were null,
// so the 3-hour transcript deferral didn't trigger and the marker doc blocked
// any retry). Their attempts were logged bare — no duration, no recording
// link, no AI summary. This re-fetches the now-final call records, runs the
// same GPT-4o-mini analysis the sync uses (full schema incl. sale block), and
// patches the attempts in place: notes, durationSec, recordingUrl, outcome,
// ai — plus lastConnectedAt / sale rollup on the lead where applicable.
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const TARGETS = [
  { leadId: 'i7anoXzW226de1esg5YD', callId: 'CAL019f8ab7a90276e1b208dd154c97596b' }, // RASHARD ANDERSON
  { leadId: 'wKfZLAkju6lc3lBWa9vY', callId: 'CAL019f864c54767aeb88cbc93675eca382' }, // Juan Escobedo
];

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

// Same prompt the deployed sync uses (functions/src/callrail.ts).
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
- "nonPaymentReason": for promised_unpaid only — 1-2 sentences explaining WHY money did not change hands on this call. If the caller gave a reason, state it ("Gets paid Friday and will call back then", "Needs to check with his boss who covers company tickets"). If the AGENT never asked for payment or never attempted to run a card, say that explicitly ("The agent never asked for payment on this call — the yes was left hanging with no collection attempt"). null when not promised_unpaid.
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
    nonPaymentReason: p.nonPaymentReason ? String(p.nonPaymentReason) : null,
  };
}

// Same outcome mapping as the sync (functions/src/callrail.ts outcomeFor).
function outcomeFor(call, analysis) {
  if (analysis && analysis.connection !== 'unclear') {
    if (analysis.connection === 'voicemail') return 'voicemail';
    if (analysis.connection !== 'conversation') return 'no_answer';
    if (analysis.pitched) {
      if (analysis.pitchResult === 'bought')
        return analysis.saleStatus === 'promised_unpaid' ? 'verbal_yes' : 'retained';
      if (analysis.pitchResult === 'declined') return 'declined';
      if (analysis.pitchResult === 'thinking') return 'thinking';
    }
    return 'spoke';
  }
  return call.voicemail ? 'voicemail' : call.answered ? 'spoke' : 'no_answer';
}

const CONVERSATION_OUTCOMES = ['spoke', 'thinking', 'declined', 'retained', 'verbal_yes'];

function fmtDuration(sec) {
  if (!sec) return '';
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return m ? `${m}m ${s}s` : `${s}s`;
}

async function fetchCall(id) {
  const fields =
    'id,direction,answered,voicemail,duration,start_time,recording_player,recording_duration,transcription';
  const res = await fetch(
    `https://api.callrail.com/v3/a/${ACCOUNT}/calls/${id}.json?fields=${fields}`,
    { headers: { Authorization: `Token token="${CR_KEY}"` } },
  );
  if (!res.ok) throw new Error(`CallRail ${res.status} for ${id}`);
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

for (const { leadId, callId } of TARGETS) {
  const leadRes = await fetch(`${BASE}/leads/${leadId}`, { headers: fsHeaders });
  const leadDoc = await leadRes.json();
  const lead = Object.fromEntries(
    Object.entries(leadDoc.fields || {}).map(([k, v]) => [k, dec(v)]),
  );
  console.log(`\n=== ${lead.name} (${leadId}) — stage: ${lead.stage}`);

  const attempts = Array.isArray(lead.contactAttempts) ? lead.contactAttempts : [];
  const attempt = attempts.find((a) => a?.callId === callId);
  if (!attempt) {
    console.error(`  ! no attempt with callId ${callId}`);
    continue;
  }
  if (attempt.ai) {
    console.log('  already has ai — skipping');
    continue;
  }

  const call = await fetchCall(callId);
  const transcript = call.transcription || '';
  console.log(
    `  call: ${call.duration}s, recorded=${Boolean(call.recording_duration)}, transcript=${transcript.length} chars`,
  );
  if (transcript.length <= 40) {
    console.log('  - no usable transcript; nothing to backfill');
    continue;
  }

  const analysis = await analyze(transcript, call.direction, call.start_time);
  console.log('  analysis:', JSON.stringify(analysis, null, 2));

  const outcome = outcomeFor(call, analysis);
  const dir = call.direction === 'inbound' ? 'Inbound' : 'Outbound';
  const dur = fmtDuration(call.duration);
  attempt.outcome = outcome;
  attempt.notes = `${dir} call via CallRail${dur ? ` — ${dur}` : ''}.`;
  if (analysis.connection === 'wrong_number')
    attempt.notes += ' ⚠ Sounded like a wrong number — verify the phone on file.';
  attempt.recordingUrl = call.recording_player || null;
  attempt.durationSec = call.duration ?? null;
  attempt.ai = analysis;

  const startedAt = attempt.ts;
  const patchFields = {
    contactAttempts: enc(attempts),
    updatedAt: { integerValue: String(Date.now()) },
  };
  const maskPaths = ['contactAttempts', 'updatedAt'];

  if (CONVERSATION_OUTCOMES.includes(outcome) && (lead.lastConnectedAt ?? 0) < startedAt) {
    patchFields.lastConnectedAt = { integerValue: String(startedAt) };
    maskPaths.push('lastConnectedAt');
  }

  // Sale rollup — same rule as the sync: only evidence newer than what's
  // already on the lead can change the billing state.
  if (analysis.saleStatus !== 'none' && startedAt > (lead.saleStatusAt ?? 0)) {
    patchFields.saleStatus = { stringValue: analysis.saleStatus };
    patchFields.saleStatusAt = { integerValue: String(startedAt) };
    maskPaths.push('saleStatus', 'saleStatusAt');
    if (analysis.saleAmount) {
      patchFields.saleAmount = { integerValue: String(analysis.saleAmount) };
      maskPaths.push('saleAmount');
    }
    if (analysis.saleStatus === 'promised_unpaid') {
      patchFields.salePromisedAt = { integerValue: String(startedAt) };
      patchFields.saleNonPaymentReason = analysis.nonPaymentReason
        ? { stringValue: analysis.nonPaymentReason }
        : { nullValue: null };
      maskPaths.push('salePromisedAt', 'saleNonPaymentReason');
    }
    console.log(`  sale rollup -> ${analysis.saleStatus}`);
  }

  const mask = maskPaths.map((p) => `updateMask.fieldPaths=${p}`).join('&');
  const res = await fetch(`${BASE}/leads/${leadId}?${mask}`, {
    method: 'PATCH',
    headers: fsHeaders,
    body: JSON.stringify({ fields: patchFields }),
  });
  if (!res.ok) {
    console.error('  PATCH failed', res.status, await res.text());
  } else {
    console.log(`  ✓ backfilled: outcome=${outcome}, summary="${analysis.summary}"`);
  }
}
console.log('\ndone.');
