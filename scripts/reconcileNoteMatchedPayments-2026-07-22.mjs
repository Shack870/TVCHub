// One-time reconciliation of Square payments whose client identity lives only
// in the payment's free-text note (2026-07-22 audit).
//
// Staff key cards manually, so the Square customer record is blank and the
// name sits in the note ("Khup Sum Retainer Payment"). The sync's matcher
// missed these, creating false "Transcript says PAID but no Square charge"
// escalations. This script:
//   1. Credits the 9 audit-confirmed payments to their leads exactly the way
//      syncSquare would (contact attempt, squarePaidTotal, saleStatus, stage).
//   2. Marks those 9 leads' false billing escalations handled.
//   3. Rewrites Dessie Ashenafi Assmamaw's escalation (stays OPEN) to describe
//      the ambiguous $1,125 "Parmjeet Singh Retainer Fee" charge, and prints
//      Parmjeet Singh's CallRail activity around that charge for the report.
//   4. Re-evaluates the remaining "Unmatched Square payment" post-its with
//      note-text matching; reconciles any that now match and marks them
//      handled.
//
// Run with DRY=1 to preview without writing.
import { execSync } from 'node:child_process';

const PROJECT = 'tvchub-f2401';
const ROOT = `https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/(default)`;
const BASE = `${ROOT}/documents`;
const DRY = process.env.DRY === '1';

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
async function patchDoc(docPath, patch) {
  if (DRY) {
    console.log(`  DRY: would patch ${docPath} — ${Object.keys(patch).join(', ')}`);
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
async function runQuery(structuredQuery) {
  const res = await fetch(`${BASE}:runQuery`, {
    method: 'POST',
    headers: fsHeaders,
    body: JSON.stringify({ structuredQuery }),
  });
  if (!res.ok) throw new Error(`runQuery ${res.status}: ${await res.text()}`);
  return (await res.json()).filter((r) => r.document);
}

// --- Name/note normalization (mirrors the fixed matcher in squaresync.ts) -----
const lc = (s) => String(s ?? '').toLowerCase().trim();
const normalizeText = (s) => lc(s).replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
function nameNeedles(name) {
  const norm = normalizeText(name);
  if (norm.length < 6) return [];
  const parts = norm.split(' ');
  const needles = new Set([parts.join(' ')]);
  if (parts.length >= 2) {
    needles.add([...parts].reverse().join(' '));
    needles.add(`${parts[0]} ${parts[parts.length - 1]}`);
    needles.add(`${parts[parts.length - 1]} ${parts[0]}`);
  }
  return [...needles].filter((n) => n.length >= 6);
}

const CT = { timeZone: 'America/Chicago' };
const fmtCT = (ts) => new Date(ts).toLocaleString('en-US', { ...CT, timeZoneName: 'short' });
const fmtDollars = (cents) => `$${(cents / 100).toFixed(2)}`;

// --- The 9 audit-confirmed payments -------------------------------------------
// expect: 'full' | 'partial' — per the 2026-07-22 note-text audit.
const CONFIRMED = [
  { prefix: 'D1GquUI2', leadName: 'Khup Sum', expect: 'full', dollars: 1125 },
  { prefix: 'ZebxSf6i', leadName: 'FUAD MAKHTAL AHMED', expect: 'full', dollars: 1125 },
  { prefix: 'zvRvg5xH', leadName: 'MARK A BRADFORD', expect: 'full', dollars: 1125 },
  { prefix: 'ffscrP7e', leadName: 'Dawit Mekebeb', expect: 'full', dollars: 1125 },
  { prefix: 'RufKGEpn', leadName: 'Alemseged Woldu Yohannes', expect: 'full', dollars: 1125 },
  { prefix: 'RWnI2FIP', leadName: 'Philorius Joseph', expect: 'partial', dollars: 375 },
  { prefix: 'L9ivk7Zi', leadName: 'Zeru Eyob', expect: 'partial', dollars: 563 },
  {
    prefix: 'FWILovPl', leadName: 'Cesar Gonzalez', expect: 'full', dollars: 826,
    extraNote: 'TVC covers the remaining $299.00 of the $1,125 fee per the payment note',
  },
  { prefix: 'zNEbJlyU', leadName: 'Haroon Shahzad', expect: 'full', dollars: 1125, setSaleAmount: 1125 },
];
// The ambiguous charge — NEVER auto-credited (note says "Parmjeet Singh
// Retainer Fee" but timing points at Dessie; a human must decide).
const AMBIGUOUS_PREFIX = 'pi7shqJ6';

// --- Load Square payments since late June --------------------------------------
const payments = [];
let cursor = '';
do {
  const url =
    'https://connect.squareup.com/v2/payments?location_id=LPK9GY4PHM28J' +
    '&begin_time=2026-05-20T00:00:00Z&sort_order=ASC&limit=100' +
    (cursor ? `&cursor=${encodeURIComponent(cursor)}` : '');
  const res = await fetch(url, { headers: sqHeaders });
  if (!res.ok) throw new Error(`Square payments ${res.status}: ${await res.text()}`);
  const json = await res.json();
  payments.push(...(json.payments || []));
  cursor = json.cursor || '';
} while (cursor);
const byPrefix = (prefix) => payments.find((p) => p.id.startsWith(prefix));
const cardOf = (p) => {
  const c = p.card_details?.card;
  return c ? `${c.card_brand ?? 'CARD'} •${c.last_4 ?? '????'}` : 'card unknown';
};
console.log(`Square payments loaded since Jun 25: ${payments.length}\n`);

// --- Load all leads -------------------------------------------------------------
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
const liveLeads = leadDocs.filter((l) => !dec(l.f.deletedAt));
const leadByName = (name) => {
  const hits = liveLeads.filter((l) => lc(dec(l.f.name)) === lc(name));
  if (hits.length !== 1) {
    console.error(`!! lead lookup "${name}" → ${hits.length} hits — skipping`);
    return null;
  }
  return hits[0];
};
console.log(`Leads loaded: ${leadDocs.length} (${liveLeads.length} live)\n`);

// --- Core: credit one payment to one lead, the way syncSquare would -------------
const summary = [];
async function reconcile(payment, leadDoc, { expect, extraNote, setSaleAmount, provenance }) {
  const d = {};
  for (const [k, v] of Object.entries(leadDoc.f)) d[k] = dec(v);
  const cents = payment.amount_money?.amount ?? 0;
  const dollars = cents / 100;
  const amountLabel = fmtDollars(cents);
  const paidTs = new Date(payment.created_at).getTime();
  const attempts = Array.isArray(d.contactAttempts) ? d.contactAttempts : [];

  if (attempts.some((a) => a?.paymentId === payment.id || (a?.notes ?? '').includes(payment.id))) {
    console.log(`  SKIP ${d.name} — payment ${payment.id} already logged`);
    return null;
  }

  let notes =
    `Square payment received — ${amountLabel} (payment ${payment.id})` +
    ` — matched by payment note "${(payment.note ?? '').trim()}"${provenance ? ` (${provenance})` : ''}`;
  const call = attempts.find(
    (a) => a?.via === 'callrail' && typeof a.ts === 'number' && paidTs > a.ts && paidTs <= a.ts + 3 * 3600_000,
  );
  if (call) {
    const mins = Math.max(1, Math.round((paidTs - call.ts) / 60_000));
    notes += `; corroborated — charge landed ${mins}m after a CallRail call on this lead`;
  }
  if (extraNote) notes += `; ${extraNote}`;

  const now = Date.now();
  const patch = {
    updatedAt: now,
    contactAttempts: [
      ...attempts,
      { ts: paidTs, outcome: 'retained', via: 'square', notes, by: 'Square sync', paymentId: payment.id },
    ],
    squarePaidTotal: (d.squarePaidTotal ?? 0) + dollars,
    saleStatusAt: paidTs,
    saleEscalatedAt: null,
    salePursuitAlertAt: null,
  };
  if (setSaleAmount && !d.saleAmount) patch.saleAmount = setSaleAmount;

  let action;
  if (expect === 'full') {
    patch.saleStatus = 'paid_full';
    patch.followUps = (Array.isArray(d.followUps) ? d.followUps : []).map((f) =>
      f && !f.done && f.type === 'billing' ? { ...f, done: true, doneAt: now } : f,
    );
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
  } else {
    patch.saleStatus = 'paid_partial';
    action = 'paid_partial';
  }

  await patchDoc(`leads/${leadDoc.id}`, patch);
  await patchDoc(`squarePayments/${payment.id}`, {
    action: 'matched',
    leadId: leadDoc.id,
    matchedBy: 'note',
    amountCents: cents,
    reconciledBy: 'reconcileNoteMatchedPayments-2026-07-22 — note-text audit',
    reconciledAt: now,
    updatedAt: now,
  });
  console.log(
    `  OK ${d.name} ← ${amountLabel} ${payment.id.slice(0, 8)}… (${cardOf(payment)}) → ${action}, squarePaidTotal ${patch.squarePaidTotal}${call ? ' [call-corroborated]' : ''}`,
  );
  summary.push({
    leadId: leadDoc.id, name: d.name, paymentId: payment.id, amountLabel,
    paidTs, card: cardOf(payment), action, squarePaidTotal: patch.squarePaidTotal,
  });
  return { leadId: leadDoc.id, paymentId: payment.id };
}

// === 1. The 9 audit-confirmed payments ==========================================
console.log('=== 1. Reconciling the 9 audit-confirmed payments ===');
const reconciledLeadIds = [];
const reconciledPaymentIds = [];
for (const c of CONFIRMED) {
  const payment = byPrefix(c.prefix);
  if (!payment) { console.error(`!! payment ${c.prefix}… not found in Square — skipping`); continue; }
  if (Math.abs((payment.amount_money?.amount ?? 0) / 100 - c.dollars) > 1) {
    console.error(`!! payment ${c.prefix}… amount ${payment.amount_money?.amount} ≠ expected $${c.dollars} — skipping`);
    continue;
  }
  const leadDoc = leadByName(c.leadName);
  if (!leadDoc) continue;
  const done = await reconcile(payment, leadDoc, { ...c, provenance: 'verified by 2026-07-22 timing+amount+note audit' });
  if (done) { reconciledLeadIds.push(done.leadId); reconciledPaymentIds.push(done.paymentId); }
}

// === 2. Mark the 9 false escalations handled ====================================
console.log('\n=== 2. Clearing false "Transcript says PAID" escalations ===');
const escalations = (
  await runQuery({
    from: [{ collectionId: 'messages' }],
    where: {
      fieldFilter: { field: { fieldPath: 'kind' }, op: 'EQUAL', value: { stringValue: 'billing_escalation' } },
    },
  })
).filter((r) => {
  const f = r.document.fields || {};
  return (
    !dec(f.deletedAt) &&
    dec(f.handled) === false &&
    (dec(f.subject) || '').startsWith('Transcript says PAID but no Square charge')
  );
});
for (const r of escalations) {
  const f = r.document.fields || {};
  const leadId = dec(f.leadId);
  if (!reconciledLeadIds.includes(leadId)) continue;
  const docPath = r.document.name.split('/documents/')[1];
  await patchDoc(docPath, {
    handled: true,
    handledAt: Date.now(),
    handledBy: 'Square sync — reconciled',
    updatedAt: Date.now(),
  });
  console.log(`  HANDLED ${dec(f.subject)}`);
}

// === 3. Dessie's escalation: keep open, rewrite message =========================
console.log('\n=== 3. Dessie / "Parmjeet Singh" ambiguous charge ===');
const ambiguous = byPrefix(AMBIGUOUS_PREFIX);
if (!ambiguous) throw new Error(`ambiguous payment ${AMBIGUOUS_PREFIX}… not found in Square`);
console.log(
  `  ambiguous charge: ${ambiguous.id} ${fmtDollars(ambiguous.amount_money?.amount ?? 0)} at ${fmtCT(new Date(ambiguous.created_at).getTime())} (${cardOf(ambiguous)}), note "${ambiguous.note}"`,
);

// Parmjeet Singh's CallRail activity around the charge (Jul 15–19 window).
const parmjeet = leadByName('Parmjeet Singh');
let parmjeetFinding = 'Parmjeet Singh lead not found — could not check call activity.';
if (parmjeet) {
  const ambTs = new Date(ambiguous.created_at).getTime();
  const attempts = (dec(parmjeet.f.contactAttempts) || []).filter((a) => a?.via === 'callrail');
  console.log(`  Parmjeet Singh (${parmjeet.id}) CallRail attempts: ${attempts.length} total`);
  const near = attempts.filter((a) => Math.abs(a.ts - ambTs) <= 2 * 86400_000);
  for (const a of attempts) console.log(`    - ${fmtCT(a.ts)} · ${a.outcome ?? '?'} · ${(a.notes ?? '').slice(0, 100)}`);
  const during = attempts.some((a) => a.ts <= ambTs && ambTs <= a.ts + 3 * 3600_000);
  parmjeetFinding = during
    ? 'Parmjeet Singh WAS on a CallRail call within 3h before the charge — the note may be accurate.'
    : near.length
      ? `Parmjeet Singh had ${near.length} CallRail call(s) within 2 days of the charge but none in the 3h window before it.`
      : 'Parmjeet Singh had NO CallRail call activity anywhere near Jul 17 — the note was likely mislabeled during Dessie\'s call, but a human must confirm.';
  console.log(`  finding: ${parmjeetFinding}`);
}

const dessie = leadByName('Dessie Ashenafi Assmamaw');
if (dessie) {
  const dessieEsc = escalations.find((r) => dec(r.document.fields?.leadId) === dessie.id);
  if (dessieEsc) {
    const ambTs = new Date(ambiguous.created_at).getTime();
    const newMessage =
      `Dessie Ashenafi Assmamaw was marked paid in full ($1,125) on the Jul 17 call, and a perfectly timed ` +
      `Square charge DOES exist: $1,125 payment ${ambiguous.id} at ${fmtCT(ambTs)} (Visa •3482), keyed in ` +
      `mid-call with Dessie — but its note reads "Parmjeet Singh Retainer Fee", and there is also a lead named ` +
      `Parmjeet Singh in the system. ${parmjeetFinding} ` +
      `Verify which client this charge belongs to before crediting it: if it is Dessie's money, mark Dessie paid ` +
      `(and fix the Square note); if it is truly Parmjeet's, Dessie's claimed payment is still missing.`;
    await patchDoc(dessieEsc.document.name.split('/documents/')[1], {
      message: newMessage,
      updatedAt: Date.now(),
    });
    console.log('  Dessie escalation message UPDATED (kept open/unhandled)');
  } else {
    console.error('!! Dessie escalation post-it not found among open escalations');
  }
}

// === 4. Re-evaluate remaining "Unmatched Square payment" post-its ===============
console.log('\n=== 4. Re-evaluating unmatched-payment post-its with note matching ===');
const unmatchedPostIts = (
  await runQuery({
    from: [{ collectionId: 'messages' }],
    where: {
      fieldFilter: { field: { fieldPath: 'from' }, op: 'EQUAL', value: { stringValue: 'Square Sync' } },
    },
  })
).filter((r) => {
  const f = r.document.fields || {};
  return (
    !dec(f.deletedAt) &&
    dec(f.handled) === false &&
    (dec(f.subject) || '').startsWith('Unmatched Square payment')
  );
});
console.log(`  open unmatched post-its: ${unmatchedPostIts.length}`);
const resolved = [];
const remaining = [];
for (const r of unmatchedPostIts) {
  const f = r.document.fields || {};
  const paymentId = dec(f.squarePaymentId);
  const subject = dec(f.subject);
  const docPath = r.document.name.split('/documents/')[1];

  // Already credited above (one of the 9)? Just close the post-it.
  if (reconciledPaymentIds.includes(paymentId)) {
    await patchDoc(docPath, { handled: true, handledAt: Date.now(), handledBy: 'Square sync — reconciled', updatedAt: Date.now() });
    resolved.push(`${subject} — payment was one of the 9 audit-confirmed, post-it closed`);
    continue;
  }
  if (paymentId?.startsWith(AMBIGUOUS_PREFIX)) {
    remaining.push(`${subject} — the ambiguous Dessie/"Parmjeet Singh" charge, left for human review`);
    continue;
  }
  const payment = payments.find((p) => p.id === paymentId);
  if (!payment) { remaining.push(`${subject} — payment ${paymentId} not found in Square window`); continue; }

  const note = (payment.note ?? '').trim();
  const hay = ` ${normalizeText(note)} `;
  const hits = new Map();
  if (hay.trim()) {
    for (const l of liveLeads) {
      if (nameNeedles(dec(l.f.name)).some((n) => hay.includes(` ${n} `))) hits.set(l.id, l);
    }
  }
  if (hits.size !== 1) {
    remaining.push(`${subject} — note "${note}" matched ${hits.size} leads, still unresolved`);
    continue;
  }
  const leadDoc = [...hits.values()][0];
  const d = Object.fromEntries(Object.entries(leadDoc.f).map(([k, v]) => [k, dec(v)]));
  const dollars = (payment.amount_money?.amount ?? 0) / 100;
  const paidTotal = (d.squarePaidTotal ?? 0) + dollars;
  // Staff notes often carry the truth about installments ("Balance=$425.00")
  // even when the lead's recorded saleAmount is stale — an explicit remaining
  // balance in the note always means partial.
  const noteBalance = Number((note.match(/balance\s*=?\s*\$?([\d,]+\.?\d*)/i) || [])[1]?.replace(/,/g, '') ?? 0);
  const coversFee =
    noteBalance > 0 ? false : !d.saleAmount || dollars >= d.saleAmount || paidTotal >= d.saleAmount;
  const done = await reconcile(payment, leadDoc, {
    expect: coversFee || d.saleStatus === 'paid_full' ? 'full' : 'partial',
    extraNote: noteBalance > 0 ? `payment note reports a remaining balance of $${noteBalance}` : undefined,
    provenance: 'note-matched during 2026-07-22 post-it re-evaluation',
  });
  if (done) {
    reconciledLeadIds.push(done.leadId);
    reconciledPaymentIds.push(done.paymentId);
    await patchDoc(docPath, { handled: true, handledAt: Date.now(), handledBy: 'Square sync — note-matched & reconciled', updatedAt: Date.now() });
    resolved.push(`${subject} — note "${note}" → ${d.name}`);
  } else {
    // Already logged on the lead; the post-it is stale either way.
    await patchDoc(docPath, { handled: true, handledAt: Date.now(), handledBy: 'Square sync — already reconciled', updatedAt: Date.now() });
    resolved.push(`${subject} — payment was already logged on ${d.name}, post-it closed`);
  }
}

// === Summary ====================================================================
console.log('\n=== SUMMARY ===');
console.log('\nReconciled payments:');
for (const s of summary) {
  console.log(
    `  ${s.name} ← ${s.amountLabel} (${s.paymentId}) ${fmtCT(s.paidTs)} ${s.card} → ${s.action}, squarePaidTotal ${s.squarePaidTotal}`,
  );
}
console.log('\nUnmatched post-its RESOLVED:');
resolved.forEach((x) => console.log(`  - ${x}`));
console.log('\nUnmatched post-its REMAINING:');
remaining.forEach((x) => console.log(`  - ${x}`));
console.log(`\nParmjeet finding: ${parmjeetFinding}`);
console.log(DRY ? '\n(DRY RUN — nothing written)' : '\nDone.');
