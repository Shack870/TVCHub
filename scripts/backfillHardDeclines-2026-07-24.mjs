// No Sale backfill: route historical hard declines to 'lost' (2026-07-24).
//
// The CallRail classifier now distinguishes HARD declines ("already paid the
// ticket myself", "hired another lawyer", "case already resolved", explicit
// final refusal) from SOFT ones (price objection, wants to think) and routes
// hard declines to No Sale automatically — see functions/src/callrail.ts and
// noSaleRouting.ts. This one-off applies the same read to calls that happened
// BEFORE the classifier learned the distinction (Rashard Anderson told the
// Jul 22 call he'd already paid the citation himself and was still sitting in
// the callback queue).
//
// For every live, unsold, active-board lead: re-run the (new, decline-aware)
// transcript analysis on its NEWEST readable conversation call — that call is
// the lead's current word. A hard decline there moves the lead; an old hard
// decline superseded by a later decline-free conversation moves nothing
// (conservative). Moves mirror noSaleRouting.hardDeclineMove exactly:
// stage 'lost', lostAt = call ts, lostReason from the analysis, pending
// follow-ups closed, audit note on the lead AND appended to the attempt, and
// the attempt's ai map gains declineType/declineReason as evidence.
//
// CONSERVATIVE BY DESIGN: soft/unclear declines and any ambiguity (later
// promise of money, existing-client reads, lostRevivedAt) are reported, never
// moved. Run with DRY=1 first to preview without writing.
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const PROJECT = 'tvchub-f2401';
const BASE = `https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/(default)/documents`;
const DRY = process.env.DRY === '1';

const fsToken = execSync('gcloud auth print-access-token').toString().trim();
const fsHeaders = {
  Authorization: `Bearer ${fsToken}`,
  'x-goog-user-project': PROJECT,
  'Content-Type': 'application/json',
};
const env = readFileSync('.env.local', 'utf8');
const CR_KEY = env.match(/^CALLRAIL_API_KEY=(.+)$/m)?.[1]?.trim();
const OPENAI_KEY = env.match(/^OPENAI_API_KEY=(.+)$/m)?.[1]?.trim();
if (!CR_KEY || !OPENAI_KEY) throw new Error('missing CALLRAIL_API_KEY / OPENAI_API_KEY in .env.local');
const CR_ACCOUNT = 'ACC0abdb2f39b9f45689f56e0e1eaea2ca3';

// --- Firestore value codecs -----------------------------------------------
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
function enc(v) {
  if (v === null || v === undefined) return { nullValue: null };
  if (typeof v === 'boolean') return { booleanValue: v };
  if (typeof v === 'number')
    return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
  if (typeof v === 'string') return { stringValue: v };
  if (Array.isArray(v)) return { arrayValue: { values: v.map(enc) } };
  if (typeof v === 'object') {
    const fields = {};
    for (const [k, x] of Object.entries(v)) if (x !== undefined) fields[k] = enc(x);
    return { mapValue: { fields } };
  }
  throw new Error(`unsupported value: ${typeof v}`);
}
async function patchDoc(docPath, patch) {
  if (DRY) {
    console.log(`    DRY: would patch ${docPath} — ${Object.keys(patch).join(', ')}`);
    return;
  }
  const mask = Object.keys(patch)
    .map((k) => `updateMask.fieldPaths=${encodeURIComponent(k)}`)
    .join('&');
  const fields = {};
  for (const [k, v] of Object.entries(patch)) fields[k] = enc(v);
  const res = await fetch(`${BASE}/${docPath}?${mask}&currentDocument.exists=true`, {
    method: 'PATCH',
    headers: fsHeaders,
    body: JSON.stringify({ fields }),
  });
  if (!res.ok) throw new Error(`PATCH ${docPath} ${res.status}: ${await res.text()}`);
}

// --- The decline-aware classifier (mirrors functions/src/callrail.ts) ------
const ANALYSIS_SYSTEM = `You analyze a phone call transcript between a law firm (Agent) and a traffic-case lead (Caller).
Return ONLY a JSON object:
- "declineType": "hard" ONLY when the caller gave a FINAL, unambiguous no to representation: they already paid/resolved the ticket themselves, already hired another lawyer, the case is already resolved/dismissed, or they explicitly and finally refused ("not interested, stop calling"). A hard decline can appear even without a formal pitch (e.g. the caller opens with "I already paid that ticket myself"). "soft" when the decline could still turn: price objection, wants to think about it, wants to see evidence/paperwork first, needs to check with someone. A price/affordability objection alone is NEVER hard, even when the caller sounds final — it only becomes hard when they also state they are done with the matter (paying/paid the ticket themselves, letting it go, hired someone else). "none" when no decline happened on this call. When in doubt between hard and soft, use "soft".
- "declineReason": for declineType hard/soft — a short factual phrase of why ("already paid the citation himself", "hired another attorney", "thinks the fee is too high"), else null.
- "evidence": a short VERBATIM quote from the transcript supporting the decline classification, else null.
Do not invent facts.`;

async function classify(transcript, direction, startTime, leadName) {
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
          content:
            `Call direction: ${direction}. Call date: ${startTime}. ` +
            `Our records say the caller is likely ${leadName}.\n\nTranscript:\n${transcript.slice(0, 24000)}`,
        },
      ],
    }),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(json.error?.message || `OpenAI ${res.status}`);
  const p = JSON.parse(json.choices?.[0]?.message?.content || '{}');
  return {
    declineType: ['hard', 'soft'].includes(p.declineType) ? p.declineType : 'none',
    declineReason: p.declineReason ? String(p.declineReason) : null,
    evidence: p.evidence ? String(p.evidence) : null,
  };
}

async function fetchTranscript(callId) {
  const res = await fetch(
    `https://api.callrail.com/v3/a/${CR_ACCOUNT}/calls/${callId}.json?fields=id,direction,transcription,start_time`,
    { headers: { Authorization: `Token token="${CR_KEY}"` } },
  );
  if (!res.ok) return null;
  return res.json();
}

// --- Load leads --------------------------------------------------------------
const AUTO_ROUTE_FROM = ['new', 'callback', 'pitched', 'attorney_call', 'nurture'];
const CT = { timeZone: 'America/Chicago' };
const fmtCT = (ts) => new Date(ts).toLocaleString('en-US', { ...CT, timeZoneName: 'short' });

const leadDocs = [];
let pageToken = '';
do {
  const url = `${BASE}/leads?pageSize=300${pageToken ? `&pageToken=${pageToken}` : ''}`;
  const res = await fetch(url, { headers: fsHeaders });
  const json = await res.json();
  (json.documents || []).forEach((d) =>
    leadDocs.push({
      id: d.name.split('/').pop(),
      d: Object.fromEntries(Object.entries(d.fields || {}).map(([k, v]) => [k, dec(v)])),
    }),
  );
  pageToken = json.nextPageToken || '';
} while (pageToken);

const candidates = leadDocs.filter(({ d }) => {
  if (d.deletedAt) return false;
  if (!AUTO_ROUTE_FROM.includes(d.stage)) return false;
  if (typeof d.saleStatus === 'string' && d.saleStatus.startsWith('paid')) return false; // sold
  if (d.lostRevivedAt) return false; // human pulled it out of lost once — final
  // Possible-existing-client flag (the Parmjeet Singh case): retention may
  // have happened outside the app's view — "we don't want to continue" from
  // an actual client is a service problem, not a sales decline. Mirrors the
  // guard in functions/src/noSaleRouting.ts; a human resolves the flag first.
  if (d.possibleExistingClientAt) return false;
  return (Array.isArray(d.contactAttempts) ? d.contactAttempts : []).some(
    (a) => a?.via === 'callrail' && a.callId && a.ai && a.ai.connection === 'conversation',
  );
});
console.log(
  `Leads loaded: ${leadDocs.length}; unsold active-board leads with conversation calls: ${candidates.length}`,
);

const moved = [];
const ambiguous = [];
let clean = 0;

for (const { id, d } of candidates) {
  const attempts = d.contactAttempts;
  // Conversation calls, NEWEST first — the latest word decides.
  const convo = attempts
    .map((a, idx) => ({ a, idx }))
    .filter(({ a }) => a?.via === 'callrail' && a.callId && a.ai && a.ai.connection === 'conversation')
    .sort((x, y) => (y.a.ts ?? 0) - (x.a.ts ?? 0));
  // The NEWEST readable conversation is the lead's current word: if it has
  // no decline, an older hard decline was superseded by a later conversation
  // and nothing moves (conservative). Unreadable calls fall through to the
  // next older one.
  let latest = null;
  let verdict = null;
  for (const c of convo) {
    const call = await fetchTranscript(c.a.callId);
    if (!call?.transcription || call.transcription.length <= 40) continue;
    const v = await classify(call.transcription, call.direction, call.start_time, d.name);
    if (v.declineType !== 'none') {
      latest = c;
      verdict = v;
    }
    break; // only the newest readable conversation decides
  }
  if (!verdict) {
    clean++;
    continue;
  }
  if (verdict.declineType !== 'hard') {
    ambiguous.push({
      id,
      name: d.name,
      stage: d.stage,
      callTs: latest.a.ts,
      why: `SOFT decline on latest conversation — ${verdict.declineReason ?? '(no reason)'}${
        verdict.evidence ? ` · "${verdict.evidence}"` : ''
      } — stays on the board`,
    });
    continue;
  }
  // Belt and braces on the classifier: a "hard" verdict whose stated reason
  // is a PRICE objection is soft by policy unless the caller also said they
  // are done with the matter (paying/paid it themselves, letting it go,
  // hired someone else). Demote to report-only.
  const priceReason = /fee|price|cost|afford|expensive|too (high|much)|cheaper|money/i.test(
    verdict.declineReason ?? '',
  );
  const finality =
    /already paid|paid (it|the|them|myself)|pay (it|the \S+|myself)|let it go|letting it go|hired|another (lawyer|attorney)|resolved|dismissed|not interested|stop calling|no longer|don'?t want/i.test(
      `${verdict.declineReason ?? ''} ${verdict.evidence ?? ''}`,
    );
  if (priceReason && !finality) {
    ambiguous.push({
      id,
      name: d.name,
      stage: d.stage,
      callTs: latest.a.ts,
      why: `classifier said HARD but the reason is a price objection with no finality — soft by policy: ${
        verdict.declineReason ?? '(no reason)'
      }${verdict.evidence ? ` · "${verdict.evidence}"` : ''} — stays on the board`,
    });
    continue;
  }
  // Hard decline on the LATEST conversation. One more conservative check: a
  // still-open promise of money (promised_unpaid set by a NEWER event than
  // this call) means a human should reconcile the contradiction instead.
  if (d.saleStatus === 'promised_unpaid' && (d.saleStatusAt ?? 0) > (latest.a.ts ?? 0)) {
    ambiguous.push({
      id,
      name: d.name,
      stage: d.stage,
      callTs: latest.a.ts,
      why: `hard decline (${verdict.declineReason}) but a NEWER promised_unpaid stamp exists — human call`,
    });
    continue;
  }

  const callTs = latest.a.ts ?? Date.now();
  const now = Date.now();
  const reason = verdict.declineReason || 'Hard decline on call';
  const day = new Date(callTs).toLocaleDateString('en-US', { month: 'short', day: 'numeric', ...CT });
  const note = `Stage moved to No Sale by classifier — hard decline on ${day} call (${reason})`;

  // Mirror noSaleRouting.hardDeclineMove: attempt note + ai evidence,
  // pending follow-ups closed, lost stamps from the CALL's date.
  const newAttempts = attempts.map((a, idx) => {
    if (idx !== latest.idx) return a;
    return {
      ...a,
      notes: `${a.notes ?? ''} → ${note}.`.trim(),
      ai: { ...a.ai, declineType: 'hard', declineReason: reason },
    };
  });
  // Court reminders (week_before/day_before) survive the move — they're the
  // No Sale resurrection path, and closing them would arm the cadence's
  // proximity dedupe against re-adds. Mirrors noSaleRouting.hardDeclineMove.
  const SURVIVES_LOST = ['week_before', 'day_before'];
  const patch = {
    stage: 'lost',
    lostAt: callTs,
    lostReason: reason,
    autoStageNote: note,
    autoStageAt: now,
    contactAttempts: newAttempts,
    followUps: (Array.isArray(d.followUps) ? d.followUps : []).map((f) =>
      f && !f.done && !SURVIVES_LOST.includes(f.type) ? { ...f, done: true, doneAt: now } : f,
    ),
    updatedAt: now,
  };
  const openFollowUps = (Array.isArray(d.followUps) ? d.followUps : []).filter(
    (f) => f && !f.done && !SURVIVES_LOST.includes(f.type),
  );
  console.log(`\nMOVE ${d.name} (${id}) ${d.stage} → lost`);
  console.log(`  call ${fmtCT(callTs)} — ${reason}`);
  if (verdict.evidence) console.log(`  transcript: "${verdict.evidence}"`);
  console.log(`  closing ${openFollowUps.length} pending follow-up(s)`);
  await patchDoc(`leads/${id}`, patch);
  moved.push({
    id,
    name: d.name,
    from: d.stage,
    callTs,
    reason,
    evidence: verdict.evidence,
    closedFollowUps: openFollowUps.length,
  });
}

// --- Report ----------------------------------------------------------------
console.log('\n================= MOVED TO NO SALE =================');
for (const m of moved) {
  console.log(`\n${m.name} (${m.id}) — was ${m.from}`);
  console.log(`  hard decline on ${fmtCT(m.callTs)}: ${m.reason}`);
  if (m.evidence) console.log(`  evidence: "${m.evidence}"`);
  console.log(`  ${m.closedFollowUps} pending follow-up(s) closed`);
}
console.log('\n================= AMBIGUOUS (reported only, NOT moved) =================');
for (const a of ambiguous) {
  console.log(`\n${a.name} (${a.id}) — ${a.stage}, latest conversation ${fmtCT(a.callTs)}`);
  console.log(`  ${a.why}`);
}
console.log(
  `\nTotals: ${moved.length} moved to lost, ${ambiguous.length} ambiguous/soft (left alone), ${clean} clean (no decline).`,
);
console.log(DRY ? '\n(DRY RUN — nothing written)' : '\nDone.');
