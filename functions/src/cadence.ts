import { onSchedule } from "firebase-functions/v2/scheduler";
import { logger } from "firebase-functions/v2";
import { getFirestore } from "firebase-admin/firestore";
import { ensureFollowUp } from "./callrail.js";

// Daily contact-cadence sweep (7:00 AM Central, before the calling day).
//
// Mirrors the firm's funnel:
//   1. CHASE — until a real conversation happens, keep a callback on the
//      schedule: daily for the first 4 attempts, every 2 days through 6,
//      every 3 days through 9. At 10 attempts with no connection the chase
//      stops and a decision post-it goes on the desk.
//   2. DECIDE — connected but undecided (they're "thinking"): a follow-up
//      every 3 days so a pitch never goes quiet.
//   3. REMARKET — any active unsold lead with a future court date gets free
//      court-reminder touches at 7 days and 1 day out; if the court date
//      passes with no decision, a post-it asks for the write-off call.
//   0. BILLING (hottest track, runs before the others) — a lead who said YES
//      on a call but didn't pay (saleStatus promised_unpaid) gets a same-day
//      collect-payment follow-up, then one every 2 days. After 3 collection
//      attempts or 7 days unpaid, a decision post-it goes on the desk.
//
// The sweep only ever ADDS follow-ups when a lead has nothing scheduled, and
// never changes stage — humans decide outcomes; this just prevents silence.
//
// A separate RECEIVABLES pass watches the financed book: a payment plan whose
// newest Square payment is 35+ days old gets a stalled-plan post-it (guarded
// by planStallFlaggedAt, which syncSquare clears when money arrives — so a
// plan that stays silent re-flags once per 35-day window).

const DAY = 86400_000;

// No Square payment for this long = the payment plan has stalled. Slightly
// wider than the Financing board's 30-day STALLED badge so the desk post-it
// lands only after the board has already been showing the warning.
const PLAN_STALL_DAYS = 35;

const ACTIVE_STAGES = ["new", "callback", "pitched", "attorney_call", "nurture"];

// Gap required since the last attempt before the next auto callback.
function chaseGapDays(attemptCount: number): number | null {
  if (attemptCount < 4) return 1;
  if (attemptCount < 7) return 2;
  if (attemptCount < 10) return 3;
  return null; // cadence exhausted
}

async function postIt(
  db: ReturnType<typeof getFirestore>,
  lead: { id: string; name: string; phone?: string | null; email?: string | null },
  subject: string,
  message: string,
  opts: {
    kind?: "tvc_message" | "billing_escalation";
    noPursuit?: boolean;
    nonPaymentReason?: string | null;
    // Timestamp of the underlying event (promise call, last attempt, court
    // date). The post-it displays receivedAt, so it must reflect when the
    // thing HAPPENED, not when the sweep got around to writing the note.
    eventAt?: number;
  } = {},
): Promise<void> {
  await db.collection("messages").add({
    kind: opts.kind ?? "tvc_message",
    source: "system",
    from: "TVCHub Cadence",
    fromName: "Cadence Engine",
    subject,
    message,
    tvcCaseNumber: null,
    memberName: lead.name,
    leadId: lead.id,
    phone: lead.phone ?? null,
    email: lead.email ?? null,
    nonPaymentReason: opts.nonPaymentReason ?? null,
    noPursuit: opts.noPursuit ?? false,
    gmailMessageId: null,
    receivedAt: opts.eventAt ?? Date.now(),
    handled: false,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });
}

export const cadenceSweep = onSchedule(
  { schedule: "0 7 * * *", timeZone: "America/Chicago", timeoutSeconds: 300 },
  async () => {
    const db = getFirestore();
    const snap = await db.collection("leads").where("stage", "in", ACTIVE_STAGES).get();
    const now = Date.now();
    let chased = 0;
    let nudged = 0;
    let reminders = 0;
    let flagged = 0;
    let billing = 0;

    for (const doc of snap.docs) {
      const d = doc.data();
      if (d.deletedAt) continue;
      const lead = {
        id: doc.id,
        name: (d.name as string) || "(unnamed)",
        phone: (d.phone as string) || null,
        email: (d.email as string) || null,
      };
      const attempts: { ts?: number; outcome?: string }[] = Array.isArray(d.contactAttempts)
        ? d.contactAttempts
        : [];
      const followUps: { done?: boolean; dueAt?: number; type?: string }[] = Array.isArray(
        d.followUps,
      )
        ? d.followUps
        : [];
      const openFollowUps = followUps.filter((f) => !f.done);
      const lastAttemptTs = attempts.reduce((m, a) => Math.max(m, a.ts ?? 0), 0);
      const connected =
        Boolean(d.lastConnectedAt) ||
        attempts.some((a) =>
          ["spoke", "thinking", "declined", "retained", "wants_attorney"].includes(
            a.outcome ?? "",
          ),
        );

      // --- 0. BILLING: they said yes but haven't paid ------------------------
      // Hottest track — the pitch is done and money was promised, so nothing
      // else (chase/nudge) applies while this is open.
      if (d.saleStatus === "promised_unpaid") {
        const promisedAt = (d.salePromisedAt as number) || (d.saleStatusAt as number) || now;
        const collectionAttempts = attempts.filter((a) => (a.ts ?? 0) > promisedAt).length;
        const openBilling = openFollowUps.some((f) => f.type === "billing");
        const amt = d.saleAmount ? `$${d.saleAmount}` : "payment";
        const promisedDate = new Date(promisedAt).toLocaleDateString("en-US", {
          month: "short",
          day: "numeric",
          timeZone: "America/Chicago",
        });
        const reason = (d.saleNonPaymentReason as string) || null;

        // PURSUIT VERIFICATION — the loudest alarm we have. contactAttempts
        // includes every call in or out (CallRail-synced and hand-logged), so
        // zero attempts after the promise means the money is waiting purely
        // on us: nobody called them and they never got through to us.
        let escalated = Boolean(d.saleEscalatedAt);
        if (collectionAttempts === 0 && !d.salePursuitAlertAt && now - promisedAt >= DAY) {
          // The alarm doubles as the escalation post-it (its loudest form), so
          // stamp saleEscalatedAt too — otherwise the 7-day branch below would
          // drop a second, quieter note for the same money.
          await doc.ref.update({
            salePursuitAlertAt: now,
            saleEscalatedAt: d.saleEscalatedAt ?? now,
            updatedAt: now,
          });
          escalated = true;
          await postIt(
            db,
            lead,
            `NO CALLBACK MADE — ${amt} promised ${promisedDate}`,
            `${lead.name} said YES on ${promisedDate} and ${amt} is on the table, but ZERO calls` +
              ` (in or out) have happened since. This money is waiting purely on us — call them NOW.` +
              (reason ? `\nWhy it wasn't collected on the call: ${reason}` : ""),
            {
              kind: "billing_escalation",
              noPursuit: true,
              nonPaymentReason: reason,
              eventAt: promisedAt,
            },
          );
          flagged++;
        } else if (collectionAttempts > 0 && d.salePursuitAlertAt) {
          // A call happened since the promise — stand the alarm down to the
          // normal billing escalation treatment.
          await doc.ref.update({ salePursuitAlertAt: null, updatedAt: now });
          const open = await db
            .collection("messages")
            .where("leadId", "==", lead.id)
            .where("kind", "==", "billing_escalation")
            .where("handled", "==", false)
            .get();
          for (const m of open.docs) {
            if (!m.data().noPursuit || m.data().deletedAt) continue;
            await m.ref.update({
              noPursuit: false,
              subject: `Promised ${amt} never collected: ${lead.name}`,
              updatedAt: now,
            });
          }
        }

        if (!escalated && (collectionAttempts >= 3 || now - promisedAt >= 7 * DAY)) {
          // Money has been on the table too long — put the decision on the desk.
          await doc.ref.update({ saleEscalatedAt: now, updatedAt: now });
          await postIt(
            db,
            lead,
            `Promised ${amt} never collected: ${lead.name}`,
            `Said yes on ${new Date(promisedAt).toLocaleDateString("en-US")} but ${amt} was never collected` +
              ` (${collectionAttempts} collection attempt${collectionAttempts === 1 ? "" : "s"} since).` +
              ` Decide: keep collecting, re-pitch, or release the file.`,
            { kind: "billing_escalation", nonPaymentReason: reason, eventAt: promisedAt },
          );
          flagged++;
        } else if (!openBilling && (collectionAttempts === 0 || now - lastAttemptTs >= 2 * DAY)) {
          const amt = d.saleAmount ? ` ($${d.saleAmount} promised)` : "";
          const added = await ensureFollowUp(db, lead.id, {
            dueAt: now,
            note: `Collect payment — said YES${amt}, still unpaid`,
            withinMs: 12 * 3600_000,
            type: "billing",
          });
          if (added) billing++;
        }
        // Billing owns this lead's cadence; court reminders still apply below.
      } else if (!connected) {
        // --- 1. CHASE: no conversation yet -----------------------------------
        const gap = chaseGapDays(attempts.length);
        if (gap === null) {
          // Exhausted. Flag once; court reminders (below) keep running.
          if (!d.cadenceExhaustedAt) {
            await doc.ref.update({ cadenceExhaustedAt: now, updatedAt: now });
            await postIt(
              db,
              lead,
              `No connection after ${attempts.length} attempts: ${lead.name}`,
              `${attempts.length} contact attempts with no real conversation.` +
                (d.nextCourtDate
                  ? ` Court date ${d.nextCourtDate} — free court reminders will continue; decide whether to keep the file open.`
                  : ` No court date on file — decide: keep chasing or write off.`),
              { eventAt: lastAttemptTs || undefined },
            );
            flagged++;
          }
        } else if (openFollowUps.length === 0 && now - lastAttemptTs >= gap * DAY) {
          const added = await ensureFollowUp(db, lead.id, {
            dueAt: now,
            note: `Auto cadence — attempt #${attempts.length + 1} (no connection yet)`,
            withinMs: 12 * 3600_000,
          });
          if (added) chased++;
        }
        // Chase phase handled; still fall through to court reminders below.
      } else if (!["retained", "financed", "intake_complete", "lost"].includes(d.stage)) {
        // --- 2. DECIDE: connected but no decision ---------------------------
        if (openFollowUps.length === 0 && now - lastAttemptTs >= 3 * DAY) {
          const added = await ensureFollowUp(db, lead.id, {
            dueAt: now,
            note: "Auto cadence — pitched/undecided, don't let it go quiet",
            withinMs: 12 * 3600_000,
          });
          if (added) nudged++;
        }
      }

      // --- 3. REMARKET: free court-date reminders for unsold leads ---------
      const courtDate = typeof d.nextCourtDate === "string" ? d.nextCourtDate : null;
      if (courtDate && /^\d{4}-\d{2}-\d{2}$/.test(courtDate)) {
        const courtMs = new Date(`${courtDate}T09:00:00-05:00`).getTime();
        if (courtMs > now) {
          const targets: { type: string; dueAt: number; note: string }[] = [
            {
              type: "week_before",
              dueAt: courtMs - 7 * DAY,
              note: "Free court reminder — 1 week out (remarketing touch)",
            },
            {
              type: "day_before",
              dueAt: courtMs - DAY,
              note: "Free court reminder — court is tomorrow (remarketing touch)",
            },
          ];
          for (const t of targets) {
            if (t.dueAt < now - DAY) continue; // window already passed
            // Skip if a reminder of this type already exists near the target,
            // whether it's open or already completed.
            const exists = followUps.some(
              (f) => f.type === t.type && Math.abs((f.dueAt ?? 0) - t.dueAt) < 3 * DAY,
            );
            if (exists) continue;
            const added = await ensureFollowUp(db, lead.id, {
              dueAt: Math.max(t.dueAt, now),
              note: t.note,
              withinMs: 6 * 3600_000,
              type: t.type,
            });
            if (added) reminders++;
          }
        } else if (courtMs < now && !d.courtPassedNotifiedAt) {
          // Court date came and went with the lead still undecided.
          await doc.ref.update({ courtPassedNotifiedAt: now, updatedAt: now });
          // Only raise a post-it when the date passed recently. Anything older
          // is historical backlog — flag it silently so the first sweep after
          // a deploy doesn't flood the desk with dozens of notes at once.
          if (now - courtMs <= 10 * DAY) {
            await postIt(
              db,
              lead,
              `Court date passed: ${lead.name}`,
              `Their court date (${courtDate}) has passed and the lead was never retained or written off. Close it out or check how the case went.`,
              { eventAt: courtMs },
            );
            flagged++;
          }
        }
      }
    }

    // --- RECEIVABLES: stalled financed payment plans ------------------------
    // A financed case is supposed to keep producing Square payments. When the
    // newest one is PLAN_STALL_DAYS+ old (or none ever landed and the case has
    // sat financed that long), put a post-it on the desk. planStallFlaggedAt
    // guards the flag: syncSquare clears it when a payment arrives, and a plan
    // that stays silent re-flags once per stall window.
    let stalledPlans = 0;
    const financedSnap = await db.collection("leads").where("stage", "==", "financed").get();
    for (const doc of financedSnap.docs) {
      const d = doc.data();
      if (d.deletedAt) continue;
      const flaggedAt = (d.planStallFlaggedAt as number) ?? 0;
      if (flaggedAt && now - flaggedAt < PLAN_STALL_DAYS * DAY) continue;

      const attempts: { ts?: number; via?: string }[] = Array.isArray(d.contactAttempts)
        ? d.contactAttempts
        : [];
      const lastPaymentTs = attempts
        .filter((a) => a?.via === "square" && typeof a.ts === "number")
        .reduce((m, a) => Math.max(m, a.ts as number), 0);
      // Never paid at all: age the plan from when it entered its financed /
      // paid state instead, so a plan that never produced a payment still trips.
      const anchor =
        lastPaymentTs ||
        (d.intakeCompleteAt as number) ||
        (d.saleStatusAt as number) ||
        0;
      if (!anchor || now - anchor < PLAN_STALL_DAYS * DAY) continue;

      const daysSince = Math.floor((now - anchor) / DAY);
      const collected = (d.squarePaidTotal as number) ?? 0;
      const saleAmount =
        typeof d.saleAmount === "number" && d.saleAmount > 0 ? (d.saleAmount as number) : null;
      const outstanding = saleAmount !== null ? Math.max(0, saleAmount - collected) : null;
      const lead = {
        id: doc.id,
        name: (d.name as string) || "(unnamed)",
        phone: (d.phone as string) || null,
        email: (d.email as string) || null,
      };

      await doc.ref.update({ planStallFlaggedAt: now, updatedAt: now });
      await postIt(
        db,
        lead,
        `Payment plan stalled — ${lead.name}`,
        `${lead.name} is financed but ` +
          (lastPaymentTs
            ? `their last Square payment was ${daysSince} days ago.`
            : `no Square payment has ever landed (${daysSince} days on the plan).`) +
          ` Collected so far: $${collected.toFixed(2)}` +
          (outstanding !== null
            ? ` of $${saleAmount!.toFixed(2)} — $${outstanding.toFixed(2)} still outstanding.`
            : ` (no total fee on file).`) +
          ` Call them and get the plan moving again.` +
          (lead.phone ? `\nPhone: ${lead.phone}` : "") +
          (lead.email ? `\nEmail: ${lead.email}` : ""),
        // The post-it dates from when the money went quiet, not from the sweep.
        { eventAt: lastPaymentTs || anchor },
      );
      stalledPlans++;
    }

    logger.info("Cadence sweep complete", {
      activeLeads: snap.size,
      billingFollowUps: billing,
      chaseCallbacks: chased,
      undecidedNudges: nudged,
      courtReminders: reminders,
      decisionPostIts: flagged,
      stalledPlanPostIts: stalledPlans,
    });
  },
);
