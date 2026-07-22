import { onSchedule } from "firebase-functions/v2/scheduler";
import { defineSecret } from "firebase-functions/params";
import { logger } from "firebase-functions/v2";
import { getFirestore } from "firebase-admin/firestore";

// Square → TVCHub payments sync.
//
// Every 15 minutes this pulls COMPLETED payments from the Square production
// account (Iron Rock Law Firm) and reconciles them against leads:
//   - a payment matching a lead (phone → email → unique full name) appends a
//     "retained" contact attempt, rolls the money up onto the lead's sale
//     fields (paid_full / paid_partial with a running squarePaidTotal), moves
//     paid-in-full leads to intake_complete, and clears any open
//     billing-escalation post-its — the money arrived, stand the alarm down.
//   - a payment matching nobody only gets an Action Item post-it when it's
//     retainer-sized AND carries suggestive TVC evidence (a CallRail call in
//     the 24h before the charge, an amount lining up with a promised fee, or
//     a partial identity match). The Square account also takes general
//     law-firm charges, so evidence-free strangers are ignored outright.
//
// A verification pass then runs the reconciliation in reverse: leads whose
// transcript claimed money was collected (saleStatus paid_full/paid_partial)
// but where no Square charge ever matched get a billing-escalation post-it —
// "the call says paid, the processor says nothing".
//
// Mirrors the CallRail/Email syncs' safety rules: marker docs
// (squarePayments/{paymentId}) make re-runs harmless, deleted leads are never
// touched, and a paid_full lead is never downgraded. Business dates come from
// the PAYMENT's created_at, not from when the sync got around to processing it.

const SQUARE_ACCESS_TOKEN = defineSecret("SQUARE_ACCESS_TOKEN");
const SQUARE = "https://connect.squareup.com/v2";
const SQUARE_VERSION = "2026-06-18";
const LOCATION_ID = "LPK9GY4PHM28J"; // Iron Rock Law Firm

const last10 = (s: unknown): string =>
  String(s ?? "").replace(/\D/g, "").slice(-10);
const last7 = (s: unknown): string =>
  String(s ?? "").replace(/\D/g, "").slice(-7);
const lc = (s: unknown): string => String(s ?? "").toLowerCase().trim();
// Last word of a full name ("Miguel A Carbo" -> "carbo").
const lastName = (s: unknown): string => {
  const parts = lc(s).split(/\s+/).filter(Boolean);
  return parts.length >= 2 ? parts[parts.length - 1] : "";
};

// Payments below this are likely court fees / small charges, not retainers —
// they still get markers but never raise an unmatched post-it.
const UNMATCHED_POSTIT_MIN_CENTS = 200 * 100;
const MAX_UNMATCHED_POSTITS_PER_RUN = 10;

interface SqMoney {
  amount?: number; // smallest currency unit (cents for USD)
  currency?: string;
}

interface SqPayment {
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

function sqHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    "Square-Version": SQUARE_VERSION,
    "Content-Type": "application/json",
  };
}

async function fetchPayments(token: string, beginTime: string): Promise<SqPayment[]> {
  const payments: SqPayment[] = [];
  let cursor = "";
  do {
    const url =
      `${SQUARE}/payments?location_id=${LOCATION_ID}` +
      `&begin_time=${encodeURIComponent(beginTime)}&sort_order=ASC&limit=100` +
      (cursor ? `&cursor=${encodeURIComponent(cursor)}` : "");
    const res = await fetch(url, { headers: sqHeaders(token) });
    if (!res.ok) throw new Error(`Square payments ${res.status}: ${await res.text()}`);
    const json = (await res.json()) as { payments?: SqPayment[]; cursor?: string };
    payments.push(...(json.payments ?? []));
    cursor = json.cursor ?? "";
  } while (cursor);
  return payments;
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

    // Lead indexes over recent leads (covers the active board plus months of
    // history). Newest lead wins a shared phone/email; names must be unique
    // among leads to count as a match at all.
    const leadSnap = await db
      .collection("leads")
      .orderBy("createdAt", "desc")
      .limit(1000)
      .select("name", "phone", "altPhone", "email", "deletedAt", "saleStatus", "saleAmount")
      .get();
    type LeadRef = { id: string; name: string };
    const byPhone = new Map<string, LeadRef>();
    const byEmail = new Map<string, LeadRef>();
    const byName = new Map<string, LeadRef[]>();
    // Weaker evidence indexes — never enough to CREDIT a payment to a lead,
    // but enough to decide an unmatched charge smells like TVC money.
    const leadLastNames = new Set<string>();
    const leadPhone7 = new Set<string>();
    const openSaleAmounts: number[] = []; // promised_unpaid / paid_partial fees
    for (const doc of leadSnap.docs) {
      const d = doc.data();
      if (d.deletedAt) continue;
      const lead: LeadRef = { id: doc.id, name: d.name };
      for (const p of [d.phone, d.altPhone]) {
        const key = last10(p);
        if (key.length === 10 && !byPhone.has(key)) byPhone.set(key, lead);
        if (last7(p).length === 7) leadPhone7.add(last7(p));
      }
      const email = lc(d.email);
      if (email && !byEmail.has(email)) byEmail.set(email, lead);
      const name = lc(d.name);
      if (name) byName.set(name, [...(byName.get(name) ?? []), lead]);
      if (lastName(d.name)) leadLastNames.add(lastName(d.name));
      if (
        (d.saleStatus === "promised_unpaid" || d.saleStatus === "paid_partial") &&
        typeof d.saleAmount === "number" &&
        d.saleAmount > 0
      ) {
        openSaleAmounts.push(d.saleAmount);
      }
    }

    // TEMPORAL evidence needs every CallRail attempt timestamp — a heavier
    // read (full contactAttempts arrays), so load it lazily and only once,
    // the first time an unmatched payment actually needs evaluating.
    let callrailTs: number[] | null = null;
    const loadCallrailTs = async (): Promise<number[]> => {
      if (callrailTs) return callrailTs;
      const snap = await db
        .collection("leads")
        .orderBy("createdAt", "desc")
        .limit(1000)
        .select("contactAttempts", "deletedAt")
        .get();
      const ts: number[] = [];
      for (const doc of snap.docs) {
        const d = doc.data();
        if (d.deletedAt) continue;
        for (const a of Array.isArray(d.contactAttempts) ? d.contactAttempts : []) {
          if (a?.via === "callrail" && typeof a.ts === "number") ts.push(a.ts);
        }
      }
      callrailTs = ts.sort((a, b) => a - b);
      return callrailTs;
    };

    // Does an unmatched payment carry ANY signal tying it to TVC intake?
    // Returns the signal description, or null for unrelated firm business.
    const AMOUNT_TOLERANCE = 5; // dollars
    const tvcEvidence = async (p: {
      paidTs: number;
      dollars: number;
      payerName: string | null;
      payerPhone: string | null;
      noteText: string | null;
    }): Promise<string | null> => {
      // a. TEMPORAL — a CallRail call (any lead) in the 24h before the charge.
      const calls = await loadCallrailTs();
      if (calls.some((t) => t >= p.paidTs - 24 * 3600_000 && t <= p.paidTs)) {
        return "a CallRail call happened within 24h before the charge";
      }
      // b. AMOUNT — the charge (or 2x, a half-down split) equals an open fee.
      for (const fee of openSaleAmounts) {
        if (Math.abs(p.dollars - fee) <= AMOUNT_TOLERANCE) {
          return `amount matches a lead's open $${fee} fee`;
        }
        if (Math.abs(p.dollars * 2 - fee) <= AMOUNT_TOLERANCE) {
          return `amount is half of a lead's open $${fee} fee`;
        }
      }
      // c. IDENTITY-PARTIAL — last-name or phone-last-7 overlap with a lead.
      // (Email domain alone is deliberately NOT enough.)
      for (const candidate of [p.payerName, p.noteText]) {
        const ln = lastName(candidate);
        if (ln && leadLastNames.has(ln)) return `payer last name "${ln}" matches a lead`;
      }
      const p7 = last7(p.payerPhone);
      if (p7.length === 7 && leadPhone7.has(p7)) return "payer phone (last 7) matches a lead";
      return null;
    };

    const customerCache = new Map<string, SqCustomer | null>();
    let matched = 0;
    let unmatched = 0;
    let unmatchedPostIts = 0;
    let escalationsCleared = 0;

    for (const payment of completed) {
      const marker = db.collection("squarePayments").doc(payment.id);
      if ((await marker.get()).exists) continue;

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

      // Match to a lead: phone beats email beats name; a name only counts
      // when it's exact and unique among leads (no guessing between Smiths).
      let lead: LeadRef | undefined;
      let matchedBy: string | null = null;
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
        // Nobody to credit. The Square account also runs general law-firm
        // charges, so an unmatched payment only earns a post-it when it's
        // retainer-sized AND something ties it to TVC intake; the marker
        // guarantees a note is never re-created for the same payment.
        const evidence = await tvcEvidence({ paidTs, dollars, payerName, payerPhone, noteText });
        if (
          evidence &&
          cents >= UNMATCHED_POSTIT_MIN_CENTS &&
          unmatchedPostIts < MAX_UNMATCHED_POSTITS_PER_RUN
        ) {
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
            subject: `Unmatched Square payment — ${amountLabel}`,
            message:
              `A ${amountLabel} Square payment (${payment.id}) came in on ` +
              `${new Date(paidTs).toLocaleDateString("en-US", { timeZone: "America/Chicago" })} ` +
              `but didn't match any lead by phone, email, or name.\n` +
              (payerBits.length
                ? `Payer info found — ${payerBits.join(" · ")}.`
                : `No payer info was attached to the payment.`) +
              `\nWhy it's flagged: ${evidence}.` +
              `\nMatch it to a lead manually (log the payment and mark the sale paid).`,
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
          unmatchedPostIts++;
        }
        await marker.set({
          processedAt: Date.now(),
          leadId: null,
          action: evidence ? "unmatched" : "ignored_unrelated",
          evidence: evidence ?? null,
          amountCents: cents,
          payerName,
          payerEmail,
          payerPhone,
        });
        unmatched++;
        continue;
      }

      // Confident match — roll the payment onto the lead in a transaction.
      let action = "payment_logged";
      await db.runTransaction(async (tx) => {
        const ref = db.collection("leads").doc(lead!.id);
        const snap = await tx.get(ref);
        if (!snap.exists) return;
        const d = snap.data()!;
        if (d.deletedAt) return;

        const attempts = Array.isArray(d.contactAttempts) ? d.contactAttempts : [];
        // Belt and braces on top of the marker doc: never double-log a payment.
        const alreadyLogged = attempts.some(
          (a: { paymentId?: string; notes?: string }) =>
            a.paymentId === payment.id || (a.notes ?? "").includes(payment.id),
        );

        const now = Date.now();
        const patch: Record<string, unknown> = { updatedAt: now };
        if (!alreadyLogged) {
          patch.contactAttempts = [
            ...attempts,
            {
              ts: paidTs,
              outcome: "retained",
              via: "square",
              notes: `Square payment received — ${amountLabel} (payment ${payment.id})`,
              by: "Square sync",
              paymentId: payment.id,
            },
          ];
        }

        // Sale rollup. squarePaidTotal accumulates every synced payment so
        // installments eventually flip a partial to paid-in-full.
        const paidTotal = ((d.squarePaidTotal as number) ?? 0) + dollars;
        patch.squarePaidTotal = paidTotal;

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
        .where("leadId", "==", lead.id)
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

      await marker.set({
        processedAt: Date.now(),
        leadId: lead.id,
        action,
        matchedBy,
        amountCents: cents,
      });
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
    let verifyFlagged = 0;
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

      const amt = d.saleAmount ? `$${d.saleAmount}` : "an unknown amount";
      const day = new Date(statusAt).toLocaleDateString("en-US", {
        month: "short",
        day: "numeric",
        timeZone: "America/Chicago",
      });
      // Mirrors the cadence engine's billing-escalation post-it convention
      // (see postIt in cadence.ts) so it gets the same gold treatment.
      await db.collection("messages").add({
        kind: "billing_escalation",
        source: "system",
        from: "TVCHub Cadence",
        fromName: "Square Sync",
        subject: `Transcript says PAID but no Square charge — ${d.name}`,
        message:
          `${d.name} was marked ${d.saleStatus === "paid_full" ? "paid in full" : "partially paid"}` +
          ` (${amt}) on ${day}, but no matching Square charge has been found since.` +
          ` Either the payment ran outside Square (check the ledger) or the call's` +
          ` payment claim was wrong — verify the money actually moved.`,
        tvcCaseNumber: null,
        memberName: d.name,
        leadId: doc.id,
        phone: (d.phone as string) ?? null,
        email: (d.email as string) ?? null,
        nonPaymentReason: null,
        noPursuit: false,
        gmailMessageId: null,
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
      });
    }

    await stateRef.set({ lastSyncAt: Date.now(), backfillStartAt }, { merge: true });
    logger.info("Square sync complete", {
      pulled: payments.length,
      completed: completed.length,
      matched,
      unmatched,
      unmatchedPostIts,
      escalationsCleared,
      verifyFlagged,
    });
  },
);
