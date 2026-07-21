// One-time backfill of historical CallRail calls into lead contact logs.
//
// The live sync only looks back 48h and went live 2026-07-20, so every call
// before that is invisible to the app. This script runs the same pipeline
// over history (default: since 2026-06-15):
//   - matches calls to leads by phone (newest lead wins a shared number)
//   - answered calls get GPT-4o-mini transcript analysis (summary, pitch
//     outcome, commitments) exactly like the live sync
//   - logs contact attempts with recording links; real conversations stamp
//     lastConnectedAt so the cadence stops chasing connected leads
//   - historical missed inbound calls are logged as attempts (NOT post-its —
//     the moment has passed; no desk flooding)
//   - writes callrailCalls/{id} markers so the live sync never double-logs
//   - finally clears open "Auto cadence" follow-ups; tomorrow's sweep will
//     reschedule correctly from the backfilled data
//
// Never touches a lead's sales stage.
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const START_DATE = process.argv[2] || '2026-06-15';
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

const last10 = (s) => String(s ?? '').replace(/\D/g, '').slice(-10);
const fmtDur = (sec) => {
  if (!sec) return '';
  const m = Math.floor(sec / 60);
  return m ? `${m}m ${sec % 60}s` : `${sec}s`;
};

// --- Firestore REST helpers --------------------------------------------------
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
  if ('timestampValue' in v) return v.timestampValue;
  if ('arrayValue' in v) return (v.arrayValue.values || []).map(dec);
  if ('mapValue' in v)
    return Object.fromEntries(Object.entries(v.mapValue.fields || {}).map(([k, x]) => [k, dec(x)]));
  return null;
}

// --- LLM analysis (same prompt as the deployed sync) -------------------------
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

// --- 1. Load all leads --------------------------------------------------------
const leadDocs = [];
let pageToken = '';
do {
  const url = `${BASE}/leads?pageSize=300${pageToken ? `&pageToken=${pageToken}` : ''}`;
  const res = await fetch(url, { headers: fsHeaders });
  const json = await res.json();
  (json.documents || []).forEach((d) => leadDocs.push(d));
  pageToken = json.nextPageToken || '';
} while (pageToken);

const leads = leadDocs.map((d) => {
  const f = d.fields || {};
  return {
    id: d.name.split('/').pop(),
    docName: d.name.split('/documents/')[1],
    name: dec(f.name) || '(unnamed)',
    phone: last10(dec(f.phone)),
    altPhone: last10(dec(f.altPhone)),
    deleted: Boolean(dec(f.deletedAt)),
    createdAt: dec(f.createdAt) || 0,
    attempts: dec(f.contactAttempts) || [],
    followUps: dec(f.followUps) || [],
    lastConnectedAt: dec(f.lastConnectedAt) || 0,
  };
});

const byPhone = new Map();
for (const l of [...leads].sort((a, b) => b.createdAt - a.createdAt)) {
  if (l.deleted) continue;
  for (const p of [l.phone, l.altPhone]) {
    if (p && p.length === 10 && !byPhone.has(p)) byPhone.set(p, l);
  }
}
console.log(`leads loaded: ${leads.length} (${byPhone.size} phone numbers indexed)`);

// --- 2. Pull CallRail history -------------------------------------------------
const fields =
  'id,direction,answered,voicemail,duration,customer_phone_number,start_time,recording_player,recording_duration';
const calls = [];
let page = 1;
for (;;) {
  const url =
    `https://api.callrail.com/v3/a/${ACCOUNT}/calls.json` +
    `?start_date=${START_DATE}&per_page=250&page=${page}&fields=${fields}`;
  const res = await fetch(url, { headers: { Authorization: `Token token="${CR_KEY}"` } });
  if (!res.ok) throw new Error(`CallRail ${res.status}: ${await res.text()}`);
  const json = await res.json();
  calls.push(...(json.calls || []));
  if (page >= (json.total_pages || 1)) break;
  page++;
}
calls.sort((a, b) => new Date(a.start_time) - new Date(b.start_time));
console.log(`CallRail calls since ${START_DATE}: ${calls.length}`);

// --- 3. Process matched, unprocessed calls -------------------------------------
async function markerExists(callId) {
  const res = await fetch(`${BASE}/callrailCalls/${callId}`, { headers: fsHeaders });
  return res.ok;
}
async function setMarker(callId, leadId, action) {
  await fetch(`${BASE}/callrailCalls?documentId=${callId}`, {
    method: 'POST',
    headers: fsHeaders,
    body: JSON.stringify({
      fields: {
        processedAt: { integerValue: String(Date.now()) },
        leadId: leadId ? { stringValue: leadId } : { nullValue: null },
        action: { stringValue: action },
        backfilled: { booleanValue: true },
      },
    }),
  });
}

const patchByLead = new Map(); // leadId -> { lead, newAttempts, connectedAt }
let matched = 0;
let skippedProcessed = 0;
let analyzed = 0;

for (const call of calls) {
  const key = last10(call.customer_phone_number);
  const lead = key.length === 10 ? byPhone.get(key) : undefined;
  if (!lead) continue;
  matched++;

  if (lead.attempts.some((a) => a?.callId === call.id)) {
    skippedProcessed++;
    continue;
  }
  if (await markerExists(call.id)) {
    skippedProcessed++;
    continue;
  }

  const startedAt = new Date(call.start_time).getTime() || Date.now();
  const missedInbound = call.direction === 'inbound' && (!call.answered || call.voicemail);
  const entry = patchByLead.get(lead.id) || { lead, newAttempts: [], connectedAt: 0 };

  let outcome;
  let analysis = null;
  let notes;
  const dir = call.direction === 'inbound' ? 'Inbound' : 'Outbound';
  const dur = fmtDur(call.duration);

  if (missedInbound) {
    outcome = 'no_answer';
    notes = `Missed inbound call — they called us${call.voicemail ? ' (left a voicemail)' : ''}. (backfilled)`;
  } else {
    if (call.answered && call.recording_duration) {
      // transcript comes from the single-call endpoint
      try {
        const res = await fetch(
          `https://api.callrail.com/v3/a/${ACCOUNT}/calls/${call.id}.json?fields=id,transcription`,
          { headers: { Authorization: `Token token="${CR_KEY}"` } },
        );
        const detail = res.ok ? await res.json() : null;
        const transcript = detail?.transcription || '';
        if (transcript.length > 40) {
          analysis = await analyze(transcript, call.direction, call.start_time);
          analyzed++;
        }
      } catch (e) {
        console.error(`  ! analysis failed for ${call.id}: ${e.message}`);
      }
    }
    if (analysis && analysis.connection !== 'unclear') {
      outcome =
        analysis.connection === 'conversation'
          ? 'spoke'
          : analysis.connection === 'voicemail'
            ? 'voicemail'
            : 'no_answer';
    } else {
      outcome = call.voicemail ? 'voicemail' : call.answered ? 'spoke' : 'no_answer';
    }
    notes = `${dir} call via CallRail${dur ? ` — ${dur}` : ''}. (backfilled)`;
    if (analysis && analysis.connection === 'wrong_number') {
      notes += ' ⚠ Sounded like a wrong number — verify the phone on file.';
    }
  }

  entry.newAttempts.push({
    ts: startedAt,
    outcome,
    notes,
    by: 'CallRail sync',
    via: 'callrail',
    callId: call.id,
    recordingUrl: call.recording_player || null,
    durationSec: call.duration ?? null,
    ...(analysis ? { ai: analysis } : {}),
  });
  if (outcome === 'spoke') entry.connectedAt = Math.max(entry.connectedAt, startedAt);
  patchByLead.set(lead.id, entry);
  await setMarker(call.id, lead.id, missedInbound ? 'missed_call_backfill' : outcome);
  console.log(
    `  ${lead.name}: ${dir.toLowerCase()} ${outcome} ${new Date(startedAt).toISOString().slice(0, 16)}` +
      (analysis?.summary ? ` — ${analysis.summary.slice(0, 70)}` : ''),
  );
}

// --- 4. Patch leads -------------------------------------------------------------
let leadsUpdated = 0;
for (const { lead, newAttempts, connectedAt } of patchByLead.values()) {
  const all = [...lead.attempts, ...newAttempts].sort((a, b) => (a.ts ?? 0) - (b.ts ?? 0));
  const fieldsPatch = {
    contactAttempts: enc(all),
    updatedAt: { integerValue: String(Date.now()) },
  };
  let mask = 'updateMask.fieldPaths=contactAttempts&updateMask.fieldPaths=updatedAt';
  if (connectedAt > lead.lastConnectedAt) {
    fieldsPatch.lastConnectedAt = { integerValue: String(connectedAt) };
    mask += '&updateMask.fieldPaths=lastConnectedAt';
  }
  const res = await fetch(`${ROOT}/documents/${lead.docName}?${mask}`, {
    method: 'PATCH',
    headers: fsHeaders,
    body: JSON.stringify({ fields: fieldsPatch }),
  });
  if (!res.ok) console.error('PATCH failed', lead.name, res.status, await res.text());
  else leadsUpdated++;
}

// --- 5. Drop stale auto-cadence follow-ups (sweep re-creates them correctly) ----
let followUpsCleared = 0;
for (const l of leads) {
  if (l.deleted) continue;
  const open = l.followUps.filter((f) => !f?.done && String(f?.note || '').startsWith('Auto cadence'));
  if (!open.length) continue;
  const kept = l.followUps.filter((f) => !open.includes(f));
  const res = await fetch(
    `${ROOT}/documents/${l.docName}?updateMask.fieldPaths=followUps&updateMask.fieldPaths=updatedAt`,
    {
      method: 'PATCH',
      headers: fsHeaders,
      body: JSON.stringify({
        fields: { followUps: enc(kept), updatedAt: { integerValue: String(Date.now()) } },
      }),
    },
  );
  if (res.ok) followUpsCleared += open.length;
  else console.error('follow-up clear failed', l.name, res.status);
}

console.log('\n--- backfill complete ---');
console.log('calls matched to leads:   ', matched);
console.log('already processed/skipped:', skippedProcessed);
console.log('attempts logged:          ', [...patchByLead.values()].reduce((s, e) => s + e.newAttempts.length, 0));
console.log('with AI summaries:        ', analyzed);
console.log('leads updated:            ', leadsUpdated);
console.log('stale cadence follow-ups cleared:', followUpsCleared);
