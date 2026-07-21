// Backfill the "why wasn't it collected" analysis + pursuit verification for
// the outstanding promised-unpaid leads.
//
// For every ACTIVE lead with saleStatus promised_unpaid:
//   1. Re-run the promise call's transcript through the extended classifier to
//      get nonPaymentReason; store it on the attempt ai block and the lead.
//   2. Pursuit check: any contact attempt (in or out) AFTER the promise call?
//      Zero == the money is waiting purely on us -> no-pursuit alarm.
//   3. Upsert the lead's billing post-it with phone/email/nonPaymentReason and
//      the pursuit status (noPursuit flag drives the max-urgency UI).
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

// Same prompt as functions/src/callrail.ts ANALYSIS_SYSTEM (nonPaymentReason included).
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
  return JSON.parse(json.choices?.[0]?.message?.content || '{}');
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

async function patchDoc(path, fields) {
  const mask = Object.keys(fields)
    .map((k) => `updateMask.fieldPaths=${k}`)
    .join('&');
  const res = await fetch(`${BASE}/${path}?${mask}`, {
    method: 'PATCH',
    headers: fsHeaders,
    body: JSON.stringify({ fields }),
  });
  if (!res.ok) throw new Error(`PATCH ${path} ${res.status}: ${await res.text()}`);
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

// All existing billing post-its, matched by leadId below.
const msgRes = await fetch(`${BASE}/messages?pageSize=300`, { headers: fsHeaders });
const msgDocs = ((await msgRes.json()).documents || []).map((m) => ({
  path: m.name.split('/documents/')[1],
  f: m.fields || {},
}));

const WORKING = ['new', 'callback', 'pitched', 'attorney_call', 'nurture'];
const report = [];

for (const d of docs) {
  const f = d.fields || {};
  if (dec(f.deletedAt)) continue;
  if (dec(f.saleStatus) !== 'promised_unpaid') continue;
  const stage = dec(f.stage);
  if (!WORKING.includes(stage)) continue;

  const name = dec(f.name) || '(unnamed)';
  const leadId = d.name.split('/').pop();
  const leadPath = d.name.split('/documents/')[1];
  const phone = dec(f.phone);
  const email = dec(f.email);
  const amount = dec(f.saleAmount);
  const promisedAt = dec(f.salePromisedAt) ?? dec(f.saleStatusAt) ?? 0;
  const attempts = dec(f.contactAttempts) || [];

  // 1. The promise call: the callrail attempt whose analysis said promised_unpaid,
  // closest to salePromisedAt (fallback: any verbal_yes attempt).
  const promiseAttempt =
    attempts.find((a) => a?.callId && a.ts === promisedAt) ||
    attempts.filter((a) => a?.callId && a.ai?.saleStatus === 'promised_unpaid').pop() ||
    attempts.filter((a) => a?.callId && a.outcome === 'verbal_yes').pop();

  let reason = null;
  if (promiseAttempt?.callId) {
    const call = await fetchCall(promiseAttempt.callId);
    const transcript = call?.transcription || '';
    if (transcript.length > 40) {
      try {
        const ai = await analyze(transcript, call.direction, call.start_time);
        reason = ai.nonPaymentReason ? String(ai.nonPaymentReason) : null;
        promiseAttempt.ai = { ...(promiseAttempt.ai || {}), nonPaymentReason: reason };
      } catch (e) {
        console.error(`  ! ${name}: analysis failed: ${e.message}`);
      }
    } else {
      console.log(`  - ${name}: no transcript for promise call ${promiseAttempt.callId}`);
    }
  } else {
    console.log(`  - ${name}: no promise call with a CallRail id found`);
  }

  // 2. Pursuit check — any call, either direction, after the promise.
  const callsSince = attempts.filter((a) => (a?.ts ?? 0) > promisedAt);
  const noPursuit = callsSince.length === 0;

  const now = Date.now();
  const amt = amount ? `$${amount}` : 'payment';
  const promisedDate = new Date(promisedAt).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    timeZone: 'America/Chicago',
  });

  // 3. Update the lead: reason + pursuit alarm marker (+ attempt ai block).
  const leadPatch = {
    saleNonPaymentReason: enc(reason),
    contactAttempts: enc(attempts),
    updatedAt: { integerValue: String(now) },
  };
  if (noPursuit) {
    leadPatch.salePursuitAlertAt = { integerValue: String(now) };
    leadPatch.saleEscalatedAt = { integerValue: String(dec(f.saleEscalatedAt) ?? now) };
  }
  await patchDoc(leadPath, leadPatch);

  // 4. Upsert the billing post-it.
  const subject = noPursuit
    ? `NO CALLBACK MADE — ${amt} promised ${promisedDate}`
    : `Promised ${amt} never collected: ${name}`;
  const message = noPursuit
    ? `${name} said YES on ${promisedDate} and ${amt} is on the table, but ZERO calls` +
      ` (in or out) have happened since. This money is waiting purely on us — call them NOW.` +
      (reason ? `\nWhy it wasn't collected on the call: ${reason}` : '')
    : `Said yes on ${promisedDate} but ${amt} was never collected` +
      ` (${callsSince.length} call${callsSince.length === 1 ? '' : 's'} since).` +
      ` Decide: keep collecting, re-pitch, or release the file.` +
      (reason ? `\nWhy it wasn't collected on the call: ${reason}` : '');

  const existing = msgDocs.find(
    (m) =>
      dec(m.f.leadId) === leadId &&
      !dec(m.f.deletedAt) &&
      dec(m.f.handled) !== true &&
      (dec(m.f.kind) === 'billing_escalation' || /^Promised .+ never collected/i.test(dec(m.f.subject) ?? '')),
  );

  const noteFields = {
    kind: { stringValue: 'billing_escalation' },
    source: { stringValue: 'system' },
    subject: { stringValue: subject },
    message: { stringValue: message },
    phone: enc(phone),
    email: enc(email),
    nonPaymentReason: enc(reason),
    noPursuit: { booleanValue: noPursuit },
    updatedAt: { integerValue: String(now) },
  };
  if (existing) {
    await patchDoc(existing.path, noteFields);
  } else {
    const res = await fetch(`${BASE}/messages`, {
      method: 'POST',
      headers: fsHeaders,
      body: JSON.stringify({
        fields: {
          ...noteFields,
          from: { stringValue: 'TVCHub Cadence' },
          fromName: { stringValue: 'Cadence Engine' },
          tvcCaseNumber: { nullValue: null },
          memberName: { stringValue: name },
          leadId: { stringValue: leadId },
          gmailMessageId: { nullValue: null },
          receivedAt: { integerValue: String(now) },
          handled: { booleanValue: false },
          createdAt: { integerValue: String(now) },
        },
      }),
    });
    if (!res.ok) console.error('CREATE message failed', name, res.status, await res.text());
  }

  report.push({ name, stage, amt, promisedDate, callsSince: callsSince.length, noPursuit, reason });
}

console.log('\n--- non-payment / pursuit backfill ---');
for (const r of report) {
  console.log(
    `\n${r.name} [${r.stage}] — ${r.amt} promised ${r.promisedDate}` +
      `\n  pursuit: ${r.noPursuit ? '🚨 ZERO calls since the promise — NO-PURSUIT ALARM raised' : `${r.callsSince} call(s) since — normal billing escalation`}` +
      `\n  why not collected: ${r.reason ?? '(no reason extracted)'}`,
  );
}
console.log(`\nleads processed: ${report.length}`);
