// Catch sold-but-never-rolled-up stragglers on the main board (Evan Banyameen
// case): leads in an active working stage whose calls show a retained outcome
// or a "bought" pitch, but whose lead-level saleStatus never got set — so the
// sold-case sort skipped them.
//
// For each straggler, every CallRail call on the lead is re-run through the
// extended classifier. Then:
//   paid_full        -> stage intake_complete   (dates from the PAID call)
//   paid_partial     -> stage financed
//   promised_unpaid  -> rollup only, stays on the board under the gold ribbon
//   ambiguous/none   -> gold "verify payment" post-it so a human decides
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

// Same prompt as functions/src/callrail.ts ANALYSIS_SYSTEM.
const ANALYSIS_SYSTEM = `You analyze a phone call transcript between a law firm (Agent) and a traffic-case lead (Caller). The firm's funnel is: reach the lead ("connect"), pitch representation, then the lead buys, declines, or thinks about it.
Return ONLY a JSON object:
- "connection": "conversation" (a real two-way exchange), "brief" (answered but no real exchange, e.g. hung up in seconds), "voicemail" (reached voicemail/answering service), "wrong_number", or "unclear".
- "pitched": true if representation/fees/retainer were discussed as an offer.
- "pitchResult": "bought" (agreed to retain/sign), "declined", "thinking", or "not_pitched".
- "summary": 1-2 tight sentences a colleague can act on. Facts only.
- "commitments": array of concrete promises made by either side ("Member emailing signed retainer today", "Agent to confirm fee with Jody"). [] if none.
- "callbackAt": ISO date (yyyy-mm-dd) ONLY if a specific callback day was agreed, else null.
- "upset": true if the caller is angry/frustrated with the firm.
- "saleStatus": "paid_full" (payment for the FULL fee was actually taken on this call — card number read, payment processed/confirmed), "paid_partial" (a partial/first payment was actually taken on this call), "promised_unpaid" (they agreed to buy/retain but NO payment was taken on this call — e.g. "I'll pay Friday", "my boss will pay", "I'll do the DocuSign later"), or "none" (no sale). CRITICAL: a verbal yes does NOT count as paid. Only mark paid_full/paid_partial when the transcript shows money actually changing hands on this call. NOTE: if the caller CONFIRMS a payment already made earlier (e.g. "yes, I got the receipt", "the payment went through"), treat that as paid on the earlier occasion — use "paid_full"/"paid_partial" only when THIS call contains the confirmation that money has actually been received.
- "saleAmount": the dollar amount quoted or collected as a number (e.g. 1625), or null if no figure was stated.
- "paymentPlan": "full" (paying in one payment), "financed" (payment plan / installments discussed), or "unknown".
- "paymentPromise": for promised_unpaid only — a short quote of what they committed to ("will pay Friday after payday"), else null.
- "nonPaymentReason": for promised_unpaid only — 1-2 sentences explaining WHY money did not change hands on this call. If the caller gave a reason, state it. If the AGENT never asked for payment or never attempted to take payment, say that explicitly. null when not promised_unpaid.
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

const fmtDay = (ts) =>
  new Date(ts).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    timeZone: 'America/Chicago',
  });

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

const WORKING = ['new', 'callback', 'pitched', 'attorney_call', 'nurture'];
const report = [];

for (const d of docs) {
  const f = d.fields || {};
  if (dec(f.deletedAt)) continue;
  const stage = dec(f.stage);
  if (!WORKING.includes(stage)) continue;
  const saleStatus = dec(f.saleStatus);
  if (saleStatus && saleStatus !== 'none') continue; // rollup already exists

  const attempts = dec(f.contactAttempts) || [];
  const soldSignal = attempts.some(
    (a) =>
      a?.outcome === 'retained' ||
      a?.outcome === 'verbal_yes' ||
      a?.ai?.pitchResult === 'bought',
  );
  if (!soldSignal) continue;

  const name = dec(f.name) || '(unnamed)';
  const leadPath = d.name.split('/documents/')[1];
  const leadId = d.name.split('/').pop();
  console.log(`\n=== ${name} [${stage}] — sold signal but no sale rollup`);

  // Re-run every CallRail call through the classifier; newest evidence wins.
  let rollup = null; // { status, ts, amount, reason, summary }
  const evidence = [];
  for (const a of attempts) {
    if (!a?.callId) continue;
    const call = await fetchCall(a.callId);
    const transcript = call?.transcription || '';
    if (transcript.length <= 40) continue;
    let ai;
    try {
      ai = await analyze(transcript, call.direction, call.start_time);
    } catch (e) {
      console.error(`  ! analysis failed for ${a.callId}: ${e.message}`);
      continue;
    }
    a.ai = ai;
    evidence.push(`${fmtDay(a.ts)}: [${ai.saleStatus}] ${ai.summary}`);
    if (ai.saleStatus !== 'none' && (a.ts ?? 0) >= (rollup?.ts ?? 0)) {
      rollup = {
        status: ai.saleStatus,
        ts: a.ts ?? 0,
        amount: ai.saleAmount,
        reason: ai.nonPaymentReason,
        summary: ai.summary,
      };
    }
  }

  const now = Date.now();
  const patch = { contactAttempts: enc(attempts), updatedAt: { integerValue: String(now) } };
  let verdict;

  if (rollup && (rollup.status === 'paid_full' || rollup.status === 'paid_partial')) {
    const to = rollup.status === 'paid_full' ? 'intake_complete' : 'financed';
    const label = to === 'intake_complete' ? 'Intake Complete' : 'Financed';
    const note = `Stage moved to ${label} by classifier — payment confirmed on ${fmtDay(rollup.ts)} call`;
    const followUps = (dec(f.followUps) || []).map((fu) =>
      fu?.done ? fu : { ...fu, done: true, doneAt: now },
    );
    Object.assign(patch, {
      stage: { stringValue: to },
      saleStatus: { stringValue: rollup.status },
      saleStatusAt: { integerValue: String(rollup.ts) },
      autoStageNote: { stringValue: note },
      autoStageAt: { integerValue: String(now) },
      retainedAt: { integerValue: String(dec(f.retainedAt) ?? rollup.ts) },
      followUps: enc(followUps),
    });
    if (rollup.amount) patch.saleAmount = { integerValue: String(rollup.amount) };
    if (to === 'financed') patch.isFinanced = { booleanValue: true };
    if (to === 'intake_complete') {
      patch.intakeComplete = { booleanValue: true };
      patch.intakeCompleteAt = { integerValue: String(rollup.ts) };
    }
    verdict = `MOVED -> ${to} (${rollup.status}${rollup.amount ? ` $${rollup.amount}` : ''}, paid call ${fmtDay(rollup.ts)})`;
  } else if (rollup && rollup.status === 'promised_unpaid') {
    Object.assign(patch, {
      saleStatus: { stringValue: 'promised_unpaid' },
      saleStatusAt: { integerValue: String(rollup.ts) },
      salePromisedAt: { integerValue: String(rollup.ts) },
      saleNonPaymentReason: enc(rollup.reason),
    });
    if (rollup.amount) patch.saleAmount = { integerValue: String(rollup.amount) };
    verdict = `promised_unpaid rollup set — stays on board under the gold ribbon`;
  } else {
    // Ambiguous — put a gold verify note on the desk instead of guessing.
    const res = await fetch(`${BASE}/messages`, {
      method: 'POST',
      headers: fsHeaders,
      body: JSON.stringify({
        fields: {
          kind: { stringValue: 'billing_escalation' },
          source: { stringValue: 'system' },
          from: { stringValue: 'TVCHub Cadence' },
          fromName: { stringValue: 'Cadence Engine' },
          subject: { stringValue: `Verify payment: ${name}` },
          message: {
            stringValue:
              `The calls show a sale signal but the transcripts are ambiguous about payment — decide by hand.\n` +
              (evidence.length ? evidence.join('\n') : 'No usable transcripts on file.'),
          },
          nonPaymentReason: { nullValue: null },
          noPursuit: { booleanValue: false },
          tvcCaseNumber: { nullValue: null },
          memberName: { stringValue: name },
          leadId: { stringValue: leadId },
          phone: enc(dec(f.phone)),
          email: enc(dec(f.email)),
          gmailMessageId: { nullValue: null },
          receivedAt: { integerValue: String(now) },
          handled: { booleanValue: false },
          createdAt: { integerValue: String(now) },
          updatedAt: { integerValue: String(now) },
        },
      }),
    });
    if (!res.ok) console.error('CREATE verify note failed', name, res.status, await res.text());
    verdict = 'AMBIGUOUS — gold verify post-it created, lead not moved';
  }

  await patchDoc(leadPath, patch);
  report.push({ name, stage, verdict, evidence });
}

console.log('\n--- straggler rollup complete ---');
if (!report.length) console.log('No stragglers found.');
for (const r of report) {
  console.log(`\n${r.name} [was ${r.stage}]: ${r.verdict}`);
  for (const e of r.evidence) console.log(`  · ${e}`);
}
