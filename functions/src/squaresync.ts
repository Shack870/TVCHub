import { onSchedule } from "firebase-functions/v2/scheduler";
import { defineSecret } from "firebase-functions/params";
import { logger } from "firebase-functions/v2";
import { getFirestore } from "firebase-admin/firestore";
import { stampHeartbeat } from "./heartbeat.js";

// Square → TVCHub payments sync.
//
// Every 15 minutes this pulls COMPLETED payments from the Square production
// account (Iron Rock Law Firm) and reconciles them against leads:
//   - a payment matching a lead (phone → email → a concurrent CallRail call
//     with corroboration → unique name in the payment note → unique full name
//     on the customer record) appends a
//     "retained" contact attempt, rolls the money up onto the lead's sale
//     fields (paid_full / paid_partial with a running squarePaidTotal), moves
//     paid-in-full leads to intake_complete, and clears any open
//     billing-escalation post-its — the money arrived, stand the alarm down.
//   - a payment matching nobody is ignored SILENTLY (marker doc only). The
//     Square account also takes general law-firm charges and payments from
//     clients who never came through the app, so unmatched money is not the
//     app's business — no matter the amount or timing. The ONE exception:
//     ambiguous identity that a human must untangle — a note/customer record
//     naming a DIFFERENT lead than the concurrent call's lead (the
//     Dessie/"Parmjeet Singh" case), or several leads on calls when the
//     charge was keyed with nothing else to pick between them. Those get a
//     manual-review post-it.
//
// A verification pass then runs the reconciliation in reverse: leads whose
// transcript claimed money was collected (saleStatus paid_full/paid_partial)
// but where no Square charge ever matched get a billing-escalation post-it —
// "the call says paid, the processor says nothing". Before alarming, the pass
// cross-references the matcher's own unattributed pool (unmatched markers and
// this run's uncredited payments, ±7 days of the claim): a charge naming the
// lead with a consistent amount is auto-credited instead of alarmed about,
// and an amount-only/partial candidate is NAMED in the alarm so a human can
// confirm-and-credit rather than hunt for money the sync already saw.
//
// An INVOICE pass follows: the office retains by Square invoice too
// ("Retainer Agreement - <name>", emailed). Each invoice's status is stamped
// onto its lead (squareInvoice) and unpaid invoices are chased with an
// Action Item post-it — see the pass itself for the full rules. The invoice
// pass NEVER credits money; the payment matcher above stays the one source
// of truth for dollars.
//
// Mirrors the CallRail/Email syncs' safety rules: marker docs
// (squarePayments/{paymentId}) make re-runs harmless, deleted leads are never
// touched, and a paid_full lead is never downgraded. Business dates come from
// the PAYMENT's created_at, not from when the sync got around to processing it.
//
// Markers are VERSIONED (matcherVersion): when the matcher itself improves,
// recent unmatched/ignored markers written by an older generation are
// re-evaluated once under the new one — see MATCHER_VERSION below.

const SQUARE_ACCESS_TOKEN = defineSecret("SQUARE_ACCESS_TOKEN");
const SQUARE = "https://connect.squareup.com/v2";
const SQUARE_VERSION = "2026-06-18";
const LOCATION_ID = "LPK9GY4PHM28J"; // Iron Rock Law Firm

// Matcher generation, stamped on every marker doc. Bump it whenever the
// matching logic learns a new trick: the sync re-evaluates recent
// unmatched/ignored markers whose stored matcherVersion is older, so matcher
// upgrades self-heal past decisions instead of freezing them (the July QA
// found five retained clients still chased as prospects because their
// markers were written by the pre-note-matcher sync and never looked at
// again). v2 = the note-name/exact-name matcher generation. v3 = TVC case
// numbers in the payment note / invoice title match leads directly — the one
// identity key that's unique, typo-resistant, and immune to name mishearing.
// v4 = the concurrent-call interval index only counts calls that were actual
// conversations: no-answer/voicemail attempts can no longer become concurrent
// candidates OR veto a note match (the Matthew Jones case — his $1,125 charge
// was refused because a NO-ANSWER call to Bohdan Tsymbalyuk "overlapped").
export const MATCHER_VERSION = 4;
// Only markers newer than this get the re-check — keeps runs cheap and
// acknowledges that stale-beyond-a-quarter money is a books problem, not a
// board problem.
const REEVAL_MAX_AGE_DAYS = 90;

const last10 = (s: unknown): string =>
  String(s ?? "").replace(/\D/g, "").slice(-10);
const lc = (s: unknown): string => String(s ?? "").toLowerCase().trim();
// Lowercase, punctuation stripped, whitespace collapsed — the shape both
// payment notes and lead names are reduced to before substring matching.
const normalizeText = (s: unknown): string =>
  lc(s).replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();

// Name variants a lead contributes to note-text searching: "first … last",
// "last … first" reversed, and first+last skipping middle names. Shared by
// the payment-note matcher's index and the verify pass's cross-reference
// scan. Length floor keeps junk like "Al Bo" from substring-matching notes.
export const nameNeedles = (name: unknown): string[] => {
  const normName = normalizeText(name);
  if (normName.length < 6) return [];
  const parts = normName.split(" ");
  const needles = new Set<string>([parts.join(" ")]);
  if (parts.length >= 2) {
    needles.add([...parts].reverse().join(" "));
    needles.add(`${parts[0]} ${parts[parts.length - 1]}`);
    needles.add(`${parts[parts.length - 1]} ${parts[0]}`);
  }
  return [...needles].filter((n) => n.length >= 6);
};

// Was this CallRail attempt an actual connected call? Only these belong in
// the concurrent-call interval index: a card payment keyed "mid-call" only
// makes sense during a call somebody ANSWERED. A no-answer/voicemail attempt
// must never become a concurrent-call candidate — nor veto someone else's
// note match (the Matthew Jones case: his charge, note naming him, was
// refused because a NO-ANSWER call to another lead happened to overlap).
// The transcript classifier's connection verdict is the best signal when it
// has one ('unclear' means it doesn't — fall back to the outcome, which the
// CallRail sync derives from the answered/voicemail flags).
export const isConnectedCallAttempt = (a: {
  outcome?: unknown;
  ai?: { connection?: unknown } | null;
}): boolean => {
  const conn = a.ai?.connection;
  if (conn === "conversation" || conn === "brief") return true;
  if (conn === "voicemail" || conn === "wrong_number") return false;
  return a.outcome !== "no_answer" && a.outcome !== "voicemail";
};

// Corroboration tolerance for amount checks (concurrent-call matcher and the
// verify pass's cross-reference scan).
const AMOUNT_TOLERANCE = 5; // dollars

// Verify-pass cross-reference: how strongly does an unattributed Square
// payment look like the charge a "transcript says paid" lead claims?
//   strong — the note/customer record names THIS lead and the amount is
//            consistent with the claim (equal / half of the fee, or the lead
//            has no recorded fee to constrain it) → safe to auto-credit.
//   weak   — amount matches but nothing names the lead, or the name matches
//            with an inconsistent amount → a human confirms, but the alarm
//            must SAY the candidate exists.
//   none   — nothing connects them.
export type VerifyCandidateStrength = "strong" | "weak" | "none";
export const classifyVerifyCandidate = (opts: {
  leadName: unknown;
  feeDollars: number | null; // the claimed/lead fee (saleAmount), if recorded
  paymentDollars: number;
  note?: string | null;
  payerName?: string | null;
}): VerifyCandidateStrength => {
  const needles = nameNeedles(opts.leadName);
  const hay = ` ${normalizeText(opts.note)} ${normalizeText(opts.payerName)} `;
  const nameHit = needles.some((n) => hay.includes(` ${n} `));
  const fee = opts.feeDollars;
  const amountMatches =
    fee !== null &&
    fee > 0 &&
    (Math.abs(opts.paymentDollars - fee) <= AMOUNT_TOLERANCE ||
      Math.abs(opts.paymentDollars * 2 - fee) <= AMOUNT_TOLERANCE);
  const amountConsistent = fee === null || fee <= 0 || amountMatches;
  if (nameHit && amountConsistent) return "strong";
  if (nameHit || amountMatches) return "weak";
  return "none";
};

export interface SqMoney {
  amount?: number; // smallest currency unit (cents for USD)
  currency?: string;
}

export interface SqPayment {
  id: string;
  status: string; // COMPLETED | APPROVED | PENDING | CANCELED | FAILED
  created_at: string;
  amount_money?: SqMoney;
  customer_id?: string;
  buyer_email_address?: string;
  note?: string;
}

interface SqCustomer {
  given_name?: string;
  family_name?: string;
  email_address?: string;
  phone_number?: string;
}

// --- Square INVOICES -----------------------------------------------------
// The office sends Square invoices for retainers ("Retainer Agreement -
// <name>", delivery EMAIL). The invoice pass below tracks their status onto
// leads and chases unpaid ones. Money itself stays the payments API's job —
// an invoice payment shows up there too, and the payment matcher is the one
// source of truth for crediting dollars.

export interface SqInvoiceRecipient {
  given_name?: string;
  family_name?: string;
  email_address?: string;
  phone_number?: string;
}

export interface SqInvoice {
  id: string;
  invoice_number?: string;
  title?: string;
  description?: string;
  // DRAFT | UNPAID | SCHEDULED | PARTIALLY_PAID | PAID | PARTIALLY_REFUNDED |
  // REFUNDED | CANCELED | FAILED | PAYMENT_PENDING
  status?: string;
  created_at?: string;
  updated_at?: string;
  public_url?: string;
  order_id?: string; // the paid order — corroborates payment matching
  primary_recipient?: SqInvoiceRecipient;
  payment_requests?: { computed_amount_money?: SqMoney }[];
}

export async function fetchInvoices(token: string): Promise<SqInvoice[]> {
  // Full list every run (the ListInvoices API has no updated-since filter and
  // the location carries a dozen or so). Marker docs keyed on status make the
  // re-walk cheap: an invoice is only re-processed when its status CHANGES.
  const invoices: SqInvoice[] = [];
  let cursor = "";
  do {
    const url =
      `${SQUARE}/invoices?location_id=${LOCATION_ID}&limit=100` +
      (cursor ? `&cursor=${encodeURIComponent(cursor)}` : "");
    const res = await fetch(url, { headers: sqHeaders(token) });
    if (!res.ok) throw new Error(`Square invoices ${res.status}: ${await res.text()}`);
    const json = (await res.json()) as { invoices?: SqInvoice[]; cursor?: string };
    invoices.push(...(json.invoices ?? []));
    cursor = json.cursor ?? "";
  } while (cursor);
  return invoices;
}

// UNPAID this long after being sent = chase it with a post-it.
const INVOICE_CHASE_AFTER_DAYS = 3;
// Terminal statuses that stand an invoice-chase post-it down.
const INVOICE_SETTLED_STATUSES = ["PAID", "REFUNDED", "PARTIALLY_REFUNDED", "CANCELED"];

function sqHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    "Square-Version": SQUARE_VERSION,
    "Content-Type": "application/json",
  };
}

// endTime is optional: the scheduled sync walks forward from beginTime to
// "now"; the askPostIt payment-search tool passes a bounded window.
export async function fetchPayments(
  token: string,
  beginTime: string,
  endTime?: string,
): Promise<SqPayment[]> {
  const payments: SqPayment[] = [];
  let cursor = "";
  do {
    const url =
      `${SQUARE}/payments?location_id=${LOCATION_ID}` +
      `&begin_time=${encodeURIComponent(beginTime)}` +
      (endTime ? `&end_time=${encodeURIComponent(endTime)}` : "") +
      `&sort_order=ASC&limit=100` +
      (cursor ? `&cursor=${encodeURIComponent(cursor)}` : "");
    const res = await fetch(url, { headers: sqHeaders(token) });
    if (!res.ok) throw new Error(`Square payments ${res.status}: ${await res.text()}`);
    const json = (await res.json()) as { payments?: SqPayment[]; cursor?: string };
    payments.push(...(json.payments ?? []));
    cursor = json.cursor ?? "";
  } while (cursor);
  return payments;
}

// Single-payment fetch, used by the marker re-evaluation pass for payments
// that fell out of the incremental sync window.
async function fetchPayment(token: string, id: string): Promise<SqPayment | null> {
  const res = await fetch(`${SQUARE}/payments/${id}`, { headers: sqHeaders(token) });
  if (!res.ok) {
    logger.warn(`Square payment ${id} lookup failed: ${res.status}`);
    return null;
  }
  const json = (await res.json()) as { payment?: SqPayment };
  return json.payment ?? null;
}

async function fetchCustomer(token: string, id: string): Promise<SqCustomer | null> {
  const res = await fetch(`${SQUARE}/customers/${id}`, { headers: sqHeaders(token) });
  if (!res.ok) {
    logger.warn(`Square customer ${id} lookup failed: ${res.status}`);
    return null;
  }
  const json = (await res.json()) as { customer?: SqCustomer };
  return json.customer ?? null;
}

const fmtDollars = (cents: number): string => `$${(cents / 100).toFixed(2)}`;

export const syncSquare = onSchedule(
  { schedule: "every 15 minutes", secrets: [SQUARE_ACCESS_TOKEN], timeoutSeconds: 300 },
  async () => {
    const db = getFirestore();
    const token = SQUARE_ACCESS_TOKEN.value();

    // Overlapping lookback window; payment markers make the overlap harmless.
    // First run reaches back 60 days to reconcile payment history.
    const stateRef = db.collection("syncState").doc("squareSync");
    const state = await stateRef.get();
    const lastSyncAt = (state.data()?.lastSyncAt as number) ?? Date.now() - 60 * 86400_000;
    const beginTime = new Date(lastSyncAt - 6 * 3600_000).toISOString();
    // Where Square visibility begins: the verification pass can't call out a
    // missing charge that predates the backfill window. Stamped once, on the
    // first run that computes it.
    const backfillStartAt =
      (state.data()?.backfillStartAt as number) ?? lastSyncAt - 60 * 86400_000;

    const payments = await fetchPayments(token, beginTime);
    const completed = payments.filter((p) => p.status === "COMPLETED");

    // --- Marker re-evaluation: self-healing after matcher upgrades ---------
    // Recent markers the matcher couldn't place under an OLDER generation get
    // one more look under the current one. reEvalExempt markers (the
    // Dessie/"Parmjeet Singh" ambiguous charge) are never re-run — those are
    // human calls by design. Whatever the outcome, the marker gets stamped
    // with the current matcherVersion, so each version bump re-checks each
    // marker exactly once.
    const reEvalIds = new Set<string>();
    {
      const staleSnap = await db
        .collection("squarePayments")
        .where("processedAt", ">", Date.now() - REEVAL_MAX_AGE_DAYS * 86400_000)
        .select("action", "matcherVersion", "reEvalExempt")
        .get();
      const inWindow = new Set(completed.map((p) => p.id));
      for (const m of staleSnap.docs) {
        const d = m.data();
        if (d.action !== "unmatched" && d.action !== "ignored_unrelated") continue;
        if (((d.matcherVersion as number) ?? 1) >= MATCHER_VERSION) continue;
        if (d.reEvalExempt) continue;
        reEvalIds.add(m.id);
        if (!inWindow.has(m.id)) {
          const p = await fetchPayment(token, m.id);
          if (p && p.status === "COMPLETED") completed.push(p);
          else reEvalIds.delete(m.id); // can't re-check what Square won't return
        }
      }
      if (reEvalIds.size) {
        logger.info("Re-evaluating stale payment markers under current matcher", {
          count: reEvalIds.size,
          matcherVersion: MATCHER_VERSION,
        });
      }
    }

    // Lead indexes over recent leads (covers the active board plus months of
    // history). Newest lead wins a shared phone/email; names must be unique
    // among leads to count as a match at all.
    const leadSnap = await db
      .collection("leads")
      .orderBy("createdAt", "desc")
      .limit(1000)
      .select("name", "phone", "altPhone", "email", "deletedAt")
      .get();
    type LeadRef = { id: string; name: string };
    const byPhone = new Map<string, LeadRef>();
    const byEmail = new Map<string, LeadRef>();
    const byName = new Map<string, LeadRef[]>();
    // TVC case number → lead. The strongest note-text key there is: unique
    // per case, and staff can type it without spelling anyone's name. Kept as
    // a list so a duplicate-lead pair sharing a number refuses to match.
    const byCaseNumber = new Map<string, LeadRef[]>();
    // Note-text identity: staff key cards manually, leaving the Square
    // customer blank — the client's name often lives ONLY in the payment's
    // free-text note ("Khup Sum Retainer Payment"). Each lead contributes
    // name variants ("first last", "last first", and first+last skipping
    // middle names) to search for inside normalized notes.
    const noteNameIndex: { needles: string[]; lead: LeadRef }[] = [];
    for (const doc of leadSnap.docs) {
      const d = doc.data();
      if (d.deletedAt) continue;
      const lead: LeadRef = { id: doc.id, name: d.name };
      for (const p of [d.phone, d.altPhone]) {
        const key = last10(p);
        if (key.length === 10 && !byPhone.has(key)) byPhone.set(key, lead);
      }
      const email = lc(d.email);
      if (email && !byEmail.has(email)) byEmail.set(email, lead);
      // TVC case numbers are 7 digits (~1.4–1.6M range); the strict length
      // keeps dollar figures like "112500" in notes from ever colliding.
      const caseNo = String(d.tvcCaseNumber ?? "").trim();
      if (/^\d{7}$/.test(caseNo)) {
        byCaseNumber.set(caseNo, [...(byCaseNumber.get(caseNo) ?? []), lead]);
      }
      const name = lc(d.name);
      if (name) byName.set(name, [...(byName.get(name) ?? []), lead]);
      const usable = nameNeedles(d.name);
      if (usable.length) noteNameIndex.push({ needles: usable, lead });
    }

    // CALL-TIME identity needs every CallRail attempt (full contactAttempts
    // arrays — a heavier read), so load it lazily and only once, the first
    // time a payment that phone/email couldn't place actually needs it.
    // The product: an interval index of RECENT calls — [call start, call
    // start + duration + 30m grace] per lead — payments are keyed mid-call,
    // so a payment landing inside exactly one lead's call window is a strong
    // identity candidate.
    const CALL_INDEX_DAYS = 45;
    const CALL_GRACE_MS = 30 * 60_000;
    const CALL_DEFAULT_WINDOW_MS = 90 * 60_000; // no duration stored → assume 90m
    interface CallInterval {
      start: number;
      end: number;
      // Actual call end (start + recorded duration, no grace) — null when the
      // attempt stored no duration. A payment inside THIS window was keyed
      // literally mid-call: the strongest temporal signal there is.
      strictEnd: number | null;
      lead: LeadRef;
      saleAmount: number | null;
      // Transcript classifier said money moved on this call (ai.saleStatus).
      aiPaid: boolean;
    }
    let callIndex: CallInterval[] | null = null;
    const loadCallIndex = async (): Promise<CallInterval[]> => {
      if (callIndex) return callIndex;
      const snap = await db
        .collection("leads")
        .orderBy("createdAt", "desc")
        .limit(1000)
        .select("contactAttempts", "deletedAt", "name", "saleAmount")
        .get();
      const intervals: CallInterval[] = [];
      const cutoff = Date.now() - CALL_INDEX_DAYS * 86400_000;
      for (const doc of snap.docs) {
        const d = doc.data();
        if (d.deletedAt) continue;
        const lead: LeadRef = { id: doc.id, name: d.name };
        const saleAmount =
          typeof d.saleAmount === "number" && d.saleAmount > 0 ? d.saleAmount : null;
        for (const a of Array.isArray(d.contactAttempts) ? d.contactAttempts : []) {
          if (a?.via !== "callrail" || typeof a.ts !== "number") continue;
          if (a.ts < cutoff) continue;
          // Only calls that actually CONNECTED belong in the interval index —
          // both as concurrent-call candidates and as veto/conflict material.
          // A no-answer or voicemail attempt is not a call a card could have
          // been keyed during (see isConnectedCallAttempt / the Jones case).
          if (!isConnectedCallAttempt(a)) continue;
          const durMs =
            typeof a.durationSec === "number" && a.durationSec > 0
              ? a.durationSec * 1000
              : null;
          const end = durMs !== null ? a.ts + durMs + CALL_GRACE_MS : a.ts + CALL_DEFAULT_WINDOW_MS;
          const aiPaid =
            a.ai?.saleStatus === "paid_full" || a.ai?.saleStatus === "paid_partial";
          intervals.push({
            start: a.ts,
            end,
            strictEnd: durMs !== null ? a.ts + durMs : null,
            lead,
            saleAmount,
            aiPaid,
          });
        }
      }
      callIndex = intervals;
      return callIndex;
    };

    // First/last name tokens (>= 4 chars) for the concurrent-call
    // corroboration check — "did the note mention ANY part of this name?".
    const nameTokens = (name: unknown): string[] => {
      const parts = normalizeText(name).split(" ").filter(Boolean);
      if (!parts.length) return [];
      return [...new Set([parts[0], parts[parts.length - 1]])].filter((t) => t.length >= 4);
    };
    // Payment-note vocabulary — the words staff use when keying charges.
    // Anything left over after stripping these (and numbers) is very likely a
    // PERSON'S NAME, and a note that names someone other than the candidate
    // lead must veto a concurrent-call match (the payer identity written down
    // at charge time beats who happened to be on the phone).
    const PAYMENT_VOCAB = new Set([
      "retainer", "payment", "payments", "pymt", "pmt", "fee", "fees", "trial",
      "balance", "owes", "owe", "due", "paid", "pay", "pays", "final", "last",
      "first", "second", "third", "half", "full", "remaining", "rest",
      "partial", "deposit", "down", "court", "case", "ticket", "tvc", "llc",
      "law", "firm", "initial", "installment", "installments", "plan", "left",
      "total", "amount", "charge", "charged", "card", "visa", "mastercard",
      "amex", "discover", "cash", "check", "invoice", "received", "covers",
      "covered", "of", "the", "for", "and", "per", "via", "on", "in", "to",
      "a", "an", "no", "off", "with", "from", "by", "usd",
    ]);
    // Does the note carry name-like words that are NOT part of this lead's
    // name? (All the lead's name parts count, middle names included.)
    const noteNamesSomeoneElse = (noteNorm: string, leadName: unknown): boolean => {
      if (!noteNorm) return false;
      const leadParts = new Set(normalizeText(leadName).split(" ").filter(Boolean));
      return noteNorm
        .split(" ")
        .some(
          (t) =>
            t.length >= 2 &&
            !/^\d+$/.test(t) &&
            !PAYMENT_VOCAB.has(t) &&
            !leadParts.has(t),
        );
    };

    const customerCache = new Map<string, SqCustomer | null>();
    let matched = 0;
    let unmatched = 0;
    let ambiguityPostIts = 0;
    let escalationsCleared = 0;
    // Payments THIS run left unmatched, with the payer identity that was
    // resolved for them — the verify pass's cross-reference scan reuses these
    // without another Square fetch.
    const unmatchedThisRun = new Map<string, { payment: SqPayment; payerName: string | null }>();

    // Roll a confidently-identified payment onto its lead: contact-attempt
    // entry, squarePaidTotal rollup, paid_full/paid_partial sale state, the
    // move to intake_complete, and standing down open billing-escalation
    // post-its. Shared by the main matcher and the verify pass's strong
    // cross-reference credit — both MUST behave identically. Returns the
    // action string for the marker doc.
    const creditPaymentToLead = async (
      leadId: string,
      payment: SqPayment,
      buildNotes: (attempts: { via?: string; ts?: number }[]) => string,
    ): Promise<string> => {
      const cents = payment.amount_money?.amount ?? 0;
      const dollars = cents / 100;
      const amountLabel = fmtDollars(cents);
      const paidTs = new Date(payment.created_at).getTime() || Date.now();

      let action = "payment_logged";
      await db.runTransaction(async (tx) => {
        const ref = db.collection("leads").doc(leadId);
        const snap = await tx.get(ref);
        if (!snap.exists) return;
        const d = snap.data()!;
        if (d.deletedAt) return;

        const attempts = Array.isArray(d.contactAttempts) ? d.contactAttempts : [];
        // Belt and braces on top of the marker doc: never double-log a
        // payment. Already on the lead (an earlier sync run, or a HUMAN
        // hand-credit — the Matthew Jones fix) means the money was already
        // counted too: leave the lead completely untouched, or a marker
        // re-evaluation would double-roll squarePaidTotal.
        const alreadyLogged = attempts.some(
          (a: { paymentId?: string; notes?: string }) =>
            a.paymentId === payment.id || (a.notes ?? "").includes(payment.id),
        );
        if (alreadyLogged) {
          action = d.saleStatus === "paid_full" ? "paid_full" : "payment_logged";
          return;
        }

        const now = Date.now();
        const patch: Record<string, unknown> = { updatedAt: now };
        patch.contactAttempts = [
          ...attempts,
          {
            ts: paidTs,
            outcome: "retained",
            via: "square",
            notes: buildNotes(attempts),
            by: "Square sync",
            paymentId: payment.id,
          },
        ];

        // Sale rollup. squarePaidTotal accumulates every synced payment so
        // installments eventually flip a partial to paid-in-full.
        const paidTotal = ((d.squarePaidTotal as number) ?? 0) + dollars;
        patch.squarePaidTotal = paidTotal;
        // Fresh money resets the stalled-plan watch (see cadence.ts) so the
        // next silent stretch gets its own post-it.
        patch.planStallFlaggedAt = null;

        const saleAmount = (d.saleAmount as number) ?? null;
        const coversFee = !saleAmount || dollars >= saleAmount || paidTotal >= saleAmount;
        const alreadyPaidFull = d.saleStatus === "paid_full"; // never downgrade

        if (coversFee || alreadyPaidFull) {
          patch.saleStatus = "paid_full";
          if (!alreadyPaidFull) patch.saleStatusAt = paidTs;
          patch.saleEscalatedAt = null;
          patch.salePursuitAlertAt = null;
          // Money collected — close open billing follow-ups (same semantics
          // as the manual "Mark Paid" button).
          const followUps = Array.isArray(d.followUps) ? d.followUps : [];
          patch.followUps = followUps.map((f: { done?: boolean; type?: string }) =>
            !f.done && f.type === "billing" ? { ...f, done: true, doneAt: now } : f,
          );
          // Paid in full moves the lead off the working board — but never
          // out of intake_complete/financed (no downgrades).
          if (d.stage !== "intake_complete" && d.stage !== "financed") {
            const day = new Date(paidTs).toLocaleDateString("en-US", {
              month: "short",
              day: "numeric",
              timeZone: "America/Chicago",
            });
            patch.stage = "intake_complete";
            patch.intakeComplete = true;
            patch.intakeCompleteAt = paidTs;
            patch.retainedAt = (d.retainedAt as number) ?? paidTs;
            patch.autoStageNote = `Stage moved to Intake Complete by Square sync — ${amountLabel} payment received on ${day}`;
            patch.autoStageAt = now;
            action = "paid_full_moved";
          } else {
            action = "paid_full";
          }
        } else {
          patch.saleStatus = "paid_partial";
          patch.saleStatusAt = paidTs;
          patch.saleEscalatedAt = null;
          patch.salePursuitAlertAt = null;
          action = "paid_partial";
        }

        tx.update(ref, patch);
      });

      // The money arrived — stand down any open billing-escalation post-its.
      const escalations = await db
        .collection("messages")
        .where("leadId", "==", leadId)
        .where("kind", "==", "billing_escalation")
        .where("handled", "==", false)
        .get();
      for (const m of escalations.docs) {
        if (m.data().deletedAt) continue;
        await m.ref.update({
          handled: true,
          handledAt: paidTs,
          handledBy: "Square sync",
          updatedAt: Date.now(),
        });
        escalationsCleared++;
      }
      return action;
    };

    for (const payment of completed) {
      const marker = db.collection("squarePayments").doc(payment.id);
      // Re-evaluated payments deliberately pass the marker guard — their
      // marker is the thing being reconsidered.
      if (!reEvalIds.has(payment.id) && (await marker.get()).exists) continue;

      const cents = payment.amount_money?.amount ?? 0;
      const dollars = cents / 100;
      const amountLabel = fmtDollars(cents);
      const paidTs = new Date(payment.created_at).getTime() || Date.now();

      // Resolve payer identity: the customer record is the richest source,
      // then the buyer email off the payment, then whatever the note says.
      let payerName: string | null = null;
      let payerEmail: string | null = null;
      let payerPhone: string | null = null;
      if (payment.customer_id) {
        if (!customerCache.has(payment.customer_id)) {
          customerCache.set(payment.customer_id, await fetchCustomer(token, payment.customer_id));
        }
        const c = customerCache.get(payment.customer_id);
        if (c) {
          payerName = [c.given_name, c.family_name].filter(Boolean).join(" ").trim() || null;
          payerEmail = c.email_address || null;
          payerPhone = c.phone_number || null;
        }
      }
      if (!payerEmail && payment.buyer_email_address) payerEmail = payment.buyer_email_address;
      const noteText = (payment.note ?? "").trim() || null;

      // Match to a lead: phone beats email beats concurrent-call beats
      // note-text beats exact name. Phone/email are the strongest evidence;
      // a corroborated CallRail call in progress when the card was keyed is
      // next (staff charge cards MID-CALL, and the call already sits on a
      // specific lead); a name buried in the payment note follows (manual
      // card entries carry identity ONLY there); an exact-unique-name hit on
      // the customer record comes last.
      //
      // Whose name appears in the note? Computed once — the note matcher
      // needs it, and the concurrent-call matcher needs it as a VETO (a note
      // that clearly names lead X must never let a concurrent call credit
      // the money to lead Y — the Dessie/"Parmjeet Singh" case stays manual).
      const noteNamedLeads = new Map<string, LeadRef>();
      if (noteText) {
        const hay = ` ${normalizeText(noteText)} `;
        for (const entry of noteNameIndex) {
          if (entry.needles.some((n) => hay.includes(` ${n} `))) {
            noteNamedLeads.set(entry.lead.id, entry.lead);
          }
        }
      }

      let lead: LeadRef | undefined;
      let matchedBy: string | null = null;
      // Extra context for the attempt note / unmatched post-it.
      let concurrentDetail: string | null = null;
      let concurrentCandidates: LeadRef[] = [];
      // Note names lead X while the concurrent call was with lead Y — nobody
      // gets auto-credited; a human must decide (forces the post-it path).
      let noteCallConflict: string | null = null;

      const phoneKey = last10(payerPhone);
      if (phoneKey.length === 10) {
        lead = byPhone.get(phoneKey);
        if (lead) matchedBy = "phone";
      }
      if (!lead && payerEmail) {
        lead = byEmail.get(lc(payerEmail));
        if (lead) matchedBy = "email";
      }
      if (!lead) {
        // TVC CASE NUMBER in the note or customer record — a staff-typed
        // case number is authoritative: unique per case and immune to the
        // misspelled/misheard-name problems that plague name matching.
        // Multiple distinct case numbers (or a duplicate-lead pair sharing
        // one) refuse to match.
        const caseHits = new Map<string, LeadRef>();
        for (const m of `${noteText ?? ""} ${payerName ?? ""}`.matchAll(/\b(\d{7})\b/g)) {
          const leads = byCaseNumber.get(m[1]);
          if (leads && leads.length === 1) caseHits.set(leads[0].id, leads[0]);
        }
        if (caseHits.size === 1) {
          lead = [...caseHits.values()][0];
          matchedBy = "case_number";
        }
      }
      if (!lead) {
        // CONCURRENT CALL — was exactly one lead on a CallRail call when the
        // payment was keyed? Candidate only; requires corroboration.
        const intervals = await loadCallIndex();
        let hits = new Map<string, CallInterval>();
        for (const iv of intervals) {
          if (paidTs >= iv.start && paidTs <= iv.end) {
            const prev = hits.get(iv.lead.id);
            // Keep the interval with the strongest signals for corroboration.
            if (!prev || (iv.aiPaid && !prev.aiPaid)) hits.set(iv.lead.id, iv);
          }
        }
        // Several candidates? A payment keyed literally MID-CALL (inside the
        // recorded duration, before any grace) outranks calls that merely
        // ended within the grace window — narrow to strict hits when that
        // leaves exactly one lead.
        if (hits.size > 1) {
          const strict = new Map(
            [...hits].filter(
              ([, iv]) => iv.strictEnd !== null && paidTs >= iv.start && paidTs <= iv.strictEnd,
            ),
          );
          if (strict.size === 1) hits = strict;
        }
        concurrentCandidates = [...hits.values()].map((h) => h.lead);
        if (hits.size === 1) {
          const hit = [...hits.values()][0];
          const noteNorm = normalizeText(noteText);
          const payerNorm = normalizeText(payerName);
          // Every lead the payment's OWN identity fields point at — the
          // staff-written note plus the Square customer-record name.
          const namedLeads = new Map(noteNamedLeads);
          if (payerNorm) {
            const payerHay = ` ${payerNorm} `;
            for (const entry of noteNameIndex) {
              if (entry.needles.some((n) => payerHay.includes(` ${n} `))) {
                namedLeads.set(entry.lead.id, entry.lead);
              }
            }
          }
          // VETO 1: the note or customer record names a DIFFERENT existing
          // lead (the Dessie/"Parmjeet Singh" case) — conflicting identities,
          // a human must decide, and note-matching must not run either.
          const namesOtherLead = namedLeads.size > 0 && !namedLeads.has(hit.lead.id);
          // VETO 2: the note or customer record carries name-like words
          // foreign to this lead (a payer who was never entered as a lead,
          // e.g. note "Ali Janneh" or customer "Keith Horton") — don't credit
          // the lead who merely happened to be on the phone. No conflict
          // post-it needed; the payment just stays unmatched.
          const namesStranger =
            !namesOtherLead &&
            namedLeads.size === 0 &&
            (noteNamesSomeoneElse(noteNorm, hit.lead.name) ||
              noteNamesSomeoneElse(payerNorm, hit.lead.name));
          if (namesOtherLead) {
            const others = [...namedLeads.values()].map((l) => l.name).join(", ");
            noteCallConflict =
              `the payment identifies ${others} (note/customer record) but the concurrent ` +
              `CallRail call was with ${hit.lead.name} — conflicting identities, refusing to ` +
              `auto-credit either`;
          } else if (!namesStranger) {
            // Corroboration: at least one independent signal must agree.
            let why: string | null = null;
            const hay = ` ${noteNorm} ${payerNorm} `;
            const token = nameTokens(hit.lead.name).find((t) => hay.includes(` ${t} `));
            if (token) {
              why = `payment note contains "${token}" from the lead's name`;
            } else if (hit.saleAmount === null) {
              why = "lead has no recorded fee yet, amount unconstrained";
            } else if (Math.abs(dollars - hit.saleAmount) <= AMOUNT_TOLERANCE) {
              why = `amount matches the lead's $${hit.saleAmount} fee`;
            } else if (Math.abs(dollars * 2 - hit.saleAmount) <= AMOUNT_TOLERANCE) {
              why = `amount is half of the lead's $${hit.saleAmount} fee`;
            } else if (hit.aiPaid) {
              why = "the call's transcript analysis says payment was collected on the call";
            }
            if (why) {
              lead = hit.lead;
              matchedBy = "concurrent_call";
              const mins = Math.max(0, Math.round((paidTs - hit.start) / 60_000));
              concurrentDetail =
                `charge keyed ${mins}m into/after this lead's CallRail call; corroborated — ${why}`;
            }
          }
        }
      }
      if (!lead && !noteCallConflict && noteText) {
        // Note-text identity: must be exactly ONE lead — if two leads' names
        // both show up, we refuse to guess.
        if (noteNamedLeads.size === 1) {
          lead = [...noteNamedLeads.values()][0];
          matchedBy = "note";
        }
      }
      if (!lead && !noteCallConflict) {
        for (const candidate of [payerName, noteText]) {
          const key = lc(candidate);
          if (!key) continue;
          const hits = byName.get(key);
          if (hits && hits.length === 1) {
            lead = hits[0];
            matchedBy = "name";
            break;
          }
        }
      }

      if (!lead) {
        // Nobody to credit — ignore SILENTLY (marker doc only). The Square
        // account also takes general firm charges and payments from clients
        // who never came through the app, so unmatched money is not the
        // app's business, no matter the amount or timing.
        //
        // The ONE post-it case: ambiguous identity a human must untangle —
        // a note/customer naming a DIFFERENT lead than the concurrent call's
        // lead, or several leads on calls when the charge was keyed with the
        // note/customer pointing at none of them (and at no stranger either —
        // a note clearly naming a non-lead payer means it's simply not ours).
        const multiCandidateAmbiguity =
          !noteCallConflict &&
          concurrentCandidates.length > 1 &&
          noteNamedLeads.size === 0 &&
          !noteNamesSomeoneElse(
            normalizeText(`${noteText ?? ""} ${payerName ?? ""}`),
            concurrentCandidates.map((l) => l.name).join(" "),
          );
        const ambiguity = noteCallConflict
          ? noteCallConflict
          : multiCandidateAmbiguity
            ? `${concurrentCandidates.length} leads were on CallRail calls when the charge ` +
              `was keyed (${concurrentCandidates.map((l) => l.name).join(", ")}) and nothing ` +
              `on the payment picks between them`
            : null;
        // A re-evaluated marker may hit the same ambiguity twice — one
        // post-it per payment, ever (matched by squarePaymentId).
        const alreadyPosted = ambiguity
          ? !(
              await db
                .collection("messages")
                .where("squarePaymentId", "==", payment.id)
                .limit(1)
                .get()
            ).empty
          : false;
        if (ambiguity && !alreadyPosted) {
          const payerBits = [
            payerName ? `name: ${payerName}` : null,
            payerEmail ? `email: ${payerEmail}` : null,
            payerPhone ? `phone: ${payerPhone}` : null,
            noteText ? `note: "${noteText}"` : null,
          ].filter(Boolean);
          await db.collection("messages").add({
            kind: "tvc_message",
            source: "system",
            from: "Square Sync",
            fromName: "Square Sync",
            subject: `Ambiguous Square payment — ${amountLabel}`,
            message:
              `A ${amountLabel} Square payment (${payment.id}) came in on ` +
              `${new Date(paidTs).toLocaleDateString("en-US", { timeZone: "America/Chicago" })} ` +
              `and looks like a client payment, but the sync can't safely pick who to credit.\n` +
              (payerBits.length
                ? `Payer info found — ${payerBits.join(" · ")}.`
                : `No payer info was attached to the payment.`) +
              `\nWhy it needs a human: ${ambiguity}.` +
              `\nDecide who this money belongs to (log the payment and mark the sale paid).`,
            tvcCaseNumber: null,
            memberName: payerName,
            leadId: null,
            phone: payerPhone,
            email: payerEmail,
            gmailMessageId: null,
            squarePaymentId: payment.id,
            receivedAt: paidTs,
            handled: false,
            createdAt: Date.now(),
            updatedAt: Date.now(),
          });
          ambiguityPostIts++;
        }
        await marker.set(
          {
            processedAt: Date.now(),
            leadId: null,
            action: ambiguity ? "unmatched" : "ignored_unrelated",
            evidence: ambiguity ?? null,
            concurrentCandidates: concurrentCandidates.length
              ? concurrentCandidates.map((l) => l.name)
              : null,
            amountCents: cents,
            payerName,
            payerEmail,
            payerPhone,
            matcherVersion: MATCHER_VERSION,
          },
          // Keep reEvalExempt & friends when refreshing a re-evaluated marker.
          { merge: true },
        );
        unmatched++;
        // Either flavor of "nobody credited" (ambiguous OR silently ignored)
        // is cross-reference material for the verify pass: these are the
        // COMPLETED payments of the current fetch window that no lead got.
        unmatchedThisRun.set(payment.id, { payment, payerName });
        continue;
      }

      // Confident match — roll the payment onto the lead in a transaction.
      const action = await creditPaymentToLead(lead.id, payment, (attempts) => {
        let notes = `Square payment received — ${amountLabel} (payment ${payment.id})`;
        if (matchedBy === "concurrent_call" && concurrentDetail) {
          notes += ` — matched by concurrent call: ${concurrentDetail}`;
          if (noteText) notes += ` (payment note: "${noteText}")`;
        }
        if (matchedBy === "note") {
          notes += ` — matched by payment note "${noteText}"`;
          // Corroboration: staff charge the card DURING or right after the
          // retain call, so a note-matched payment landing within 3h of a
          // CallRail call on this same lead is near-certain identity.
          const call = attempts.find(
            (a) =>
              a?.via === "callrail" &&
              typeof a.ts === "number" &&
              paidTs > a.ts &&
              paidTs <= a.ts + 3 * 3600_000,
          );
          if (call) {
            const mins = Math.max(1, Math.round((paidTs - (call.ts as number)) / 60_000));
            notes += `; corroborated — charge landed ${mins}m after a CallRail call on this lead`;
          }
        }
        return notes;
      });

      await marker.set(
        {
          processedAt: Date.now(),
          leadId: lead.id,
          action,
          matchedBy,
          amountCents: cents,
          matcherVersion: MATCHER_VERSION,
        },
        { merge: true },
      );
      matched++;
      logger.info("Square payment reconciled to lead", {
        paymentId: payment.id,
        leadId: lead.id,
        name: lead.name,
        amount: amountLabel,
        matchedBy,
        action,
      });
    }

    // --- Verification pass: transcript says paid, processor says nothing ----
    // The CallRail classifier sets paid_full/paid_partial from what was SAID
    // on a call. If 24h+ has passed and no Square charge ever matched the
    // lead, the claimed money may never have moved — raise the alarm once.
    //
    // BUT: before alarming, cross-reference the matcher's OWN records. The
    // Matthew Jones case: his $1,125 charge sat in squarePayments as an
    // unmatched marker whose note NAMED HIM, while this pass swore "no Square
    // charge has been found". The money was found — the matcher just refused
    // to place it. So each would-be alarm first scans the unattributed pool
    // (unmatched markers + this run's uncredited payments) within ±7 days of
    // the sale claim:
    //   strong (names this lead + amount consistent) → auto-credit, no alarm;
    //   weak (amount-only, or name with wrong amount) → alarm, but name the
    //     candidate charge so a human can confirm-and-credit;
    //   none → the original alarm text stands.
    let verifyFlagged = 0;
    let verifyCredited = 0;
    const VERIFY_SCAN_WINDOW_MS = 7 * 86400_000; // ±7 days around the claim

    // The unattributed pool, loaded lazily (only when a lead actually needs
    // the cross-reference): every marker with action "unmatched", hydrated
    // with the payment's note/amount/time — from this run's fetch when
    // possible, from Square's single-payment endpoint otherwise (markers
    // don't store the note) — plus this run's silently-ignored payments.
    type VerifyPoolEntry = { payment: SqPayment; payerName: string | null };
    let verifyPool: VerifyPoolEntry[] | null = null;
    const loadVerifyPool = async (): Promise<VerifyPoolEntry[]> => {
      if (verifyPool) return verifyPool;
      const pool = new Map<string, VerifyPoolEntry>(unmatchedThisRun);
      const markerSnap = await db
        .collection("squarePayments")
        .where("action", "==", "unmatched")
        .select("payerName")
        .get();
      for (const m of markerSnap.docs) {
        if (pool.has(m.id)) continue;
        const p = await fetchPayment(token, m.id);
        if (!p || p.status !== "COMPLETED") continue;
        pool.set(m.id, {
          payment: p,
          payerName: (m.data().payerName as string | null) ?? null,
        });
      }
      verifyPool = [...pool.values()];
      return verifyPool;
    };

    const now = Date.now();
    const paidLeads = await db
      .collection("leads")
      .where("saleStatus", "in", ["paid_full", "paid_partial"])
      .select(
        "name", "phone", "email", "deletedAt", "saleStatus", "saleStatusAt",
        "saleAmount", "squarePaidTotal", "squareVerifyFlaggedAt",
      )
      .get();
    for (const doc of paidLeads.docs) {
      const d = doc.data();
      if (d.deletedAt) continue;
      if (d.squareVerifyFlaggedAt) continue; // one alarm per lead, ever
      if ((d.squarePaidTotal as number) > 0) continue; // a real charge matched
      const statusAt = (d.saleStatusAt as number) ?? 0;
      if (!statusAt) continue; // no timestamp — can't reason about it
      if (now - statusAt < 24 * 3600_000) continue; // give the charge time to land
      if (statusAt < backfillStartAt) continue; // charge would predate Square visibility

      const feeDollars =
        typeof d.saleAmount === "number" && d.saleAmount > 0 ? (d.saleAmount as number) : null;

      // Cross-reference the unattributed pool before alarming.
      const pool = await loadVerifyPool();
      let strong: VerifyPoolEntry | null = null;
      const weak: VerifyPoolEntry[] = [];
      for (const entry of pool) {
        const t = new Date(entry.payment.created_at).getTime() || 0;
        if (Math.abs(t - statusAt) > VERIFY_SCAN_WINDOW_MS) continue;
        const verdict = classifyVerifyCandidate({
          leadName: d.name,
          feeDollars,
          paymentDollars: (entry.payment.amount_money?.amount ?? 0) / 100,
          note: entry.payment.note ?? null,
          payerName: entry.payerName,
        });
        if (verdict === "strong") {
          // Closest-in-time strong candidate wins (several is near-impossible).
          if (
            !strong ||
            Math.abs(t - statusAt) <
              Math.abs((new Date(strong.payment.created_at).getTime() || 0) - statusAt)
          ) {
            strong = entry;
          }
        } else if (verdict === "weak") {
          weak.push(entry);
        }
      }

      const chicagoTime = (ts: number): string =>
        new Date(ts).toLocaleString("en-US", {
          month: "short",
          day: "numeric",
          hour: "numeric",
          minute: "2-digit",
          timeZone: "America/Chicago",
        });
      const amt = feeDollars ? `$${feeDollars}` : "an unknown amount";
      const day = new Date(statusAt).toLocaleDateString("en-US", {
        month: "short",
        day: "numeric",
        timeZone: "America/Chicago",
      });

      if (strong) {
        // STRONG: the charge the transcript promised exists, unattributed, and
        // carries this lead's own name with a consistent amount. Credit it
        // exactly like a normal match — this is precisely what a human did for
        // Matthew Jones, and it must never require a human again.
        const p = strong.payment;
        const cents = p.amount_money?.amount ?? 0;
        const paidTs = new Date(p.created_at).getTime() || now;
        const reconciledBy =
          `verify-pass cross-reference: the lead was marked ${d.saleStatus} on ${day} with no ` +
          `credited Square charge, and this unattributed ${fmtDollars(cents)} payment ` +
          `(keyed ${chicagoTime(paidTs)}${p.note ? `, note "${p.note}"` : ""}` +
          `${strong.payerName ? `, customer "${strong.payerName}"` : ""}) names the lead with a ` +
          `consistent amount`;
        const action = await creditPaymentToLead(
          doc.id,
          p,
          () =>
            `Square payment received — ${fmtDollars(cents)} (payment ${p.id}) — ${reconciledBy}`,
        );
        await db.collection("squarePayments").doc(p.id).set(
          {
            processedAt: Date.now(),
            leadId: doc.id,
            action,
            matchedBy: "verify_cross_reference",
            amountCents: cents,
            matcherVersion: MATCHER_VERSION,
            reconciledBy,
          },
          { merge: true },
        );
        // The payment's own ambiguity post-it (if one was raised) is resolved
        // by this credit — stand it down like the billing escalations.
        const open = await db
          .collection("messages")
          .where("squarePaymentId", "==", p.id)
          .where("handled", "==", false)
          .get();
        for (const m of open.docs) {
          if (m.data().deletedAt) continue;
          await m.ref.update({
            handled: true,
            handledAt: paidTs,
            handledBy: "Square sync",
            updatedAt: Date.now(),
          });
        }
        // Drop it from the pool so a second claimant can't double-credit it.
        verifyPool = pool.filter((e) => e.payment.id !== p.id);
        matched++;
        verifyCredited++;
        logger.info("Verify pass credited an unattributed payment by cross-reference", {
          paymentId: p.id,
          leadId: doc.id,
          name: d.name,
          amount: fmtDollars(cents),
          action,
          reconciledBy,
        });
        continue; // money found — no alarm
      }

      // Mirrors the cadence engine's billing-escalation post-it convention
      // (see postIt in cadence.ts) so it gets the same gold treatment.
      // WEAK candidates make the alarm accurate: an unattributed charge that
      // MAY be this payment exists, and the note must say so instead of
      // claiming no charge was found.
      const weakLines = weak.slice(0, 3).map((e) => {
        const cents = e.payment.amount_money?.amount ?? 0;
        const t = new Date(e.payment.created_at).getTime() || 0;
        return (
          `A ${fmtDollars(cents)} charge (${e.payment.id}, keyed ${chicagoTime(t)}` +
          `${e.payment.note ? `, note "${e.payment.note}"` : ", no note"}` +
          `${e.payerName ? `, customer "${e.payerName}"` : ""}) exists unattributed in Square ` +
          `and may be this payment.`
        );
      });
      await db.collection("messages").add({
        kind: "billing_escalation",
        source: "system",
        from: "TVCHub Cadence",
        fromName: "Square Sync",
        subject: `Transcript says PAID but no Square charge — ${d.name}`,
        message:
          `${d.name} was marked ${d.saleStatus === "paid_full" ? "paid in full" : "partially paid"}` +
          ` (${amt}) on ${day}, but no Square charge has been credited to them since.` +
          (weakLines.length
            ? `\n${weakLines.join("\n")}` +
              `\nConfirm and credit it (log the payment and mark the sale paid), or verify the ` +
              `money ran outside Square.`
            : ` Either the payment ran outside Square (check the ledger) or the call's` +
              ` payment claim was wrong — verify the money actually moved.`),
        tvcCaseNumber: null,
        memberName: d.name,
        leadId: doc.id,
        phone: (d.phone as string) ?? null,
        email: (d.email as string) ?? null,
        nonPaymentReason: null,
        noPursuit: false,
        gmailMessageId: null,
        squarePaymentId: weak.length === 1 ? weak[0].payment.id : null,
        receivedAt: statusAt,
        handled: false,
        createdAt: now,
        updatedAt: now,
      });
      await doc.ref.update({ squareVerifyFlaggedAt: now, updatedAt: now });
      verifyFlagged++;
      logger.info("Flagged transcript-paid lead with no Square charge", {
        leadId: doc.id,
        name: d.name,
        saleStatus: d.saleStatus,
        saleAmount: d.saleAmount ?? null,
        saleStatusAt: statusAt,
        weakCandidates: weak.map((e) => e.payment.id),
      });
    }

    // --- Invoice tracking pass ----------------------------------------------
    // The office also RETAINS by Square invoice ("Retainer Agreement -
    // <name>", emailed). This pass stamps each invoice's status onto its lead
    // (squareInvoice field) and chases unpaid ones. Rules:
    //   - Match by recipient email → phone last-10 → name (recipient
    //     given+family, or the name inside the invoice TITLE via the same
    //     normalized needles the payment-note matcher uses).
    //   - PAID / PARTIALLY_PAID: the payments API already recorded the actual
    //     money and the payment matcher credited it — the invoice pass only
    //     updates the status stamp, NEVER the sale fields (no double-credit).
    //   - UNPAID for 3+ days since sent: one Action Item post-it per invoice,
    //     ever (deduped by squareInvoiceId, same pattern as squarePaymentId).
    //     Raised even when NO lead matches — an unpaid retainer invoice is
    //     money on the table whoever the recipient is, so the post-it names
    //     the recipient instead.
    //   - CANCELED / REFUNDED: status stamp updated (the UI treats only
    //     UNPAID as active), open chase post-its stood down, no new post-it.
    // Marker docs squareInvoices/{invoiceId} store the last-seen status, so
    // an invoice is re-processed exactly when its status CHANGES. First run
    // sweeps every invoice on the location (the backfill).
    let invoicesSeen = 0;
    let invoicesMatched = 0;
    let invoicePostIts = 0;
    const invoices = await fetchInvoices(token);
    for (const inv of invoices) {
      const status = inv.status ?? "UNKNOWN";
      if (status === "DRAFT") continue; // never sent — nothing to track yet
      const marker = db.collection("squareInvoices").doc(inv.id);
      const markerSnap = await marker.get();
      if (markerSnap.exists && markerSnap.data()?.status === status) continue;
      invoicesSeen++;

      const r = inv.primary_recipient ?? {};
      const recipientName =
        [r.given_name, r.family_name].filter(Boolean).join(" ").trim() || null;
      const cents = inv.payment_requests?.[0]?.computed_amount_money?.amount ?? 0;
      const amountLabel = fmtDollars(cents);
      const sentAt = new Date(inv.created_at ?? "").getTime() || now;
      const invUpdatedAt = new Date(inv.updated_at ?? "").getTime() || now;
      const sentDay = new Date(sentAt).toLocaleDateString("en-US", {
        month: "short",
        day: "numeric",
        timeZone: "America/Chicago",
      });

      // Match to a lead: email → phone → exact-unique name → name inside the
      // title/recipient text (the payment-note needle index).
      let lead: LeadRef | undefined;
      let matchedBy: string | null = null;
      if (r.email_address) {
        lead = byEmail.get(lc(r.email_address));
        if (lead) matchedBy = "email";
      }
      if (!lead) {
        const phoneKey = last10(r.phone_number);
        if (phoneKey.length === 10) {
          lead = byPhone.get(phoneKey);
          if (lead) matchedBy = "phone";
        }
      }
      if (!lead && recipientName) {
        const hits = byName.get(lc(recipientName));
        if (hits && hits.length === 1) {
          lead = hits[0];
          matchedBy = "name";
        }
      }
      if (!lead) {
        // TVC case number in the invoice title/description — same
        // authoritative key as the payment-note matcher.
        const caseHits = new Map<string, LeadRef>();
        const invText = `${inv.title ?? ""} ${inv.description ?? ""}`;
        for (const m of invText.matchAll(/\b(\d{7})\b/g)) {
          const leads = byCaseNumber.get(m[1]);
          if (leads && leads.length === 1) caseHits.set(leads[0].id, leads[0]);
        }
        if (caseHits.size === 1) {
          lead = [...caseHits.values()][0];
          matchedBy = "case_number";
        }
      }
      if (!lead) {
        // "Retainer Agreement - Anastacia Barnes" carries the CLIENT's name
        // even when the recipient is someone else paying on their behalf.
        const hay = ` ${normalizeText(inv.title)} ${normalizeText(recipientName)} `;
        const hits = new Map<string, LeadRef>();
        for (const entry of noteNameIndex) {
          if (entry.needles.some((n) => hay.includes(` ${n} `))) {
            hits.set(entry.lead.id, entry.lead);
          }
        }
        if (hits.size === 1) {
          lead = [...hits.values()][0];
          matchedBy = "title";
        }
      }

      // Stamp the lead. The stamp is pure status telemetry — sale/money
      // fields stay the payment matcher's job (invoice payments land there
      // too; inv.order_id is kept on the marker to corroborate if needed).
      if (lead) {
        await db.runTransaction(async (tx) => {
          const ref = db.collection("leads").doc(lead!.id);
          const snap = await tx.get(ref);
          if (!snap.exists) return;
          const d = snap.data()!;
          if (d.deletedAt) return;
          const prev = d.squareInvoice as { id?: string; updatedAt?: number } | undefined;
          // Newest-updated invoice owns the stamp — a stale sibling invoice
          // can't overwrite a fresher one.
          if (prev && prev.id !== inv.id && (prev.updatedAt ?? 0) > invUpdatedAt) return;
          tx.update(ref, {
            squareInvoice: {
              id: inv.id,
              number: inv.invoice_number ?? null,
              amountCents: cents,
              status,
              sentAt,
              publicUrl: inv.public_url ?? null,
              updatedAt: invUpdatedAt,
            },
            updatedAt: Date.now(),
          });
        });
        invoicesMatched++;
      }

      // Chase: sent, still unpaid, given a grace window. One post-it per
      // invoice, ever — matched by squareInvoiceId (the squarePaymentId
      // dedupe pattern). Unmatched recipients get chased too, by name.
      if (status === "UNPAID" && now - sentAt >= INVOICE_CHASE_AFTER_DAYS * 86400_000) {
        const alreadyPosted = !(
          await db
            .collection("messages")
            .where("squareInvoiceId", "==", inv.id)
            .limit(1)
            .get()
        ).empty;
        if (!alreadyPosted) {
          const who = lead?.name ?? recipientName ?? "unknown recipient";
          await db.collection("messages").add({
            kind: "tvc_message",
            source: "system",
            from: "Square Sync",
            fromName: "Square Sync",
            subject: `Invoice out, unpaid — ${who}, ${amountLabel}, sent ${sentDay} — chase`,
            message:
              `Square invoice ${inv.invoice_number ? `#${inv.invoice_number}` : inv.id} for ` +
              `${amountLabel} was sent to ${recipientName ?? "an unnamed recipient"}` +
              `${r.email_address ? ` (${r.email_address})` : ""} on ${sentDay} and is still UNPAID.` +
              (lead
                ? `\nMatched to lead ${lead.name} (by ${matchedBy}).`
                : `\nNo lead in the app matches this recipient — it may predate the app or ` +
                  `belong to the firm's other work, but an unpaid retainer invoice is money ` +
                  `on the table either way.`) +
              `\nChase it: call/email them, or cancel the invoice if it's dead.` +
              (inv.public_url ? `\nInvoice: ${inv.public_url}` : ""),
            tvcCaseNumber: null,
            memberName: lead?.name ?? recipientName,
            leadId: lead?.id ?? null,
            phone: r.phone_number ?? null,
            email: r.email_address ?? null,
            gmailMessageId: null,
            squareInvoiceId: inv.id,
            receivedAt: sentAt,
            handled: false,
            createdAt: Date.now(),
            updatedAt: Date.now(),
          });
          invoicePostIts++;
        }
      }

      // Settled/dead invoices stand their chase post-it down automatically.
      if (INVOICE_SETTLED_STATUSES.includes(status)) {
        const open = await db
          .collection("messages")
          .where("squareInvoiceId", "==", inv.id)
          .where("handled", "==", false)
          .get();
        for (const m of open.docs) {
          if (m.data().deletedAt) continue;
          await m.ref.update({
            handled: true,
            handledAt: invUpdatedAt,
            handledBy: "Square sync",
            updatedAt: Date.now(),
          });
        }
      }

      await marker.set(
        {
          processedAt: Date.now(),
          status,
          leadId: lead?.id ?? null,
          matchedBy,
          amountCents: cents,
          invoiceNumber: inv.invoice_number ?? null,
          orderId: inv.order_id ?? null,
          recipientName,
          recipientEmail: r.email_address ?? null,
          recipientPhone: r.phone_number ?? null,
          sentAt,
          invoiceUpdatedAt: invUpdatedAt,
        },
        { merge: true },
      );
      logger.info("Square invoice processed", {
        invoiceId: inv.id,
        number: inv.invoice_number ?? null,
        status,
        amount: amountLabel,
        leadId: lead?.id ?? null,
        matchedBy,
        recipient: recipientName,
      });
    }

    await stateRef.set(
      { lastSyncAt: Date.now(), backfillStartAt, invoicesLastSyncAt: Date.now() },
      { merge: true },
    );
    logger.info("Square sync complete", {
      pulled: payments.length,
      completed: completed.length,
      matched,
      unmatched,
      ambiguityPostIts,
      escalationsCleared,
      verifyFlagged,
      verifyCredited,
      invoicesProcessed: invoicesSeen,
      invoicesMatched,
      invoicePostIts,
    });
    await stampHeartbeat("syncSquare");
  },
);
