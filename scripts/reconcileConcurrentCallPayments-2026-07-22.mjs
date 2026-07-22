// One-time re-evaluation of unmatched Square payment markers with the
// upgraded matcher (2026-07-22): phone → email → CONCURRENT CALLRAIL CALL
// (new) → note text → exact unique name.
//
// Re-runs every squarePayments marker whose action is 'unmatched' or
// 'ignored_unrelated'. Any payment that now matches is reconciled exactly the
// way syncSquare would (contact attempt with provenance, squarePaidTotal,
// paid_partial/paid_full vs saleAmount, stage → intake_complete only when
// paid full, never a downgrade), the marker flips to action 'matched' with a
// reconciledBy stamp, and any open "Unmatched Square payment" post-it for it
// is marked handled.
//
// GUARD: payment pi7shqJ6… (note "Parmjeet Singh Retainer Fee", keyed during
// Dessie's call) must NEVER auto-match — the note-names-another-lead conflict
// keeps it manual, and a hard assert backs that up.
//
// Run with DRY=1 first to preview without writing.
import { execSync } from 'node:child_process';

const PROJECT = 'tvchub-f2401';
const ROOT = `https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/(default)`;
const BASE = `${ROOT}/documents`;
const DRY = process.env.DRY === '1';
const AMBIGUOUS_PREFIX = 'pi7shqJ6';
// The known never-entered payers — expected to STILL not match.
const EXPECT_NO_MATCH = [
  'Assefa Abate', 'Mirza Saralidze', 'Abdinoor Hamud', 'Bienvenue Izandwairia',
  'Pedro Gonzalez', 'Karandeep Singh', 'Roger Lawson',
];

const fsToken = execSync('gcloud auth print-access-token').toString().trim();
const sqToken = execSync(
  `npx firebase functions:secrets:access SQUARE_ACCESS_TOKEN --project ${PROJECT}`,
).toString().trim().split('\n').pop().trim();
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

// --- Firestore value codecs ----------------------------------------------------
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
async function listCollection(collectionId) {
  const docs = [];
  let pageToken = '';
  do {
    const url = `${BASE}/${collectionId}?pageSize=300${pageToken ? `&pageToken=${pageToken}` : ''}`;
    const res = await fetch(url, { headers: fsHeaders });
    if (!res.ok) throw new Error(`list ${collectionId} ${res.status}: ${await res.text()}`);
    const json = await res.json();
    (json.documents || []).forEach((d) => docs.push({ id: d.name.split('/').pop(), f: d.fields || {} }));
    pageToken = json.nextPageToken || '';
  } while (pageToken);
  return docs;
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

// --- Normalizers (mirror squaresync.ts exactly) ----------------------------------
const lc = (s) => String(s ?? '').toLowerCase().trim();
const last10 = (s) => String(s ?? '').replace(/\D/g, '').slice(-10);
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
function nameTokens(name) {
  const parts = normalizeText(name).split(' ').filter(Boolean);
  if (!parts.length) return [];
  return [...new Set([parts[0], parts[parts.length - 1]])].filter((t) => t.length >= 4);
}
// Payment-note vocabulary (mirrors squaresync.ts) — leftover words after
// stripping these and numbers are very likely a person's name.
const PAYMENT_VOCAB = new Set([
  'retainer', 'payment', 'payments', 'pymt', 'pmt', 'fee', 'fees', 'trial',
  'balance', 'owes', 'owe', 'due', 'paid', 'pay', 'pays', 'final', 'last',
  'first', 'second', 'third', 'half', 'full', 'remaining', 'rest',
  'partial', 'deposit', 'down', 'court', 'case', 'ticket', 'tvc', 'llc',
  'law', 'firm', 'initial', 'installment', 'installments', 'plan', 'left',
  'total', 'amount', 'charge', 'charged', 'card', 'visa', 'mastercard',
  'amex', 'discover', 'cash', 'check', 'invoice', 'received', 'covers',
  'covered', 'of', 'the', 'for', 'and', 'per', 'via', 'on', 'in', 'to',
  'a', 'an', 'no', 'off', 'with', 'from', 'by', 'usd',
]);
function noteNamesSomeoneElse(noteNorm, leadName) {
  if (!noteNorm) return false;
  const leadParts = new Set(normalizeText(leadName).split(' ').filter(Boolean));
  return noteNorm
    .split(' ')
    .some((t) => t.length >= 2 && !/^\d+$/.test(t) && !PAYMENT_VOCAB.has(t) && !leadParts.has(t));
}
const AMOUNT_TOLERANCE = 5; // dollars
const CALL_GRACE_MS = 30 * 60_000;
const CALL_DEFAULT_WINDOW_MS = 90 * 60_000;
const CT = { timeZone: 'America/Chicago' };
const fmtCT = (ts) => new Date(ts).toLocaleString('en-US', { ...CT, timeZoneName: 'short' });
const fmtDollars = (cents) => `$${(cents / 100).toFixed(2)}`;

// --- Load markers needing re-evaluation ------------------------------------------
const markers = (await listCollection('squarePayments')).filter((m) => {
  const action = dec(m.f.action);
  return action === 'unmatched' || action === 'ignored_unrelated';
});
console.log(`Markers to re-evaluate: ${markers.length}\n`);

// --- Load Square payments (window covers the 60-day backfill) --------------------
const payments = [];
let cursor = '';
do {
  const url =
    'https://connect.squareup.com/v2/payments?location_id=LPK9GY4PHM28J' +
    '&begin_time=2026-05-01T00:00:00Z&sort_order=ASC&limit=100' +
    (cursor ? `&cursor=${encodeURIComponent(cursor)}` : '');
  const res = await fetch(url, { headers: sqHeaders });
  if (!res.ok) throw new Error(`Square payments ${res.status}: ${await res.text()}`);
  const json = await res.json();
  payments.push(...(json.payments || []));
  cursor = json.cursor || '';
} while (cursor);
const paymentById = new Map(payments.map((p) => [p.id, p]));
console.log(`Square payments loaded since May 1: ${payments.length}\n`);

const customerCache = new Map();
async function fetchCustomer(id) {
  if (customerCache.has(id)) return customerCache.get(id);
  const res = await fetch(`https://connect.squareup.com/v2/customers/${id}`, { headers: sqHeaders });
  const c = res.ok ? (await res.json()).customer ?? null : null;
  customerCache.set(id, c);
  return c;
}

// --- Load all leads and build the matcher indexes --------------------------------
const leadDocs = await listCollection('leads');
const liveLeads = leadDocs.filter((l) => !dec(l.f.deletedAt));
console.log(`Leads loaded: ${leadDocs.length} (${liveLeads.length} live)\n`);

const byPhone = new Map();
const byEmail = new Map();
const byName = new Map();
const noteNameIndex = [];
const callIntervals = []; // { start, end, lead, saleAmount, aiPaid }
// Newest lead wins shared phone/email — leads list from Firestore isn't
// createdAt-ordered, so sort first (mirrors the sync's orderBy createdAt desc).
liveLeads.sort((a, b) => (dec(b.f.createdAt) ?? 0) - (dec(a.f.createdAt) ?? 0));
for (const l of liveLeads) {
  const name = dec(l.f.name);
  const lead = { id: l.id, name };
  for (const p of [dec(l.f.phone), dec(l.f.altPhone)]) {
    const key = last10(p);
    if (key.length === 10 && !byPhone.has(key)) byPhone.set(key, lead);
  }
  const email = lc(dec(l.f.email));
  if (email && !byEmail.has(email)) byEmail.set(email, lead);
  const nm = lc(name);
  if (nm) byName.set(nm, [...(byName.get(nm) ?? []), lead]);
  const needles = nameNeedles(name);
  if (needles.length) noteNameIndex.push({ needles, lead });
  const saleAmount = dec(l.f.saleAmount);
  const sa = typeof saleAmount === 'number' && saleAmount > 0 ? saleAmount : null;
  for (const a of dec(l.f.contactAttempts) || []) {
    if (a?.via !== 'callrail' || typeof a.ts !== 'number') continue;
    const durMs = typeof a.durationSec === 'number' && a.durationSec > 0 ? a.durationSec * 1000 : null;
    const end = durMs !== null ? a.ts + durMs + CALL_GRACE_MS : a.ts + CALL_DEFAULT_WINDOW_MS;
    const strictEnd = durMs !== null ? a.ts + durMs : null;
    const aiPaid = a.ai?.saleStatus === 'paid_full' || a.ai?.saleStatus === 'paid_partial';
    callIntervals.push({ start: a.ts, end, strictEnd, lead, saleAmount: sa, aiPaid });
  }
}
// Mutable decoded lead state — patches are applied here after each write so a
// SECOND payment landing on the same lead in this run accumulates instead of
// overwriting the first (contactAttempts, squarePaidTotal).
const leadState = new Map(
  liveLeads.map((l) => [
    l.id,
    Object.fromEntries(Object.entries(l.f).map(([k, v]) => [k, dec(v)])),
  ]),
);

// --- The matcher (mirrors the upgraded syncSquare order) --------------------------
async function matchPayment(payment) {
  const cents = payment.amount_money?.amount ?? 0;
  const dollars = cents / 100;
  const paidTs = new Date(payment.created_at).getTime();
  let payerName = null, payerEmail = null, payerPhone = null;
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

  const noteNamedLeads = new Map();
  if (noteText) {
    const hay = ` ${normalizeText(noteText)} `;
    for (const entry of noteNameIndex) {
      if (entry.needles.some((n) => hay.includes(` ${n} `))) noteNamedLeads.set(entry.lead.id, entry.lead);
    }
  }

  const phoneKey = last10(payerPhone);
  if (phoneKey.length === 10 && byPhone.has(phoneKey)) {
    return { lead: byPhone.get(phoneKey), matchedBy: 'phone', detail: null };
  }
  if (payerEmail && byEmail.has(lc(payerEmail))) {
    return { lead: byEmail.get(lc(payerEmail)), matchedBy: 'email', detail: null };
  }

  // CONCURRENT CALL
  let hits = new Map();
  for (const iv of callIntervals) {
    if (paidTs >= iv.start && paidTs <= iv.end) {
      const prev = hits.get(iv.lead.id);
      if (!prev || (iv.aiPaid && !prev.aiPaid)) hits.set(iv.lead.id, iv);
    }
  }
  // Mid-call (inside recorded duration) beats grace-window-only candidates.
  if (hits.size > 1) {
    const strict = new Map(
      [...hits].filter(([, iv]) => iv.strictEnd !== null && paidTs >= iv.start && paidTs <= iv.strictEnd),
    );
    if (strict.size === 1) hits = strict;
  }
  const candidates = [...hits.values()].map((h) => h.lead.name);
  if (hits.size === 1) {
    const hit = [...hits.values()][0];
    const noteNorm = normalizeText(noteText);
    const payerNorm = normalizeText(payerName);
    const namedLeads = new Map(noteNamedLeads);
    if (payerNorm) {
      const payerHay = ` ${payerNorm} `;
      for (const entry of noteNameIndex) {
        if (entry.needles.some((n) => payerHay.includes(` ${n} `))) namedLeads.set(entry.lead.id, entry.lead);
      }
    }
    if (namedLeads.size > 0 && !namedLeads.has(hit.lead.id)) {
      const others = [...namedLeads.values()].map((l) => l.name).join(', ');
      return {
        lead: null,
        conflict: `note/customer identifies ${others} but the concurrent call was with ${hit.lead.name}`,
        candidates,
      };
    }
    if (
      namedLeads.size === 0 &&
      (noteNamesSomeoneElse(noteNorm, hit.lead.name) || noteNamesSomeoneElse(payerNorm, hit.lead.name))
    ) {
      return {
        lead: null,
        candidates,
        stranger: `note "${noteText ?? ''}" / customer "${payerName ?? ''}" names someone who isn't a lead — not ${hit.lead.name}`,
      };
    }
    let why = null;
    const hay = ` ${noteNorm} ${payerNorm} `;
    const token = nameTokens(hit.lead.name).find((t) => hay.includes(` ${t} `));
    if (token) why = `payment note contains "${token}" from the lead's name`;
    else if (hit.saleAmount === null) why = 'lead has no recorded fee yet, amount unconstrained';
    else if (Math.abs(dollars - hit.saleAmount) <= AMOUNT_TOLERANCE) why = `amount matches the lead's $${hit.saleAmount} fee`;
    else if (Math.abs(dollars * 2 - hit.saleAmount) <= AMOUNT_TOLERANCE) why = `amount is half of the lead's $${hit.saleAmount} fee`;
    else if (hit.aiPaid) why = "the call's transcript analysis says payment was collected on the call";
    if (why) {
      const mins = Math.max(0, Math.round((paidTs - hit.start) / 60_000));
      return {
        lead: hit.lead,
        matchedBy: 'concurrent_call',
        detail: `charge keyed ${mins}m into/after this lead's CallRail call; corroborated — ${why}`,
        candidates,
      };
    }
    return { lead: null, candidates, uncorroborated: hit.lead.name };
  }

  if (noteNamedLeads.size === 1) {
    return { lead: [...noteNamedLeads.values()][0], matchedBy: 'note', detail: null, candidates };
  }
  for (const candidate of [payerName, noteText]) {
    const key = lc(candidate);
    if (!key) continue;
    const nameHits = byName.get(key);
    if (nameHits && nameHits.length === 1) {
      return { lead: nameHits[0], matchedBy: 'name', detail: null, candidates };
    }
  }
  return { lead: null, candidates };
}

// --- Reconcile one payment onto one lead, the way syncSquare would ----------------
async function reconcile(payment, lead, matchedBy, detail) {
  const d = leadState.get(lead.id);
  const cents = payment.amount_money?.amount ?? 0;
  const dollars = cents / 100;
  const amountLabel = fmtDollars(cents);
  const paidTs = new Date(payment.created_at).getTime();
  const attempts = Array.isArray(d.contactAttempts) ? d.contactAttempts : [];
  const now = Date.now();

  const alreadyLogged = attempts.some(
    (a) => a?.paymentId === payment.id || (a?.notes ?? '').includes(payment.id),
  );

  let notes = `Square payment received — ${amountLabel} (payment ${payment.id})`;
  if (matchedBy === 'concurrent_call' && detail) {
    notes += ` — matched by concurrent call: ${detail}`;
    if (payment.note) notes += ` (payment note: "${String(payment.note).trim()}")`;
  }
  if (matchedBy === 'note') {
    notes += ` — matched by payment note "${String(payment.note ?? '').trim()}"`;
    const call = attempts.find(
      (a) => a?.via === 'callrail' && typeof a.ts === 'number' && paidTs > a.ts && paidTs <= a.ts + 3 * 3600_000,
    );
    if (call) {
      const mins = Math.max(1, Math.round((paidTs - call.ts) / 60_000));
      notes += `; corroborated — charge landed ${mins}m after a CallRail call on this lead`;
    }
  }
  notes += ' (reconciled by 2026-07-22 concurrent-call history re-run)';

  const patch = { updatedAt: now };
  if (!alreadyLogged) {
    patch.contactAttempts = [
      ...attempts,
      { ts: paidTs, outcome: 'retained', via: 'square', notes, by: 'Square sync', paymentId: payment.id },
    ];
  }
  const paidTotal = (d.squarePaidTotal ?? 0) + dollars;
  patch.squarePaidTotal = paidTotal;
  const saleAmount = typeof d.saleAmount === 'number' ? d.saleAmount : null;
  const coversFee = !saleAmount || dollars >= saleAmount || paidTotal >= saleAmount;
  const alreadyPaidFull = d.saleStatus === 'paid_full'; // never downgrade

  let action;
  if (coversFee || alreadyPaidFull) {
    patch.saleStatus = 'paid_full';
    if (!alreadyPaidFull) patch.saleStatusAt = paidTs;
    patch.saleEscalatedAt = null;
    patch.salePursuitAlertAt = null;
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
    patch.saleStatusAt = paidTs;
    patch.saleEscalatedAt = null;
    patch.salePursuitAlertAt = null;
    action = 'paid_partial';
  }

  await patchDoc(`leads/${lead.id}`, patch);
  Object.assign(d, patch); // keep in-memory state current for this run
  await patchDoc(`squarePayments/${payment.id}`, {
    action: 'matched',
    leadId: lead.id,
    matchedBy,
    amountCents: cents,
    reconciledBy: 'reconcileConcurrentCallPayments-2026-07-22 — history re-run with concurrent-call matcher',
    reconciledAt: now,
    updatedAt: now,
  });
  return { action, paidTotal, amountLabel, paidTs };
}

// --- Open unmatched-payment post-its (to close on match) --------------------------
const openPostIts = (
  await runQuery({
    from: [{ collectionId: 'messages' }],
    where: { fieldFilter: { field: { fieldPath: 'from' }, op: 'EQUAL', value: { stringValue: 'Square Sync' } } },
  })
).filter((r) => {
  const f = r.document.fields || {};
  return (
    !dec(f.deletedAt) && dec(f.handled) === false &&
    (dec(f.subject) || '').startsWith('Unmatched Square payment')
  );
});
console.log(`Open unmatched-payment post-its: ${openPostIts.length}\n`);

// --- Main loop --------------------------------------------------------------------
const newlyMatched = [];
const stillUnmatched = [];
for (const m of markers) {
  const payment = paymentById.get(m.id);
  const payerLabel =
    dec(m.f.payerName) || (paymentById.get(m.id)?.note ?? '').trim() || '(no payer info)';
  if (!payment) {
    stillUnmatched.push(`${m.id.slice(0, 10)}… ${fmtDollars(dec(m.f.amountCents) ?? 0)} · ${payerLabel} — payment not in Square window, skipped`);
    continue;
  }
  const cents = payment.amount_money?.amount ?? 0;
  const result = await matchPayment(payment);

  if (result.lead && payment.id.startsWith(AMBIGUOUS_PREFIX)) {
    throw new Error(
      `GUARD VIOLATED: ambiguous payment ${payment.id} ("Parmjeet Singh" note / Dessie call) ` +
      `would have auto-matched to ${result.lead.name} via ${result.matchedBy} — aborting`,
    );
  }

  if (!result.lead) {
    const why = result.conflict
      ? `CONFLICT (${result.conflict}) — stays manual`
      : result.stranger
        ? `STRANGER VETO (${result.stranger})`
        : result.uncorroborated
          ? `single concurrent call with ${result.uncorroborated} but NO corroboration`
          : result.candidates?.length > 1
            ? `multiple concurrent-call candidates: ${result.candidates.join(', ')}`
            : 'no identity source matched';
    stillUnmatched.push(`${payment.id.slice(0, 10)}… ${fmtDollars(cents)} · note "${(payment.note ?? '').trim()}" · ${why}`);
    continue;
  }

  const r = await reconcile(payment, result.lead, result.matchedBy, result.detail);
  console.log(
    `MATCHED ${payment.id.slice(0, 10)}… ${r.amountLabel} → ${result.lead.name} ` +
    `[${result.matchedBy}] ${fmtCT(r.paidTs)} → ${r.action}, squarePaidTotal ${r.paidTotal}` +
    (result.detail ? `\n        ${result.detail}` : ''),
  );
  newlyMatched.push({ name: result.lead.name, amountLabel: r.amountLabel, paymentId: payment.id, matchedBy: result.matchedBy, action: r.action });

  const postIt = openPostIts.find((p) => dec(p.document.fields?.squarePaymentId) === payment.id);
  if (postIt) {
    await patchDoc(postIt.document.name.split('/documents/')[1], {
      handled: true,
      handledAt: Date.now(),
      handledBy: 'Square sync — concurrent-call matched & reconciled',
      updatedAt: Date.now(),
    });
    console.log('        post-it closed');
  }
}

// --- Summary ------------------------------------------------------------------------
console.log('\n=== SUMMARY ===');
console.log(`\nNewly matched (${newlyMatched.length}):`);
newlyMatched.forEach((x) => console.log(`  - ${x.name} ← ${x.amountLabel} (${x.paymentId.slice(0, 10)}…) via ${x.matchedBy} → ${x.action}`));
console.log(`\nStill unmatched (${stillUnmatched.length}):`);
stillUnmatched.forEach((x) => console.log(`  - ${x}`));

console.log('\nExpected-no-match check (never-entered payers):');
const matchedIds = new Set(newlyMatched.map((x) => x.paymentId));
for (const name of EXPECT_NO_MATCH) {
  const norm = normalizeText(name);
  const theirPayments = markers
    .filter((m) => paymentById.has(m.id))
    .filter((m) => {
      const p = paymentById.get(m.id);
      const hay = normalizeText(`${p.note ?? ''} ${dec(m.f.payerName) ?? ''}`);
      return hay.includes(norm) || nameTokens(name).every((t) => ` ${hay} `.includes(` ${t} `));
    })
    .map((m) => paymentById.get(m.id));
  if (!theirPayments.length) {
    console.log(`  ?? no marker payment found for — ${name}`);
    continue;
  }
  const wrongly = theirPayments.filter((p) => matchedIds.has(p.id));
  if (wrongly.length) {
    console.log(`  !! MATCHED (unexpected) — ${name}: ${wrongly.map((p) => p.id.slice(0, 10)).join(', ')}`);
  } else {
    console.log(`  OK still unmatched — ${name} (${theirPayments.length} payment(s))`);
  }
}
console.log(DRY ? '\n(DRY RUN — nothing written)' : '\nDone.');
