// One-time TVC-thread backfill (2026-06-01 → now), dry-run by default.
//
// Runs the EXACT logic the deployed tvcThreadSync uses — the classification,
// case-number extraction, and per-lead write plans are imported from the
// compiled functions module (functions/lib/tvcThreadRules.js), so this script
// and the scheduled function cannot drift. Only the plumbing differs: this
// uses the Firestore REST API with a gcloud user token (the repo's script
// convention) instead of firebase-admin, and appends timeline entries with an
// arrayUnion transform so a concurrent sync can't clobber them.
//
// The manual audit + QA fixes ALREADY handled the known leads in this window
// — the plans in tvcThreadRules recognize state that already matches and
// write only markers + missing timeline entries. EXEMPT lists message ids a
// human has explicitly resolved (marker only, nothing else touched).
//
// Usage:
//   node scripts/tvcThreadBackfill-2026-07-24.mjs           # dry run (prints plan)
//   node scripts/tvcThreadBackfill-2026-07-24.mjs --live    # writes
import { execSync } from 'node:child_process';
import { delegatedGmailToken } from '../functions/lib/gmailAuth.js';
import {
  buildNameIndex,
  classifyReply,
  extractBareCaseNumbers,
  extractCaseNumbers,
  findNamedLeads,
  payloadText,
  planLeadWrites,
  stripQuotedHistory,
  excerptOf,
} from '../functions/lib/tvcThreadRules.js';

const LIVE = process.argv.includes('--live');
const PROJECT = 'tvchub-f2401';
const ROOT = `https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/(default)`;
const DOCS = `${ROOT}/documents`;
const DOCPATH = `projects/${PROJECT}/databases/(default)/documents`;
const GMAIL = 'https://gmail.googleapis.com/gmail/v1/users/me';
const MAILBOX = 'office@ironrocklaw.com';
const TVC_DOMAIN = 'prodriver.com';
const BACKFILL_START = new Date('2026-06-01T00:00:00-05:00').getTime();

// Message ids a human has already resolved end-to-end: marker only, no
// timeline entry, no patch, no post-it. (Identified in the dry run.)
const EXEMPT = new Map([
  // Parmjeet Singh's Jul 17 "retained our services" — the Jul 17–22 QA
  // untangled him by hand (the Dessie/Parmjeet payment ambiguity) and a human
  // DELIBERATELY cleared his possible-existing-client flag afterwards;
  // re-stamping it from this old message would undo that human decision.
  ['19f720ff3a1d08c4', 'Parmjeet Jul 17 retained — human already resolved, flag deliberately cleared'],
  // The Jul 21 retraction ("mixed two of them up... but Parmjeet...") inside
  // DESSIE's thread — the same QA already untangled both cards by hand.
  ['19f8563abd7d01e5', 'Jul 21 retraction in Dessie thread — QA already untangled both leads'],
]);

const fsToken = execSync('gcloud auth print-access-token').toString().trim();
const fsHeaders = {
  Authorization: `Bearer ${fsToken}`,
  'x-goog-user-project': PROJECT,
  'Content-Type': 'application/json',
};

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
const decDoc = (d) =>
  Object.fromEntries(Object.entries(d.fields || {}).map(([k, v]) => [k, dec(v)]));

async function fsGet(path) {
  const res = await fetch(`${DOCS}/${path}`, { headers: fsHeaders });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`GET ${path} ${res.status}: ${await res.text()}`);
  return res.json();
}

async function fsPatch(path, fields, mask) {
  const url = `${DOCS}/${path}?${mask.map((f) => `updateMask.fieldPaths=${encodeURIComponent(f)}`).join('&')}`;
  const res = await fetch(url, { method: 'PATCH', headers: fsHeaders, body: JSON.stringify({ fields }) });
  if (!res.ok) throw new Error(`PATCH ${path} ${res.status}: ${await res.text()}`);
}

async function fsAdd(collection, obj) {
  const res = await fetch(`${DOCS}/${collection}`, {
    method: 'POST',
    headers: fsHeaders,
    body: JSON.stringify({ fields: Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, enc(v)])) }),
  });
  if (!res.ok) throw new Error(`POST ${collection} ${res.status}: ${await res.text()}`);
}

// Lead update: patch fields via updateMask, timeline entry via arrayUnion
// transform (append-only — safe against a concurrent sync's read-modify-write).
async function fsUpdateLead(leadId, patch, attempt) {
  const write = {
    update: {
      name: `${DOCPATH}/leads/${leadId}`,
      fields: Object.fromEntries(Object.entries(patch).map(([k, v]) => [k, enc(v)])),
    },
    updateMask: { fieldPaths: Object.keys(patch) },
  };
  if (attempt) {
    write.updateTransforms = [
      { fieldPath: 'contactAttempts', appendMissingElements: { values: [enc(attempt)] } },
    ];
  }
  const res = await fetch(`${ROOT}/documents:commit`, {
    method: 'POST',
    headers: fsHeaders,
    body: JSON.stringify({ writes: [write] }),
  });
  if (!res.ok) throw new Error(`commit leads/${leadId} ${res.status}: ${await res.text()}`);
}

async function postItExists(leadId, subject) {
  const leadFilter = leadId
    ? { fieldFilter: { field: { fieldPath: 'leadId' }, op: 'EQUAL', value: { stringValue: leadId } } }
    : { unaryFilter: { field: { fieldPath: 'leadId' }, op: 'IS_NULL' } };
  const res = await fetch(`${ROOT}/documents:runQuery`, {
    method: 'POST',
    headers: fsHeaders,
    body: JSON.stringify({
      structuredQuery: {
        from: [{ collectionId: 'messages' }],
        where: {
          compositeFilter: {
            op: 'AND',
            filters: [
              leadFilter,
              { fieldFilter: { field: { fieldPath: 'subject' }, op: 'EQUAL', value: { stringValue: subject } } },
            ],
          },
        },
        limit: 1,
      },
    }),
  });
  if (!res.ok) throw new Error(`runQuery messages ${res.status}: ${await res.text()}`);
  const rows = await res.json();
  return rows.some((r) => r.document);
}

const day = (ts) =>
  new Date(ts).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: 'America/Chicago' });

// --- Gmail ------------------------------------------------------------------
const saKey = execSync(
  `gcloud secrets versions access latest --secret=GMAIL_SA_KEY --project=${PROJECT}`,
).toString();
const gmailToken = await delegatedGmailToken(saKey, MAILBOX);
const gm = { Authorization: `Bearer ${gmailToken}` };

async function listMessages(q) {
  const ids = [];
  let pageToken = '';
  do {
    const url = `${GMAIL}/messages?q=${encodeURIComponent(q)}&maxResults=100${pageToken ? `&pageToken=${pageToken}` : ''}`;
    const res = await fetch(url, { headers: gm });
    if (!res.ok) throw new Error(`Gmail list ${res.status}: ${await res.text()}`);
    const json = await res.json();
    ids.push(...(json.messages ?? []).map((m) => m.id));
    pageToken = json.nextPageToken ?? '';
  } while (pageToken);
  return ids;
}

async function getFull(id) {
  const res = await fetch(`${GMAIL}/messages/${id}?format=full`, { headers: gm });
  if (!res.ok) throw new Error(`Gmail get ${res.status}: ${await res.text()}`);
  return res.json();
}

const headerOf = (m, name) =>
  m.payload?.headers?.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? '';
const addressesIn = (h) => (h.match(/[\w.+-]+@[\w-]+\.[\w.-]+/g) ?? []).map((a) => a.toLowerCase());

// --- Load leads (whole collection, full docs — plans need attempts/followUps)
console.log(`${LIVE ? 'LIVE' : 'DRY RUN'} — loading leads…`);
const leadDocs = [];
{
  let pageToken = '';
  do {
    const url = `${DOCS}/leads?pageSize=300${pageToken ? `&pageToken=${pageToken}` : ''}`;
    const res = await fetch(url, { headers: fsHeaders });
    const json = await res.json();
    (json.documents || []).forEach((d) => leadDocs.push(d));
    pageToken = json.nextPageToken || '';
  } while (pageToken);
}
const leads = leadDocs.map((d) => ({ id: d.name.split('/').pop(), data: decDoc(d) }));
const byCase = new Map();
for (const l of leads) {
  const caseNo = String(l.data.tvcCaseNumber ?? '').trim();
  if (/^\d{7}$/.test(caseNo)) byCase.set(caseNo, [...(byCase.get(caseNo) ?? []), l]);
}
const nameIndex = buildNameIndex(
  leads.filter((l) => !l.data.deletedAt).map((l) => ({ id: l.id, name: l.data.name || '' })),
);
console.log(`${leads.length} leads, ${byCase.size} distinct case numbers`);

// --- Cursor: mirror the function (first run = backfill window) ---------------
const state = await fsGet('syncState/tvcThreadSync');
const lastSyncAt = state ? dec(state.fields?.lastSyncAt) : null;
const after = Math.floor((lastSyncAt ? lastSyncAt - 6 * 3600_000 : BACKFILL_START) / 1000);
const q = `(to:${TVC_DOMAIN} OR cc:${TVC_DOMAIN}) -in:draft after:${after}`;
console.log(`Gmail query: ${q}`);
const ids = await listMessages(q);
console.log(`${ids.length} messages listed`);

// Fetch full bodies (skipping existing markers), oldest first.
const pending = [];
for (const id of ids) {
  if (await fsGet(`tvcThreadMessages/${id}`)) continue;
  pending.push(await getFull(id));
}
pending.sort((a, b) => Number(a.internalDate) - Number(b.internalDate));
console.log(`${pending.length} without markers\n`);

const counts = {};
const bump = (k) => (counts[k] = (counts[k] ?? 0) + 1);
const perLead = new Map(); // name -> {attempts, actions:[]}

for (const meta of pending) {
  const id = meta.id;
  const ts = Number(meta.internalDate) || Date.now();
  const subject = headerOf(meta, 'Subject');
  const from = addressesIn(headerOf(meta, 'From'));
  const rcpts = addressesIn(`${headerOf(meta, 'To')},${headerOf(meta, 'Cc')}`);
  const fromFirm = from.some((a) => a.endsWith('@ironrocklaw.com') || a === 'ironrocklaw@gmail.com');
  const toTvc = rcpts.some((a) => a.endsWith(`@${TVC_DOMAIN}`));

  const writeMarker = async (extra) => {
    if (!LIVE) return;
    await fsPatch(
      `tvcThreadMessages/${id}`,
      Object.fromEntries(Object.entries({ processedAt: Date.now(), ts, subject, ...extra }).map(([k, v]) => [k, enc(v)])),
      Object.keys({ processedAt: 1, ts: 1, subject: 1, ...extra }),
    );
  };

  if (EXEMPT.has(id)) {
    console.log(`[${day(ts)}] EXEMPT (${EXEMPT.get(id)}) — "${subject}"`);
    await writeMarker({ leadId: null, action: `handled_by_manual_audit`, exemptReason: EXEMPT.get(id) });
    bump('exempt');
    continue;
  }

  if (!fromFirm || !toTvc) {
    await writeMarker({ leadId: null, action: 'ignored_not_office_reply' });
    bump('ignored_not_office_reply');
    continue;
  }

  const fullText = payloadText(meta.payload);
  const replyText = stripQuotedHistory(fullText);
  const classification = classifyReply(replyText);
  const casesIn = (text) => {
    const anchoredHits = extractCaseNumbers(text);
    if (anchoredHits.length) return anchoredHits;
    return extractBareCaseNumbers(text).filter((c) => byCase.has(c));
  };
  const subjectCases = casesIn(subject);
  const replyCases = casesIn(replyText);
  const allCases = casesIn(`${subject}\n${fullText}`);
  const candidates = subjectCases.length ? subjectCases : replyCases.length ? replyCases : allCases;
  const anchored = ['declined', 'retained', 'correction', 'not_viable'].includes(classification.kind);
  const base = { caseNumbers: candidates, classification: classification.kind, anchor: classification.anchor };

  const emitPostIt = async (leadId, pSubject, pMessage, extra = {}) => {
    const dup = await postItExists(leadId, pSubject);
    if (dup) {
      console.log(`    post-it SKIPPED (dupe): ${pSubject}`);
      return;
    }
    console.log(`    post-it: ${pSubject}`);
    bump('postIts');
    if (!LIVE) return;
    await fsAdd('messages', {
      kind: 'tvc_message',
      source: 'system',
      from: 'TVC Thread Sync',
      fromName: 'TVC Thread Sync',
      subject: pSubject,
      message: pMessage,
      tvcCaseNumber: extra.caseNumber ?? null,
      memberName: extra.memberName ?? null,
      leadId,
      phone: extra.phone ?? null,
      email: extra.email ?? null,
      gmailMessageId: id,
      receivedAt: ts,
      handled: false,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
  };

  if (candidates.length === 0) {
    if (anchored) {
      console.log(`[${day(ts)}] ${classification.kind.toUpperCase()} but NO case number (marker only) — "${subject}"`);
      console.log(`    reply: ${excerptOf(replyText, 160)}`);
    }
    await writeMarker({ ...base, leadId: null, action: 'no_case_number' });
    bump('no_case_number');
    continue;
  }

  if (candidates.length > 1) {
    console.log(`[${day(ts)}] MULTI-CASE ${candidates.join(',')} (${classification.kind}) — "${subject}"`);
    await emitPostIt(
      null,
      `TVC thread names several cases — ${candidates.join(', ')}`,
      `A firm reply to TVC references several case numbers (${candidates.join(', ')}) with no clear primary — no automatic action.\nClassifier read: ${classification.kind}${classification.anchor ? ` ("${classification.anchor}")` : ''}.\nSubject: "${subject}"\nThe reply: "${excerptOf(replyText)}"`,
    );
    await writeMarker({ ...base, leadId: null, action: 'multi_case_review' });
    bump('multi_case_review');
    continue;
  }

  const caseNo = candidates[0];
  const sharing = byCase.get(caseNo) ?? [];
  const live = sharing.filter((l) => !l.data.deletedAt);

  if (live.length === 0) {
    const action = sharing.length ? 'lead_deleted' : 'case_no_lead';
    if (anchored) {
      console.log(`[${day(ts)}] ${classification.kind.toUpperCase()} case ${caseNo} — ${action} (marker only) — "${excerptOf(subject, 60)}"`);
    }
    await writeMarker({ ...base, leadId: null, action });
    bump(action);
    continue;
  }

  if (live.length > 1) {
    const names = live.map((l) => l.data.name).join(', ');
    console.log(`[${day(ts)}] DUPLICATE PAIR case ${caseNo}: ${names} — "${subject}"`);
    await emitPostIt(
      null,
      `Duplicate leads share TVC case ${caseNo}`,
      `A firm reply to TVC concerns case ${caseNo}, but ${live.length} non-deleted leads share that case number (${names}) — no automatic action.\nClassifier read: ${classification.kind}${classification.anchor ? ` ("${classification.anchor}")` : ''}.\nSubject: "${subject}"\nThe reply: "${excerptOf(replyText)}"\nMerge/clean up the duplicates, then settle the disposition by hand.`,
      { caseNumber: caseNo, memberName: names },
    );
    await writeMarker({ ...base, leadId: null, action: 'duplicate_leads_review' });
    bump('duplicate_leads_review');
    continue;
  }

  const lead = live[0];
  const otherNames = new Set();
  for (const c of replyCases) {
    if (c === caseNo) continue;
    const others = (byCase.get(c) ?? []).filter((l) => !l.data.deletedAt);
    for (const o of others) if (o.id !== lead.id) otherNames.add(`${o.data.name} (case ${c})`);
    if (!others.length) otherNames.add(`case ${c}`);
  }
  for (const [, named] of findNamedLeads(replyText, nameIndex)) {
    if (named.id !== lead.id) otherNames.add(named.name);
  }

  const plan = planLeadWrites(lead.data, {
    gmailMessageId: id,
    ts,
    subject,
    replyText,
    caseNumber: caseNo,
    classification,
    otherLeadNames: [...otherNames],
  });

  const summary = perLead.get(lead.data.name) ?? { attempts: 0, actions: [] };
  if (plan.attempt) summary.attempts++;
  summary.actions.push(plan.action);
  perLead.set(lead.data.name, summary);

  const interesting = plan.patch || plan.postIt || classification.kind !== 'none';
  if (interesting) {
    console.log(
      `[${day(ts)}] ${classification.kind.toUpperCase()} → ${lead.data.name} (case ${caseNo}, stage ${lead.data.stage}${lead.data.needsReview ? ', needsReview' : ''}${lead.data.possibleExistingClientAt ? ', pecFlag' : ''}) — action ${plan.action}`,
    );
    console.log(`    subject: "${subject}"`);
    console.log(`    reply: ${excerptOf(replyText, 160)}`);
    if (plan.patch) console.log(`    patch: ${JSON.stringify(Object.keys(plan.patch))}`);
    if (plan.attempt) console.log(`    attempt: ${plan.attempt.outcome} — ${excerptOf(plan.attempt.notes, 120)}`);
  } else {
    console.log(`[${day(ts)}] ${plan.action} → ${lead.data.name} — "${excerptOf(subject, 70)}"`);
  }
  bump(plan.action);
  if (plan.attempt) bump('attempts');

  if (LIVE && (plan.patch || plan.attempt)) {
    const patch = { ...(plan.patch ?? {}), updatedAt: Date.now() };
    await fsUpdateLead(lead.id, patch, plan.attempt);
    // Keep the in-memory copy current so later messages in the same thread
    // plan against the updated state (e.g. a second decline after the route).
    Object.assign(lead.data, plan.patch ?? {});
    if (plan.attempt) lead.data.contactAttempts = [...(lead.data.contactAttempts ?? []), plan.attempt];
  } else if (!LIVE) {
    Object.assign(lead.data, plan.patch ?? {});
    if (plan.attempt) lead.data.contactAttempts = [...(lead.data.contactAttempts ?? []), plan.attempt];
  }

  if (plan.postIt) {
    await emitPostIt(lead.id, plan.postIt.subject, plan.postIt.message, {
      caseNumber: caseNo,
      memberName: lead.data.name,
      phone: lead.data.phone ?? null,
      email: lead.data.email ?? null,
    });
  }

  await writeMarker({ ...base, leadId: lead.id, action: plan.action });
}

if (LIVE) {
  await fsPatch('syncState/tvcThreadSync', { lastSyncAt: enc(Date.now()) }, ['lastSyncAt']);
  console.log('\ncursor stamped: syncState/tvcThreadSync.lastSyncAt');
}

console.log(`\n=== ${LIVE ? 'LIVE' : 'DRY RUN'} SUMMARY ===`);
console.log(JSON.stringify(counts, null, 2));
console.log('\nPer-lead:');
for (const [name, s] of [...perLead.entries()].sort()) {
  console.log(`  ${name}: ${s.attempts} timeline entr${s.attempts === 1 ? 'y' : 'ies'} — ${s.actions.join(', ')}`);
}
