// Backfill (2026-07-28): CallRail attempts that were logged WITHOUT an `ai`
// analysis map even though the call clearly connected (duration >= 120s).
// Root cause fixed in functions/src/callrail.ts the same day: a transcript
// that wasn't ready when the call was processed (recording metadata publishes
// late) or a failed OpenAI call (the Michael Harris quota error) logged a
// bare attempt, and the marker doc froze it forever.
//
// This scans ALL leads (any age), finds via=callrail attempts with
// durationSec >= 120 and no ai map, fetches the transcript from CallRail, and
// runs the EXACT classifier the sync uses (full current schema + lead-name
// hint). It patches the attempt in place (ai, outcome upgraded to the
// classifier's read, factual notes, recordingUrl/durationSec refreshed) and
// NEVER touches stage/sale fields — old calls must not re-route cards. Where
// the analysis contradicts the card's current sale state (transcript says
// money moved, card says unsold), it raises an Action Item post-it (live mode
// only, deduped by callrailCallId) instead of acting.
//
// Usage: node scripts/backfillMissingCallAnalyses-2026-07-28.mjs [--live]
// (dry run by default — prints what it would do, writes nothing)
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const LIVE = process.argv.includes('--live');
const MIN_DURATION_SEC = 120;

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

// Same prompt the deployed sync uses (functions/src/callrail.ts ANALYSIS_SYSTEM).
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
- "existingClientInquiry": true ONLY when the caller speaks as an already-hired client checking on a case the firm is ALREADY handling (asking for a status update, court outcome, paperwork, or next steps on their existing case) rather than a prospect being pitched or shopping for representation. false when in doubt.
- "declineType": "hard" ONLY when the caller gave a FINAL, unambiguous no to representation: they already paid/resolved the ticket themselves, already hired another lawyer, the case is already resolved/dismissed, or they explicitly and finally refused ("not interested, stop calling"). A hard decline can appear even without a formal pitch (e.g. the caller opens with "I already paid that ticket myself"). "soft" when the decline could still turn: price objection, wants to think about it, wants to see evidence/paperwork first, needs to check with someone. A price/affordability objection alone is NEVER hard, even when the caller sounds final — it only becomes hard when they also state they are done with the matter (paying/paid the ticket themselves, letting it go, hired someone else). "none" when no decline happened on this call. When in doubt between hard and soft, use "soft".
- "declineReason": for declineType hard/soft — a short factual phrase of why ("already paid the citation himself", "hired another attorney", "thinks the fee is too high"), else null.
- "callerName": the caller's name as stated or heard on this call (full name if given), else null. If our records name a likely caller and the person on the call plausibly is them, use EXACTLY that spelling; if they are clearly a different person, report the name you actually hear.
Do not invent facts. If the transcript is empty or useless, use connection "unclear", empty summary.`;

async function analyze(transcript, direction, startTime, leadName) {
  const leadHint = leadName
    ? `\nOur records say the caller is likely ${leadName} (exact legal spelling from the court referral). If the person on this call plausibly is them, use exactly that spelling for their name; if they are clearly someone else, report the name you actually hear.`
    : '';
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
          content: `Call direction: ${direction}. Call date: ${startTime}.${leadHint}\n\nTranscript:\n${transcript.slice(0, 24000)}`,
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
    existingClientInquiry: Boolean(p.existingClientInquiry),
    declineType: ['hard', 'soft'].includes(p.declineType) ? p.declineType : 'none',
    declineReason: p.declineReason ? String(p.declineReason) : null,
    callerName: p.callerName ? String(p.callerName) : null,
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
  if (!res.ok) {
    console.error(`  ! CallRail ${res.status} for ${id}`);
    return null;
  }
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

// One Action Item per call, ever — matched by callrailCallId + subject prefix.
async function raiseDiscrepancyPostIt(lead, leadId, attempt, analysis) {
  const q = await fetch(`${BASE.replace(/\/documents$/, '')}/documents:runQuery`, {
    method: 'POST',
    headers: fsHeaders,
    body: JSON.stringify({
      structuredQuery: {
        from: [{ collectionId: 'messages' }],
        where: {
          fieldFilter: {
            field: { fieldPath: 'callrailCallId' },
            op: 'EQUAL',
            value: { stringValue: attempt.callId },
          },
        },
        limit: 20,
      },
    }),
  });
  const rows = await q.json();
  const exists = (Array.isArray(rows) ? rows : []).some((r) =>
    String(dec(r.document?.fields?.subject) || '').startsWith('Backfilled call analysis contradicts'),
  );
  if (exists) {
    console.log('    (discrepancy post-it already exists)');
    return false;
  }
  const day = new Date(attempt.ts).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    timeZone: 'America/Chicago',
  });
  const body = {
    kind: 'tvc_message',
    source: 'system',
    from: 'CallRail Sync',
    fromName: 'CallRail Sync',
    subject: `Backfilled call analysis contradicts the card — ${lead.name}`,
    message:
      `A missing transcript analysis was backfilled onto ${lead.name}'s ${day} call and it ` +
      `disagrees with the card's current sale state.\n` +
      `Transcript says: saleStatus ${analysis.saleStatus}` +
      (analysis.saleAmount ? ` ($${analysis.saleAmount})` : '') +
      ` — "${analysis.summary}"\n` +
      `Card says: stage ${lead.stage ?? '—'}, saleStatus ${lead.saleStatus ?? 'none'}` +
      (lead.saleAmount ? `, fee $${lead.saleAmount}` : '') +
      (lead.squarePaidTotal ? `, $${lead.squarePaidTotal} credited via Square` : '') +
      `.\nThe backfill changed NOTHING on the card (old calls never re-route stages/sales) — ` +
      `review the recording and correct the card if the transcript is right.` +
      (attempt.recordingUrl ? `\nListen: ${attempt.recordingUrl}` : ''),
    tvcCaseNumber: null,
    memberName: lead.name,
    leadId,
    phone: lead.phone ?? null,
    email: lead.email ?? null,
    gmailMessageId: null,
    callrailCallId: attempt.callId,
    receivedAt: attempt.ts,
    handled: false,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  if (!LIVE) {
    console.log('    DRY: would raise discrepancy post-it:', body.subject);
    return true;
  }
  const res = await fetch(`${BASE}/messages`, {
    method: 'POST',
    headers: fsHeaders,
    body: JSON.stringify({ fields: enc(body).mapValue.fields }),
  });
  if (!res.ok) console.error('    ! post-it create failed', res.status, await res.text());
  else console.log('    ✓ discrepancy post-it raised');
  return true;
}

// --- Walk all leads ----------------------------------------------------------
console.log(LIVE ? '=== LIVE RUN ===' : '=== DRY RUN (pass --live to write) ===');
const docs = [];
let pageToken = '';
do {
  const url = `${BASE}/leads?pageSize=300${pageToken ? `&pageToken=${pageToken}` : ''}`;
  const res = await fetch(url, { headers: fsHeaders });
  const json = await res.json();
  (json.documents || []).forEach((d) => docs.push(d));
  pageToken = json.nextPageToken || '';
} while (pageToken);
console.log(`leads scanned: ${docs.length}`);

let candidates = 0;
let attached = 0;
let noTranscript = 0;
let discrepancies = 0;
const report = [];

for (const d of docs) {
  const f = d.fields || {};
  const lead = Object.fromEntries(Object.entries(f).map(([k, v]) => [k, dec(v)]));
  if (lead.deletedAt) continue;
  const attempts = Array.isArray(lead.contactAttempts) ? lead.contactAttempts : [];
  const targets = attempts.filter(
    (a) =>
      a?.via === 'callrail' &&
      a.callId &&
      !a.ai &&
      typeof a.durationSec === 'number' &&
      a.durationSec >= MIN_DURATION_SEC,
  );
  if (!targets.length) continue;
  const leadId = d.name.split('/leads/')[1];
  console.log(`\n=== ${lead.name} (${leadId}) — stage ${lead.stage}, saleStatus ${lead.saleStatus ?? 'none'}`);
  let changed = false;

  for (const attempt of targets) {
    candidates++;
    console.log(`  call ${attempt.callId} (${fmtDuration(attempt.durationSec)}, outcome ${attempt.outcome})`);
    const call = await fetchCall(attempt.callId);
    if (!call) continue;
    const transcript = call.transcription || '';
    if (transcript.length <= 40) {
      console.log('    - no transcript available; skipping');
      noTranscript++;
      continue;
    }
    const analysis = await analyze(transcript, call.direction, call.start_time, lead.name);

    // Attach exactly like the sync's late-attach path: ai + outcome upgrade +
    // factual notes + final call facts. NO stage/sale changes on old calls.
    const outcome = outcomeFor(call, analysis);
    const dir = call.direction === 'inbound' ? 'Inbound' : 'Outbound';
    const dur = fmtDuration(call.duration);
    const prevOutcome = attempt.outcome;
    attempt.outcome = outcome;
    attempt.notes = `${dir} call via CallRail${dur ? ` — ${dur}` : ''}.`;
    if (analysis.connection === 'wrong_number')
      attempt.notes += ' ⚠ Sounded like a wrong number — verify the phone on file.';
    attempt.recordingUrl = call.recording_player || attempt.recordingUrl || null;
    attempt.durationSec = call.duration ?? attempt.durationSec ?? null;
    attempt.ai = analysis;
    changed = true;
    attached++;
    console.log(
      `    analysis: connection=${analysis.connection}, pitch=${analysis.pitchResult}, ` +
        `saleStatus=${analysis.saleStatus}${analysis.saleAmount ? ` ($${analysis.saleAmount})` : ''}, ` +
        `outcome ${prevOutcome} -> ${outcome}`,
    );
    console.log(`    summary: ${analysis.summary}`);

    // Transcript claims money moved but the card shows no paid state at all —
    // flag for a human, change nothing.
    const transcriptPaid = ['paid_full', 'paid_partial'].includes(analysis.saleStatus);
    const cardPaid = ['paid_full', 'paid_partial'].includes(lead.saleStatus);
    if (transcriptPaid && !cardPaid) {
      discrepancies++;
      await raiseDiscrepancyPostIt(lead, leadId, attempt, analysis);
    }
    report.push({
      lead: lead.name,
      leadId,
      callId: attempt.callId,
      outcome: `${prevOutcome} -> ${outcome}`,
      saleStatus: analysis.saleStatus,
      saleAmount: analysis.saleAmount,
      declineType: analysis.declineType,
      summary: analysis.summary,
      contradictsCard: transcriptPaid && !cardPaid,
    });
  }

  if (!changed) continue;
  if (!LIVE) {
    console.log('  DRY: would PATCH contactAttempts');
    continue;
  }
  const url = `${BASE}/leads/${leadId}?updateMask.fieldPaths=contactAttempts&updateMask.fieldPaths=updatedAt`;
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
  if (!res.ok) console.error('  ! PATCH failed', res.status, await res.text());
  else console.log('  ✓ lead patched');
}

console.log('\n================ SUMMARY ================');
console.log({ candidates, attached, noTranscript, discrepancies, live: LIVE });
console.log(JSON.stringify(report, null, 2));
