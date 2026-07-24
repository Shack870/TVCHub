// Extend Square visibility + re-evaluate stale payment markers (2026-07-24 QA).
//
// Two passes, both using the CURRENT matcher from functions/src/squaresync.ts
// (phone → email → note-name → exact-name; the concurrent-call matcher is
// deliberately skipped — pre-app/pre-window payments have no CallRail attempts
// to correlate against):
//
//   A. PRE-WINDOW BACKFILL — pulls COMPLETED Square payments from 2026-01-01
//      to the sync's current visibility start (syncState/squareSync
//      .backfillStartAt, ~May 23) and matches them against ALL non-deleted
//      leads. Matches are reconciled exactly the way syncSquare would
//      (attempt + squarePaidTotal + saleStatus/stage + billing escalations
//      stood down); non-matches get 'ignored_unrelated' markers so future
//      passes skip them.
//
//   B. MARKER RE-EVALUATION — every existing squarePayments marker with
//      action 'unmatched' or 'ignored_unrelated' (written by the
//      pre-note-matcher sync and frozen ever since) gets re-run under the
//      current matcher. Still-unmatched markers are stamped with
//      matcherVersion 2 so the versioned sync doesn't redo the work.
//
// The ambiguous Dessie/"Parmjeet Singh" charge (pi7shqJ6…) is excluded by
// payment id and its marker stamped reEvalExempt so the sync's own
// re-evaluation pass never auto-credits it either.
//
// Finishes by moving syncState/squareSync.backfillStartAt to 2026-01-01 so the
// transcript-vs-Square verification pass can reason about the whole year.
//
// Safety heuristics on top of the ported matcher (both with precedent in
// reconcileNoteMatchedPayments-2026-07-22.mjs): a note carrying an explicit
// remaining balance ("Balance=$563.00") or the word "half" always means
// paid_partial, whatever the lead's recorded fee says.
//
// Run with DRY=1 first to preview without writing.
import { execSync } from 'node:child_process';

const PROJECT = 'tvchub-f2401';
const BASE = `https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/(default)/documents`;
const DRY = process.env.DRY === '1';
const MATCHER_VERSION = 2; // keep in sync with functions/src/squaresync.ts
const BACKFILL_FROM = '2026-01-01T00:00:00Z';
const AMBIGUOUS_PAYMENT = 'pi7shqJ6XFOIoa0etXktOYp26FJZY';

const fsToken = execSync('gcloud auth print-access-token').toString().trim();
const sqToken = execSync(
  `gcloud secrets versions access latest --secret=SQUARE_ACCESS_TOKEN --project=${PROJECT}`,
).toString().trim();
const fsHeaders = {
  Authorization: `Bearer ${fsToken}`,
  'x-goog-user-project': PROJECT,
  'Content-Type': 'application/json',
};
const sqHeaders = {
  Authorization: `Bearer ${sqToken}`,
  'Square-Version': '2026-06-18',
  'Content-Type': 'application/json',
};

// --- Firestore value codecs ---------------------------------------------------
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
async function patchDoc(docPath, patch, { mustExist = true } = {}) {
  if (DRY) {
    console.log(`    DRY: would patch ${docPath} — ${Object.keys(patch).join(', ')}`);
    return;
  }
  const mask = Object.keys(patch)
    .map((k) => `updateMask.fieldPaths=${encodeURIComponent(k)}`)
    .join('&');
  const fields = {};
  for (const [k, v] of Object.entries(patch)) fields[k] = enc(v);
  const pre = mustExist ? '&currentDocument.exists=true' : '';
  const res = await fetch(`${BASE}/${docPath}?${mask}${pre}`, {
    method: 'PATCH',
    headers: fsHeaders,
    body: JSON.stringify({ fields }),
  });
  if (!res.ok) throw new Error(`PATCH ${docPath} ${res.status}: ${await res.text()}`);
}
async function runQuery(structuredQuery) {
  const res = await fetch(`${BASE}:runQuery`, {
    method: 'POST',
    headers: fsHeaders,
    body: JSON.stringify({ structuredQuery }),
  });
  if (!res.ok) throw new Error(`runQuery ${res.status}: ${await res.text()}`);
  return (await res.json()).filter((r) => r.document);
}

const CT = { timeZone: 'America/Chicago' };
const fmtCT = (ts) => new Date(ts).toLocaleString('en-US', { ...CT, timeZoneName: 'short' });
const fmtDollars = (cents) => `$${(cents / 100).toFixed(2)}`;

// --- Matcher primitives (ported from functions/src/squaresync.ts) --------------
const last10 = (s) => String(s ?? '').replace(/\D/g, '').slice(-10);
const lc = (s) => String(s ?? '').toLowerCase().trim();
const normalizeText = (s) => lc(s).replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();

// --- Square fetch ---------------------------------------------------------------
async function fetchPayments(beginTime, endTime) {
  const payments = [];
  let cursor = '';
  do {
    const url =
      'https://connect.squareup.com/v2/payments?location_id=LPK9GY4PHM28J' +
      `&begin_time=${encodeURIComponent(beginTime)}` +
      (endTime ? `&end_time=${encodeURIComponent(endTime)}` : '') +
      '&sort_order=ASC&limit=100' +
      (cursor ? `&cursor=${encodeURIComponent(cursor)}` : '');
    const res = await fetch(url, { headers: sqHeaders });
    if (!res.ok) throw new Error(`Square payments ${res.status}: ${await res.text()}`);
    const json = await res.json();
    payments.push(...(json.payments || []));
    cursor = json.cursor || '';
  } while (cursor);
  return payments;
}
const customerCache = new Map();
async function fetchCustomer(id) {
  if (!customerCache.has(id)) {
    const res = await fetch(`https://connect.squareup.com/v2/customers/${id}`, { headers: sqHeaders });
    customerCache.set(id, res.ok ? (await res.json()).customer ?? null : null);
  }
  return customerCache.get(id);
}
const cardOf = (p) => {
  const c = p.card_details?.card;
  return c ? `${c.card_brand ?? 'CARD'} •${c.last_4 ?? '????'}` : 'card unknown';
};

// --- Load ALL leads and build the sync's indexes --------------------------------
const leadDocs = [];
let pageToken = '';
do {
  const url = `${BASE}/leads?pageSize=300${pageToken ? `&pageToken=${pageToken}` : ''}`;
  const res = await fetch(url, { headers: fsHeaders });
  const json = await res.json();
  (json.documents || []).forEach((d) =>
    leadDocs.push({ id: d.name.split('/').pop(), f: d.fields || {} }),
  );
  pageToken = json.nextPageToken || '';
} while (pageToken);
const liveLeads = leadDocs
  .map((l) => ({ id: l.id, d: Object.fromEntries(Object.entries(l.f).map(([k, v]) => [k, dec(v)])) }))
  .filter((l) => !l.d.deletedAt);
console.log(`Leads loaded: ${leadDocs.length} (${liveLeads.length} live)`);

const byPhone = new Map();
const byEmail = new Map();
const byName = new Map();
const noteNameIndex = [];
// Newest lead wins a shared phone/email — leads come newest-first from the
// REST list? They don't (list order is by doc id), so sort by createdAt desc
// first, mirroring the sync's orderBy.
liveLeads.sort((a, b) => (b.d.createdAt ?? 0) - (a.d.createdAt ?? 0));
for (const { id, d } of liveLeads) {
  const lead = { id, name: d.name };
  for (const p of [d.phone, d.altPhone]) {
    const key = last10(p);
    if (key.length === 10 && !byPhone.has(key)) byPhone.set(key, lead);
  }
  const email = lc(d.email);
  if (email && !byEmail.has(email)) byEmail.set(email, lead);
  const name = lc(d.name);
  if (name) byName.set(name, [...(byName.get(name) ?? []), lead]);
  const normName = normalizeText(d.name);
  if (normName.length >= 6) {
    const parts = normName.split(' ');
    const needles = new Set([parts.join(' ')]);
    if (parts.length >= 2) {
      needles.add([...parts].reverse().join(' '));
      needles.add(`${parts[0]} ${parts[parts.length - 1]}`);
      needles.add(`${parts[parts.length - 1]} ${parts[0]}`);
    }
    const usable = [...needles].filter((n) => n.length >= 6);
    if (usable.length) noteNameIndex.push({ needles: usable, lead });
  }
}
const leadById = new Map(liveLeads.map((l) => [l.id, l]));

// The matcher, minus concurrent-call. Returns { lead, matchedBy } or null.
async function matchPayment(payment) {
  let payerName = null;
  let payerEmail = null;
  let payerPhone = null;
  if (payment.customer_id) {
    const c = await fetchCustomer(payment.customer_id);
    if (c) {
      payerName = [c.given_name, c.family_name].filter(Boolean).join(' ').trim() || null;
      payerEmail = c.email_address || null;
      payerPhone = c.phone_number || null;
    }
  }
  if (!payerEmail && payment.buyer_email_address) payerEmail = payment.buyer_email_address;
  const noteText = (payment.note ?? '').trim() || null;

  const phoneKey = last10(payerPhone);
  if (phoneKey.length === 10 && byPhone.has(phoneKey))
    return { lead: byPhone.get(phoneKey), matchedBy: 'phone', payerName, payerEmail, payerPhone };
  if (payerEmail && byEmail.has(lc(payerEmail)))
    return { lead: byEmail.get(lc(payerEmail)), matchedBy: 'email', payerName, payerEmail, payerPhone };
  if (noteText) {
    const hay = ` ${normalizeText(noteText)} `;
    const hits = new Map();
    for (const entry of noteNameIndex) {
      if (entry.needles.some((n) => hay.includes(` ${n} `))) hits.set(entry.lead.id, entry.lead);
    }
    if (hits.size === 1)
      return { lead: [...hits.values()][0], matchedBy: 'note', payerName, payerEmail, payerPhone };
    if (hits.size > 1) return { ambiguous: [...hits.values()], payerName, payerEmail, payerPhone };
  }
  for (const candidate of [payerName, noteText]) {
    const key = lc(candidate);
    if (!key) continue;
    const hits = byName.get(key);
    if (hits && hits.length === 1)
      return { lead: hits[0], matchedBy: 'name', payerName, payerEmail, payerPhone };
  }
  return { payerName, payerEmail, payerPhone };
}

// --- Reconcile one payment onto one lead, the way syncSquare would --------------
const changed = [];
async function reconcile(payment, leadEntry, matchedBy, provenance) {
  const d = leadEntry.d;
  const cents = payment.amount_money?.amount ?? 0;
  const dollars = cents / 100;
  const amountLabel = fmtDollars(cents);
  const paidTs = new Date(payment.created_at).getTime();
  const note = (payment.note ?? '').trim();
  const attempts = Array.isArray(d.contactAttempts) ? d.contactAttempts : [];
  if (attempts.some((a) => a?.paymentId === payment.id || (a?.notes ?? '').includes(payment.id))) {
    return 'already_logged';
  }

  let notes = `Square payment received — ${amountLabel} (payment ${payment.id}) — matched by ${
    matchedBy === 'note' ? `payment note "${note}"` : matchedBy
  } (${provenance})`;
  const call = attempts.find(
    (a) => a?.via === 'callrail' && typeof a.ts === 'number' && paidTs > a.ts && paidTs <= a.ts + 3 * 3600_000,
  );
  if (call) {
    const mins = Math.max(1, Math.round((paidTs - call.ts) / 60_000));
    notes += `; corroborated — charge landed ${mins}m after a CallRail call on this lead`;
  }

  const now = Date.now();
  const paidTotal = (d.squarePaidTotal ?? 0) + dollars;
  // Explicit partial signals in the note beat the fee arithmetic (precedent:
  // reconcileNoteMatchedPayments-2026-07-22.mjs) — staff write "Balance=$X"
  // or "half retainer" when the money is deliberately partial.
  const noteBalance = Number((note.match(/balance\s*=?\s*\$?([\d,]+\.?\d*)/i) || [])[1]?.replace(/,/g, '') ?? 0);
  const noteSaysHalf = /\bhalf\b/i.test(note);
  if (noteBalance > 0) notes += `; payment note reports a remaining balance of $${noteBalance}`;
  const saleAmount = typeof d.saleAmount === 'number' && d.saleAmount > 0 ? d.saleAmount : null;
  const coversFee =
    noteBalance > 0 || noteSaysHalf
      ? false
      : !saleAmount || dollars >= saleAmount || paidTotal >= saleAmount;
  const alreadyPaidFull = d.saleStatus === 'paid_full'; // never downgrade

  const patch = {
    updatedAt: now,
    contactAttempts: [
      ...attempts,
      { ts: paidTs, outcome: 'retained', via: 'square', notes, by: 'Square sync', paymentId: payment.id },
    ],
    squarePaidTotal: paidTotal,
    planStallFlaggedAt: null,
    saleEscalatedAt: null,
    salePursuitAlertAt: null,
  };

  let action;
  if (coversFee || alreadyPaidFull) {
    patch.saleStatus = 'paid_full';
    if (!alreadyPaidFull) patch.saleStatusAt = paidTs;
    if (d.stage !== 'intake_complete' && d.stage !== 'financed') {
      const day = new Date(paidTs).toLocaleDateString('en-US', { month: 'short', day: 'numeric', ...CT });
      patch.stage = 'intake_complete';
      patch.intakeComplete = true;
      patch.intakeCompleteAt = paidTs;
      patch.retainedAt = d.retainedAt ?? paidTs;
      patch.autoStageNote = `Stage moved to Intake Complete by Square sync — ${amountLabel} payment received on ${day}`;
      patch.autoStageAt = now;
      action = 'paid_full_moved';
    } else {
      action = 'paid_full';
    }
    // Paid in full — every still-pending follow-up is a sales artifact
    // (same reconcile actions as Part 1 / the classifier's sale move).
    patch.followUps = (Array.isArray(d.followUps) ? d.followUps : []).map((f) =>
      f && !f.done ? { ...f, done: true, doneAt: now } : f,
    );
  } else {
    patch.saleStatus = 'paid_partial';
    patch.saleStatusAt = paidTs;
    action = 'paid_partial';
    // Partial keeps the lead's billing treatment; close only the sales-cadence
    // chase touches (mirrors Part 1's Pierre handling).
    patch.followUps = (Array.isArray(d.followUps) ? d.followUps : []).map((f) =>
      f && !f.done && ['callback', 'chase', 'nurture'].includes(f.type ?? 'callback')
        ? { ...f, done: true, doneAt: now }
        : f,
    );
  }

  await patchDoc(`leads/${leadEntry.id}`, patch);
  // Keep the in-memory copy honest for multi-payment leads.
  Object.assign(d, patch);

  // Money arrived — stand down open billing escalations (mirrors syncSquare).
  const esc = await runQuery({
    from: [{ collectionId: 'messages' }],
    where: {
      compositeFilter: {
        op: 'AND',
        filters: [
          { fieldFilter: { field: { fieldPath: 'leadId' }, op: 'EQUAL', value: { stringValue: leadEntry.id } } },
          { fieldFilter: { field: { fieldPath: 'kind' }, op: 'EQUAL', value: { stringValue: 'billing_escalation' } } },
          { fieldFilter: { field: { fieldPath: 'handled' }, op: 'EQUAL', value: { booleanValue: false } } },
        ],
      },
    },
  });
  let escalations = 0;
  for (const r of esc) {
    if (dec((r.document.fields || {}).deletedAt)) continue;
    await patchDoc(r.document.name.split('/documents/')[1], {
      handled: true, handledAt: paidTs, handledBy: 'Square sync', updatedAt: now,
    });
    escalations++;
  }

  changed.push({
    lead: d.name, leadId: leadEntry.id, paymentId: payment.id, amountLabel,
    paidTs, card: cardOf(payment), matchedBy, action,
    squarePaidTotal: paidTotal, escalations,
    evidence: matchedBy === 'note' ? `note "${note}"` : matchedBy,
  });
  console.log(
    `    MATCH ${d.name} ← ${amountLabel} ${payment.id.slice(0, 8)}… ${fmtCT(paidTs)} (${cardOf(payment)}) → ${action} [by ${matchedBy}]`,
  );
  return action;
}

// === A. Pre-window backfill (2026-01-01 → current window start) =================
const state = await runQuery({
  from: [{ collectionId: 'syncState' }],
  where: { fieldFilter: { field: { fieldPath: '__name__' }, op: 'EQUAL', value: { referenceValue: `projects/${PROJECT}/databases/(default)/documents/syncState/squareSync` } } },
});
const backfillStartAt = dec(state[0]?.document?.fields?.backfillStartAt) ?? Date.now() - 60 * 86400_000;
console.log(`\n=== A. Pre-window backfill: ${BACKFILL_FROM} → ${new Date(backfillStartAt).toISOString()} ===`);
const preWindow = await fetchPayments(BACKFILL_FROM, new Date(backfillStartAt).toISOString());
const preCompleted = preWindow.filter((p) => p.status === 'COMPLETED');
console.log(`  payments pulled: ${preWindow.length} (${preCompleted.length} COMPLETED)`);

// Existing markers (all of them, one page walk) — pre-window payments normally
// have none, but re-runs must be harmless.
const markerDocs = new Map();
pageToken = '';
do {
  const url = `${BASE}/squarePayments?pageSize=300${pageToken ? `&pageToken=${pageToken}` : ''}`;
  const res = await fetch(url, { headers: fsHeaders });
  const json = await res.json();
  (json.documents || []).forEach((m) =>
    markerDocs.set(m.name.split('/').pop(), Object.fromEntries(Object.entries(m.fields || {}).map(([k, v]) => [k, dec(v)]))),
  );
  pageToken = json.nextPageToken || '';
} while (pageToken);
console.log(`  existing markers: ${markerDocs.size}`);

let backfillMatched = 0;
let backfillIgnored = 0;
for (const payment of preCompleted) {
  if (payment.id === AMBIGUOUS_PAYMENT) continue; // guarded by payment id
  if (markerDocs.has(payment.id)) continue; // already processed
  const m = await matchPayment(payment);
  const now = Date.now();
  if (m.lead) {
    const leadEntry = leadById.get(m.lead.id);
    await reconcile(payment, leadEntry, m.matchedBy, 'pre-window backfill 2026-07-24');
    await patchDoc(`squarePayments/${payment.id}`, {
      processedAt: now,
      leadId: m.lead.id,
      action: 'matched',
      matchedBy: m.matchedBy,
      amountCents: payment.amount_money?.amount ?? 0,
      matcherVersion: MATCHER_VERSION,
      reconciledBy: 'extendSquareVisibility-2026-07-24 — pre-window backfill',
      reconciledAt: now,
    }, { mustExist: false });
    backfillMatched++;
  } else {
    if (m.ambiguous) {
      console.log(
        `    AMBIGUOUS ${payment.id.slice(0, 8)}… ${fmtDollars(payment.amount_money?.amount ?? 0)} note "${payment.note ?? ''}" names ${m.ambiguous.map((l) => l.name).join(' AND ')} — left unmatched`,
      );
    }
    await patchDoc(`squarePayments/${payment.id}`, {
      processedAt: now,
      leadId: null,
      action: 'ignored_unrelated',
      evidence: m.ambiguous ? `note names ${m.ambiguous.length} leads — refusing to guess` : null,
      amountCents: payment.amount_money?.amount ?? 0,
      payerName: m.payerName ?? null,
      payerEmail: m.payerEmail ?? null,
      payerPhone: m.payerPhone ?? null,
      matcherVersion: MATCHER_VERSION,
      reconciledBy: 'extendSquareVisibility-2026-07-24 — pre-window backfill',
    }, { mustExist: false });
    backfillIgnored++;
  }
}
console.log(`  backfill: ${backfillMatched} matched, ${backfillIgnored} ignored (unrelated/unmatched)`);

// === B. Re-evaluate every stale unmatched/ignored marker ========================
console.log('\n=== B. Re-evaluating existing unmatched/ignored markers ===');
const stale = [...markerDocs.entries()].filter(
  ([id, m]) =>
    ['unmatched', 'ignored_unrelated'].includes(m.action) &&
    (m.matcherVersion ?? 1) < MATCHER_VERSION &&
    id !== AMBIGUOUS_PAYMENT,
);
console.log(`  stale markers to re-check: ${stale.length}`);
// One windowed pull covers them all (markers only exist inside the sync's
// visibility window); anything missing gets fetched by id.
const windowPayments = new Map(
  (await fetchPayments(new Date(backfillStartAt - 86400_000).toISOString(), null)).map((p) => [p.id, p]),
);
let reMatched = 0;
let reStamped = 0;
for (const [id, marker] of stale) {
  let payment = windowPayments.get(id);
  if (!payment) {
    const res = await fetch(`https://connect.squareup.com/v2/payments/${id}`, { headers: sqHeaders });
    payment = res.ok ? (await res.json()).payment : null;
  }
  const now = Date.now();
  if (!payment || payment.status !== 'COMPLETED') {
    await patchDoc(`squarePayments/${id}`, { matcherVersion: MATCHER_VERSION, updatedAt: now });
    reStamped++;
    continue;
  }
  const m = await matchPayment(payment);
  if (m.lead) {
    const leadEntry = leadById.get(m.lead.id);
    await reconcile(payment, leadEntry, m.matchedBy, 'marker re-evaluation 2026-07-24');
    await patchDoc(`squarePayments/${id}`, {
      processedAt: now,
      leadId: m.lead.id,
      action: 'matched',
      matchedBy: m.matchedBy,
      matcherVersion: MATCHER_VERSION,
      reconciledBy: `extendSquareVisibility-2026-07-24 — re-evaluated (was ${marker.action})`,
      reconciledAt: now,
    });
    reMatched++;
  } else {
    if (m.ambiguous) {
      console.log(
        `    AMBIGUOUS ${id.slice(0, 8)}… note "${payment.note ?? ''}" names ${m.ambiguous.map((l) => l.name).join(' AND ')} — left as-is`,
      );
    }
    await patchDoc(`squarePayments/${id}`, { matcherVersion: MATCHER_VERSION, updatedAt: now });
    reStamped++;
  }
}
console.log(`  re-evaluated: ${reMatched} newly matched, ${reStamped} stamped matcherVersion ${MATCHER_VERSION} (still unmatched)`);

// === C. Guards + window move =====================================================
console.log('\n=== C. Ambiguous-charge guard + visibility window ===');
// The Dessie/"Parmjeet Singh" charge must never be auto-credited — exempt its
// marker from the sync's own re-evaluation pass too.
await patchDoc(`squarePayments/${AMBIGUOUS_PAYMENT}`, {
  reEvalExempt: true,
  matcherVersion: MATCHER_VERSION,
  updatedAt: Date.now(),
}, { mustExist: false });
console.log(`  ${AMBIGUOUS_PAYMENT} marker stamped reEvalExempt`);
const newStart = new Date(BACKFILL_FROM).getTime();
await patchDoc('syncState/squareSync', { backfillStartAt: newStart });
console.log(`  backfillStartAt: ${new Date(backfillStartAt).toISOString()} → ${BACKFILL_FROM}`);

// === Report =====================================================================
console.log('\n================= LEADS CHANGED =================');
for (const c of changed) {
  console.log(`\n${c.lead} (${c.leadId})`);
  console.log(`  ${c.amountLabel} payment ${c.paymentId} at ${fmtCT(c.paidTs)} (${c.card})`);
  console.log(`  matched by ${c.matchedBy} — ${c.evidence}`);
  console.log(`  → ${c.action}; squarePaidTotal ${c.squarePaidTotal}${c.escalations ? `; ${c.escalations} billing escalation(s) stood down` : ''}`);
}
console.log(`\nTotals: backfill ${backfillMatched} matched / ${backfillIgnored} ignored; re-eval ${reMatched} newly matched / ${reStamped} stamped current.`);
console.log(DRY ? '\n(DRY RUN — nothing written)' : '\nDone.');
