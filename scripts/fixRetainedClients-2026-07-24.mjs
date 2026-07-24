// One-time remediation of the "retained client chased as prospect" QA findings
// (2026-07-24). Six leads retained with the firm were still being worked as
// prospects because their Square charges were never matched (markers written
// by the pre-note-matcher sync and never re-evaluated), one payment predates
// the Square backfill window entirely, and one retention arrived only as a
// Gmail notice with no identifiable charge.
//
// Per lead, this mirrors exactly what syncSquare does on a confident match:
// retained contact attempt carrying the payment id, squarePaidTotal rollup,
// saleStatus/saleStatusAt from the PAYMENT time, paid_full -> intake_complete
// with intakeCompleteAt = payment time, pending sales follow-ups closed, open
// billing escalations stood down, and the squarePayments marker flipped to
// action 'matched' with a reconciledBy provenance note (+ matcherVersion 2).
//
//   1. Sergio Michel Perez Zamora — $1,155 paid Mar 3 (pre-window) -> paid_full
//   2. Pierre Washington          — $562 paid Jul 6 (half of $1,125) -> paid_partial
//   3. Yusnier Adolfo Suarez Anuez— $1,125 paid Jul 10 -> paid_full
//   4. Adrian Bernal              — $1,125 paid Jul 21 -> paid_full
//   5. Adam Blake Holden          — retained per the firm's Jul 14 Gmail notice
//      to TVC (Entry/Waiver/Plea filed Jul 14); no identifiable Square charge,
//      so squarePaidTotal stays absent and squareVerifyFlaggedAt is stamped so
//      the transcript-vs-Square verification pass doesn't false-alarm on him.
//   6. Parmjeet Singh             — retained per the firm's Jul 17 notice, but
//      the $1,125 Jul 17 charge ("Parmjeet Singh Retainer Fee", keyed mid-call
//      with Dessie Ashenafi Assmamaw) stays a human call. No stage move, no
//      money credited — pending sales follow-ups closed, chase paused via
//      possibleExistingClientAt, and the ambiguity post-it (found dismissed on
//      Jul 22 with the money still uncredited) re-raised with the retention
//      notice added.
//
// Run with DRY=1 first to preview without writing.
import { execSync } from 'node:child_process';

const PROJECT = 'tvchub-f2401';
const BASE = `https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/(default)/documents`;
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
async function getDoc(docPath) {
  const res = await fetch(`${BASE}/${docPath}`, { headers: fsHeaders });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`GET ${docPath} ${res.status}: ${await res.text()}`);
  const json = await res.json();
  const out = {};
  for (const [k, v] of Object.entries(json.fields || {})) out[k] = dec(v);
  return out;
}
async function patchDoc(docPath, patch, { mustExist = true } = {}) {
  if (DRY) {
    console.log(`  DRY: would patch ${docPath} — ${Object.keys(patch).join(', ')}`);
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
async function addDoc(collection, data) {
  if (DRY) {
    console.log(`  DRY: would add to ${collection} — subject: ${data.subject ?? '(n/a)'}`);
    return;
  }
  const fields = {};
  for (const [k, v] of Object.entries(data)) fields[k] = enc(v);
  const res = await fetch(`${BASE}/${collection}`, {
    method: 'POST',
    headers: fsHeaders,
    body: JSON.stringify({ fields }),
  });
  if (!res.ok) throw new Error(`POST ${collection} ${res.status}: ${await res.text()}`);
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
const MATCHER_VERSION = 2; // keep in sync with functions/src/squaresync.ts

async function fetchPayment(id) {
  const res = await fetch(`https://connect.squareup.com/v2/payments/${id}`, { headers: sqHeaders });
  if (!res.ok) throw new Error(`Square payment ${id} ${res.status}: ${await res.text()}`);
  return (await res.json()).payment;
}

// --- The five leads (doc ids verified against tvcCaseNumber below) -------------
const FIXES = [
  {
    tvc: '1521022', leadId: '8Re8mqvn4gcHDIf3oy5H', name: 'Sergio Michel Perez Zamora',
    paymentId: 'LpgpRgTqjcVwY5CHpjsD9Bx0SoOZY', expectCents: 115500, expect: 'full',
    setSaleAmount: 1155,
    extraNote:
      'retained Mar 3, 2026 — reconciled from pre-window Square history; ' +
      'next trial Aug 20, 2026 per office correspondence',
  },
  {
    tvc: '1558593', leadId: 'IUbSV1AKDQ1CmZ7aTCAm', name: 'Pierre Washington',
    paymentId: 'LvlibxWOIzvRFVfmBG29xNveUGFZY', expectCents: 56200, expect: 'partial',
    setSaleAmount: 1125, // $562 is half of the standard $1,125 fee — $563 outstanding
    // His card was soft-deleted on Jul 24 (mid-QA, presumably staff dismissing
    // the chase). A paid_partial client with $563 outstanding belongs on the
    // Financing/receivables watch, not in the trash — restore it.
    restoreIfDeleted: true,
  },
  {
    tvc: '1559178', leadId: 'Go5XBbD3653nV2jK8fSW', name: 'Yusnier Adolfo Suarez Anuez',
    paymentId: '1Ck4KLRwNuDw3FrU6s6vFdoKCF9YY', expectCents: 112500, expect: 'full',
    setSaleAmount: 1125,
  },
  {
    tvc: '1559446', leadId: 'A5iddOzhtDIOHDi4ZeOU', name: 'Adrian Bernal',
    paymentId: 'hgyxkbWl8vNal7HXSSJdc9NrQq7YY', expectCents: 112500, expect: 'full',
    setSaleAmount: 1125,
  },
];
const ADAM = { tvc: '1546819', leadId: '31HCgCmsIBGtZDh0lKp7', name: 'Adam Blake Holden' };
const PARMJEET = { tvc: '1563109', leadId: 'QEM7hqqjRWAiKEyaL7LU', name: 'Parmjeet Singh' };
const AMBIGUOUS_PAYMENT = 'pi7shqJ6XFOIoa0etXktOYp26FJZY';
// The firm's retention notice for Adam landed at TVC on Jul 14, 2026
// (Entry/Waiver/Plea also filed Jul 14) — noon CT stands in for the unknown
// clock time.
const ADAM_RETAINED_AT = new Date('2026-07-14T12:00:00-05:00').getTime();

const report = [];
function loadLead(leadId, tvc, name, { restoreIfDeleted = false } = {}) {
  return getDoc(`leads/${leadId}`).then((d) => {
    if (!d) throw new Error(`lead ${leadId} (${name}) not found`);
    if (d.deletedAt && !restoreIfDeleted) throw new Error(`lead ${leadId} (${name}) is deleted`);
    if (String(d.tvcCaseNumber) !== tvc) throw new Error(`lead ${leadId} tvc ${d.tvcCaseNumber} ≠ ${tvc}`);
    return d;
  });
}
const describeFU = (f) => `${f.type ?? 'callback'} due ${new Date(f.dueAt ?? 0).toLocaleDateString('en-US', CT)} — ${(f.note ?? '').slice(0, 60)}`;

// Close every pending follow-up (the lead is retained — all scheduled touches
// are sales artifacts). Returns the closed ones for the report.
function closePending(followUps, now) {
  const closed = [];
  const updated = (Array.isArray(followUps) ? followUps : []).map((f) => {
    if (f && !f.done) {
      closed.push(describeFU(f));
      return { ...f, done: true, doneAt: now };
    }
    return f;
  });
  return { updated, closed };
}

async function clearBillingEscalations(leadId, atTs) {
  const rows = await runQuery({
    from: [{ collectionId: 'messages' }],
    where: {
      compositeFilter: {
        op: 'AND',
        filters: [
          { fieldFilter: { field: { fieldPath: 'leadId' }, op: 'EQUAL', value: { stringValue: leadId } } },
          { fieldFilter: { field: { fieldPath: 'kind' }, op: 'EQUAL', value: { stringValue: 'billing_escalation' } } },
          { fieldFilter: { field: { fieldPath: 'handled' }, op: 'EQUAL', value: { booleanValue: false } } },
        ],
      },
    },
  });
  let cleared = 0;
  for (const r of rows) {
    if (dec((r.document.fields || {}).deletedAt)) continue;
    await patchDoc(r.document.name.split('/documents/')[1], {
      handled: true,
      handledAt: atTs,
      handledBy: 'Square sync',
      updatedAt: Date.now(),
    });
    cleared++;
  }
  return cleared;
}

// === 1-4: the four Square-charge leads ==========================================
for (const fix of FIXES) {
  console.log(`\n=== ${fix.name} (TVC #${fix.tvc}) ===`);
  const [payment, d] = await Promise.all([
    fetchPayment(fix.paymentId),
    loadLead(fix.leadId, fix.tvc, fix.name, { restoreIfDeleted: fix.restoreIfDeleted }),
  ]);
  const wasDeleted = Boolean(d.deletedAt);
  if (wasDeleted) console.log(`  !! lead was soft-deleted at ${fmtCT(d.deletedAt)} — restoring`);
  if (payment.status !== 'COMPLETED') throw new Error(`payment ${fix.paymentId} status ${payment.status}`);
  const cents = payment.amount_money?.amount ?? 0;
  if (cents !== fix.expectCents) throw new Error(`payment ${fix.paymentId} ${cents}¢ ≠ expected ${fix.expectCents}¢`);
  const dollars = cents / 100;
  const amountLabel = fmtDollars(cents);
  const paidTs = new Date(payment.created_at).getTime();
  const note = (payment.note ?? '').trim();
  console.log(`  payment ${fix.paymentId} — ${amountLabel} COMPLETED ${fmtCT(paidTs)}, note "${note}"`);

  const attempts = Array.isArray(d.contactAttempts) ? d.contactAttempts : [];
  if (attempts.some((a) => a?.paymentId === fix.paymentId || (a?.notes ?? '').includes(fix.paymentId))) {
    console.log('  SKIP — payment already logged on this lead');
    continue;
  }
  const now = Date.now();
  const before = `stage=${d.stage}, saleStatus=${d.saleStatus ?? 'none'}`;

  let notes = `Square payment received — ${amountLabel} (payment ${fix.paymentId}) — matched by payment note "${note}"`;
  if (fix.extraNote) notes += ` — ${fix.extraNote}`;
  else notes += ' — reconciled by 2026-07-24 QA (retained client chased as prospect)';

  const { updated: followUps, closed } = closePending(d.followUps, now);
  const patch = {
    updatedAt: now,
    contactAttempts: [
      ...attempts,
      { ts: paidTs, outcome: 'retained', via: 'square', notes, by: 'Square sync', paymentId: fix.paymentId },
    ],
    squarePaidTotal: (d.squarePaidTotal ?? 0) + dollars,
    saleStatusAt: paidTs,
    saleEscalatedAt: null,
    salePursuitAlertAt: null,
    planStallFlaggedAt: null,
    followUps,
  };
  if (wasDeleted) patch.deletedAt = null;
  if (fix.setSaleAmount && !d.saleAmount) patch.saleAmount = fix.setSaleAmount;

  let after;
  if (fix.expect === 'full') {
    patch.saleStatus = 'paid_full';
    if (d.stage !== 'intake_complete' && d.stage !== 'financed') {
      const day = new Date(paidTs).toLocaleDateString('en-US', { month: 'short', day: 'numeric', ...CT });
      patch.stage = 'intake_complete';
      patch.intakeComplete = true;
      patch.intakeCompleteAt = paidTs;
      patch.retainedAt = d.retainedAt ?? paidTs;
      patch.autoStageNote = `Stage moved to Intake Complete by Square sync — ${amountLabel} payment received on ${day}`;
      patch.autoStageAt = now;
    }
    after = `stage=${patch.stage ?? d.stage}, saleStatus=paid_full`;
  } else {
    // Mirror syncSquare's paid_partial handling: sale fields + attempt only,
    // stage untouched (the billing/receivables treatment owns partials).
    patch.saleStatus = 'paid_partial';
    after = `stage=${d.stage} (unchanged), saleStatus=paid_partial`;
  }

  await patchDoc(`leads/${fix.leadId}`, patch);
  await patchDoc(`squarePayments/${fix.paymentId}`, {
    processedAt: now,
    action: 'matched',
    leadId: fix.leadId,
    matchedBy: 'note',
    amountCents: cents,
    matcherVersion: MATCHER_VERSION,
    reconciledBy: 'fixRetainedClients-2026-07-24 — QA: retained client chased as prospect',
    reconciledAt: now,
  }, { mustExist: false });
  const escalations = await clearBillingEscalations(fix.leadId, paidTs);
  report.push({
    name: fix.name, before, after,
    followUpsClosed: closed,
    marker: `squarePayments/${fix.paymentId} → matched (was unmatched/absent)`,
    extra:
      `squarePaidTotal ${patch.squarePaidTotal}` +
      `${patch.saleAmount ? `, saleAmount set to ${patch.saleAmount}` : ''}` +
      `${escalations ? `, ${escalations} billing escalation(s) stood down` : ''}` +
      `${wasDeleted ? `, RESTORED from soft-delete (was deleted ${fmtCT(d.deletedAt)})` : ''}`,
  });
  console.log(`  ${before} → ${after}; follow-ups closed: ${closed.length}`);
}

// === 5: Adam Blake Holden — retained per Gmail, no identifiable charge ==========
{
  console.log(`\n=== ${ADAM.name} (TVC #${ADAM.tvc}) ===`);
  const d = await loadLead(ADAM.leadId, ADAM.tvc, ADAM.name);
  const now = Date.now();
  const before = `stage=${d.stage}, saleStatus=${d.saleStatus ?? 'none'}`;
  const attempts = Array.isArray(d.contactAttempts) ? d.contactAttempts : [];
  const already = attempts.some((a) => (a?.notes ?? '').includes('retention notice'));
  const { updated: followUps, closed } = closePending(d.followUps, now);
  const patch = {
    updatedAt: now,
    stage: 'intake_complete',
    intakeComplete: true,
    intakeCompleteAt: ADAM_RETAINED_AT,
    retainedAt: d.retainedAt ?? ADAM_RETAINED_AT,
    saleStatus: 'paid_full',
    saleStatusAt: ADAM_RETAINED_AT,
    saleEscalatedAt: null,
    salePursuitAlertAt: null,
    followUps,
    autoStageNote:
      'Stage moved to Intake Complete by QA reconciliation — firm retention notice to TVC Jul 14, 2026',
    autoStageAt: now,
    // No Square charge is identifiable for him — stamp the verify guard so the
    // transcript-vs-Square pass doesn't raise a false "no charge found" alarm.
    squareVerifyFlaggedAt: now,
  };
  if (!already) {
    patch.contactAttempts = [
      ...attempts,
      {
        ts: ADAM_RETAINED_AT,
        outcome: 'retained',
        notes:
          'Retained — per Gmail, the firm sent TVC a retention notice on Jul 14, 2026 ' +
          '("This member has retained our services"; Entry/Waiver/Plea filed Jul 14). ' +
          'Payment rail unknown — no identifiable Square charge; possibly one of the ' +
          'anonymous $1,125 charges. Reconciled by 2026-07-24 QA.',
        by: 'QA reconciliation',
      },
    ];
  }
  await patchDoc(`leads/${ADAM.leadId}`, patch);
  const escalations = await clearBillingEscalations(ADAM.leadId, ADAM_RETAINED_AT);
  report.push({
    name: ADAM.name, before,
    after: 'stage=intake_complete, saleStatus=paid_full (squarePaidTotal untouched, squareVerifyFlaggedAt stamped)',
    followUpsClosed: closed,
    marker: 'no Square marker (no identifiable charge)',
    extra: escalations ? `${escalations} billing escalation(s) stood down` : '',
  });
  console.log(`  ${before} → intake_complete/paid_full; follow-ups closed: ${closed.length}`);
}

// === 6: Parmjeet Singh — retained, but the Jul 17 charge stays a human call =====
{
  console.log(`\n=== ${PARMJEET.name} (TVC #${PARMJEET.tvc}) ===`);
  const d = await loadLead(PARMJEET.leadId, PARMJEET.tvc, PARMJEET.name);
  const now = Date.now();
  const { updated: followUps, closed } = closePending(d.followUps, now);
  // Stop the chase (he IS retained) without moving stage or crediting money:
  // possibleExistingClientAt is the cadence sweep's pause flag — clearing it
  // (or marking the sale) resumes normal flow once a human resolves the charge.
  await patchDoc(`leads/${PARMJEET.leadId}`, {
    updatedAt: now,
    followUps,
    possibleExistingClientAt: d.possibleExistingClientAt ?? now,
  });

  // The ambiguity post-it: the original (on Dessie's lead) was dismissed on
  // Jul 22 with the $1,125 still credited to NOBODY (Dessie is paid_full with
  // squarePaidTotal empty; the pi7shqJ6… marker is still 'unmatched'). Update
  // it if an open one exists, otherwise re-raise it with the retention notice.
  const payment = await fetchPayment(AMBIGUOUS_PAYMENT);
  const ambTs = new Date(payment.created_at).getTime();
  const message =
    `A $1,125 Square charge (${AMBIGUOUS_PAYMENT}) was keyed ${fmtCT(ambTs)} mid-call with ` +
    `Dessie Ashenafi Assmamaw, but its note reads "Parmjeet Singh Retainer Fee" — and both are real clients.\n` +
    `NEW EVIDENCE (Jul 24 QA): the firm sent TVC a retention notice for Parmjeet Singh on Jul 17, so ` +
    `Parmjeet IS retained — the open question is only whether the Jul 17 charge was HIS payment or ` +
    `Dessie's. Resolve whose money it was and mark the other's collection outstanding ` +
    `(Dessie is marked paid in full with no Square charge credited; Parmjeet has no payment on file either).`;
  const open = await runQuery({
    from: [{ collectionId: 'messages' }],
    where: {
      compositeFilter: {
        op: 'AND',
        filters: [
          { fieldFilter: { field: { fieldPath: 'squarePaymentId' }, op: 'EQUAL', value: { stringValue: AMBIGUOUS_PAYMENT } } },
          { fieldFilter: { field: { fieldPath: 'handled' }, op: 'EQUAL', value: { booleanValue: false } } },
        ],
      },
    },
  });
  const openLive = open.filter((r) => !dec((r.document.fields || {}).deletedAt));
  let postItAction;
  if (openLive.length) {
    await patchDoc(openLive[0].document.name.split('/documents/')[1], { message, updatedAt: now });
    postItAction = 'existing open ambiguity post-it UPDATED with the retention notice';
  } else {
    await addDoc('messages', {
      kind: 'billing_escalation',
      source: 'system',
      from: 'Square Sync',
      fromName: 'Square Sync',
      subject: 'Whose $1,125? Parmjeet Singh (retained Jul 17) vs Dessie — resolve the Jul 17 charge',
      message,
      tvcCaseNumber: PARMJEET.tvc,
      memberName: 'Parmjeet Singh / Dessie Ashenafi Assmamaw',
      leadId: PARMJEET.leadId,
      phone: d.phone ?? null,
      email: d.email ?? null,
      nonPaymentReason: null,
      noPursuit: false,
      gmailMessageId: null,
      squarePaymentId: AMBIGUOUS_PAYMENT,
      receivedAt: ambTs,
      handled: false,
      createdAt: now,
      updatedAt: now,
    });
    postItAction = 'ambiguity post-it re-raised (original was dismissed Jul 22 with the money still uncredited)';
  }
  report.push({
    name: PARMJEET.name,
    before: `stage=${d.stage}, saleStatus=${d.saleStatus ?? 'none'}`,
    after: `stage=${d.stage} (unchanged — no money credited), chase paused via possibleExistingClientAt`,
    followUpsClosed: closed,
    marker: `squarePayments/${AMBIGUOUS_PAYMENT} untouched (stays unmatched, human call)`,
    extra: postItAction,
  });
  console.log(`  follow-ups closed: ${closed.length}; ${postItAction}`);
}

// === Report =====================================================================
console.log('\n================= PER-LEAD REPORT =================');
for (const r of report) {
  console.log(`\n${r.name}`);
  console.log(`  before: ${r.before}`);
  console.log(`  after:  ${r.after}`);
  console.log(`  follow-ups closed (${r.followUpsClosed.length}):`);
  r.followUpsClosed.forEach((f) => console.log(`    - ${f}`));
  console.log(`  marker: ${r.marker}`);
  if (r.extra) console.log(`  extra:  ${r.extra}`);
}
console.log(DRY ? '\n(DRY RUN — nothing written)' : '\nDone.');
