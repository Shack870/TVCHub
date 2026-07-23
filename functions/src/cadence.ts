import { onSchedule } from "firebase-functions/v2/scheduler";
import { logger } from "firebase-functions/v2";
import { getFirestore } from "firebase-admin/firestore";
import { ensureFollowUp } from "./callrail.js";
import { motionsDeadlineFor, type MotionsDeadline } from "./motionsDeadline.js";

// Daily contact-cadence sweep (7:00 AM Central, before the calling day).
//
// Mirrors the firm's funnel:
//   1. CHASE — a voicemail is NOT a contact. Until a real conversation
//      happens, keep the next touch on the schedule on a decaying cadence
//      keyed off the last attempt: #1→+2d, #2→+3d, #3→+6d, #4+→weekly.
//      Every chase follow-up carries the touch number, an escalating script
//      angle, and a time-of-day hint. The chase HARD-STOPS when the next
//      touch would land AFTER the lead's motions-filing deadline (derived
//      from court date + state — see motionsDeadline.ts; the free
//      court-reminder remarketing becomes the final hook) or after
//      8 total attempts, at which point a decision post-it goes on the desk.
//      Chase follow-ups coexist with the far-future court reminders — a
//      parked week-before/day-before reminder no longer masks the silence.
//   2. DECIDE — connected but undecided (they're "thinking"): a follow-up
//      every 3 days so a pitch never goes quiet.
//   3. REMARKET — any active unsold lead with a future court date gets free
//      court-reminder touches at 7 days and 1 day out, plus a free
//      motions-deadline heads-up call ~6 days before the last day to file
//      (the continuance pitch: they don't want to travel — we can file the
//      Motion to Continue). If the court date passes with no decision, a
//      post-it asks for the write-off call.
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
//
// NOTE ON SCOPE: TVCHub is sales/intake only. The motions deadline exists
// here as a SALES tool for UNSOLD leads (the free deadline heads-up is a
// remarketing touch, and the continuance pitch is the close). Once a client
// retains and is handed to the PDF app, TVCHub is agnostic about their legal
// deadlines — no operational filing reminders flow upstream from PDF-app
// concerns.

const DAY = 86400_000;

// No Square payment for this long = the payment plan has stalled. Slightly
// wider than the Financing board's 30-day STALLED badge so the desk post-it
// lands only after the board has already been showing the warning.
const PLAN_STALL_DAYS = 35;

const ACTIVE_STAGES = ["new", "callback", "pitched", "attorney_call", "nurture"];

// --- Settled-plan check (mirrors src/lib/paymentLedger.ts) ------------------
// Functions can't import from src/, so the unified ledger's settled rules are
// replicated here — keep in sync with paymentLedger.ts:
//   collected = squarePaidTotal + manual financing.payments that are NOT the
//               same money as a Square charge (a manual entry is dropped when
//               a Square charge of the same amount within $1 landed within
//               5 days of it — the Square copy wins);
//   fee       = financing.totalFee + warrantFee when set, else saleAmount,
//               else null (unknown);
//   settled   = saleStatus 'paid_full', or fee known and collected >= fee.
// An unknown fee is NOT settled — a financed lead with payments but no fee on
// file stays on the stall watch.

const DUPLICATE_AMOUNT_TOLERANCE = 1; // dollars
const DUPLICATE_WINDOW_MS = 5 * 86400_000; // ± 5 days
const SQUARE_NOTE_AMOUNT = /Square payment received — \$([\d,]+(?:\.\d+)?)/;

export function isSettledPlan(d: FirebaseFirestore.DocumentData): boolean {
  if (d.saleStatus === "paid_full") return true;

  const fin = (d.financing ?? {}) as {
    totalFee?: number;
    warrantFee?: number;
    payments?: { date?: number; amount?: number }[];
  };
  const manualFee = (fin.totalFee ?? 0) + (fin.warrantFee ?? 0);
  const fee =
    manualFee > 0
      ? manualFee
      : typeof d.saleAmount === "number" && d.saleAmount > 0
        ? (d.saleAmount as number)
        : null;
  if (fee === null) return false; // unknown fee ≠ paid off

  // Individual Square charges, parsed from the sync's contact-attempt trail
  // (used only for the duplicate guard; the total comes from squarePaidTotal).
  const attempts: { ts?: number; via?: string; notes?: string }[] = Array.isArray(
    d.contactAttempts,
  )
    ? d.contactAttempts
    : [];
  const square: { ts: number; amount: number }[] = [];
  for (const a of attempts) {
    if (a?.via !== "square" || typeof a.ts !== "number") continue;
    const m = SQUARE_NOTE_AMOUNT.exec(a.notes ?? "");
    if (!m) continue;
    const amount = parseFloat(m[1].replace(/,/g, ""));
    if (!Number.isFinite(amount) || amount <= 0) continue;
    square.push({ ts: a.ts, amount });
  }

  const manualPayments = Array.isArray(fin.payments) ? fin.payments : [];
  const manualCollected = manualPayments.reduce((sum, p) => {
    const amount = typeof p?.amount === "number" ? p.amount : 0;
    const date = typeof p?.date === "number" ? p.date : 0;
    const duplicatesSquare = square.some(
      (s) =>
        Math.abs(s.amount - amount) <= DUPLICATE_AMOUNT_TOLERANCE &&
        Math.abs(s.ts - date) <= DUPLICATE_WINDOW_MS,
    );
    return duplicatesSquare ? sum : sum + amount;
  }, 0);

  const collected = ((d.squarePaidTotal as number) ?? 0) + manualCollected;
  return collected >= fee;
}

// Outcomes that mean a real two-way conversation happened. A voicemail or
// no-answer is NOT a contact — the chase keeps running until one of these
// lands. Mirrors CONVERSATION_OUTCOMES in src/lib/leadFlow.ts.
const CONVERSATION_OUTCOMES = [
  "spoke",
  "thinking",
  "declined",
  "verbal_yes",
  "wants_attorney",
  "retained",
  "lost",
];

// The chase stops for good after this many total attempts with no
// conversation. Mirrors MAX_CHASE_ATTEMPTS in src/lib/leadFlow.ts.
const MAX_CHASE_ATTEMPTS = 8;

// The chase used to stand down a flat 21 days before court; it now stands
// down once the next touch would land AFTER the lead's actual motions-filing
// deadline (state-aware, weekend/holiday adjusted — motionsDeadline.ts).
// After that the free court-reminder remarketing (week-before / day-before)
// is the final hook.

// The local-courthouse "today" for deadline math (court dates are Central).
function chicagoDayISO(ms: number): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Chicago",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(ms));
}

// "Mon, Aug 3" for an ISO yyyy-mm-dd — the shape the phone script reads out.
function fmtDeadlineHuman(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) return iso;
  return new Date(+m[1], +m[2] - 1, +m[3]).toLocaleDateString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
  });
}

// Decaying gap (days) since the last attempt before the next chase touch.
// attempts so far: 1→+2, 2→+3, 3→+6, 4→+7, 5+→weekly; null = exhausted.
function chaseGapDays(attemptCount: number): number | null {
  if (attemptCount <= 1) return 2;
  if (attemptCount === 2) return 3;
  if (attemptCount === 3) return 6;
  if (attemptCount < MAX_CHASE_ATTEMPTS) return 7;
  return null; // cadence exhausted
}

// Escalating script angle for a given chase touch number. Mirrors
// chaseAngleForTouch in src/lib/leadFlow.ts — keep the copy in sync.
function chaseAngleForTouch(touch: number): string {
  if (touch <= 2) return "Be specific: court date, county, what a conviction does to a CDL";
  if (touch === 3) return "Anchor price + ease: most drivers never appear in person — we handle it";
  return "Deadline framing: we need time to file entry of appearance";
}

// Full note for a chase follow-up: touch number, script angle, a
// time-of-day hint (drivers pick up at different hours), and — when the
// last attempt was a voicemail — a prompt for the office to shadow it with
// an email. The email is sent by a human; the note is only the prompt.
// Touch #4+ uses the deadline-framing angle, so it carries the REAL computed
// motions deadline for the script to read out.
function chaseNote(
  touch: number,
  lastAttemptTs: number,
  lastOutcome: string,
  deadline?: MotionsDeadline | null,
): string {
  const hour = Number(
    new Intl.DateTimeFormat("en-US", {
      hour: "numeric",
      hour12: false,
      timeZone: "America/Chicago",
    }).format(new Date(lastAttemptTs)),
  );
  const todHint =
    hour < 15 ? "Last try was before 3pm — try evening." : "Last try was after 3pm — try morning.";
  let note = `Chase touch #${touch} — ${chaseAngleForTouch(touch)}. ${todHint}`;
  if (touch >= 4 && deadline && !deadline.passed) {
    note += ` Last day to file for a continuance is ${fmtDeadlineHuman(deadline.date)}.`;
  }
  if (lastOutcome === "voicemail") {
    note += " Shadow it with an email referencing the voicemail.";
  }
  return note;
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
  {
    schedule: "0 7 * * *",
    timeZone: "America/Chicago",
    timeoutSeconds: 300,
  },
  async () => {
    const db = getFirestore();
    const snap = await db.collection("leads").where("stage", "in", ACTIVE_STAGES).get();
    const now = Date.now();
    const todayISO = chicagoDayISO(now);
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
        attempts.some((a) => CONVERSATION_OUTCOMES.includes(a.outcome ?? ""));
      const courtDate =
        typeof d.nextCourtDate === "string" && /^\d{4}-\d{2}-\d{2}$/.test(d.nextCourtDate)
          ? (d.nextCourtDate as string)
          : null;
      const courtMs = courtDate ? new Date(`${courtDate}T09:00:00-05:00`).getTime() : null;
      // Motions-filing deadline, derived from court date + state (never
      // stored) — drives the chase hard stop and the touch-4+ script date.
      const ddl = motionsDeadlineFor(
        { nextCourtDate: courtDate, state: d.state as string | undefined },
        todayISO,
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
      } else if (typeof d.saleStatus === "string" && d.saleStatus.startsWith("paid")) {
        // Paid leads have their own billing/graduation handling (syncSquare /
        // the Square-verify alarm) — no chase or nudge. Court reminders still
        // apply below.
      } else if (!connected) {
        // --- 1. CHASE: no real conversation yet — a voicemail doesn't count --
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
        } else if (attempts.length === 0) {
          // Never touched: put the first attempt on the schedule if nothing is.
          if (openFollowUps.length === 0) {
            const added = await ensureFollowUp(db, lead.id, {
              dueAt: now,
              note: "Auto cadence — attempt #1 (never contacted)",
              withinMs: 12 * 3600_000,
            });
            if (added) chased++;
          }
        } else {
          const last = attempts.reduce((m, a) => ((a.ts ?? 0) >= (m.ts ?? 0) ? a : m));
          const lastOutcome = last.outcome ?? "";
          if (lastOutcome === "voicemail" || lastOutcome === "no_answer") {
            // Next touch on the decaying schedule, keyed off the last attempt
            // (never in the past — the sweep runs daily and catches up).
            const dueAt = Math.max(now, lastAttemptTs + gap * DAY);
            // HARD STOP: once the next touch would land AFTER the lead's
            // motions deadline (a continuance can no longer be filed — ddl is
            // also null when the court date itself has passed), the
            // court-reminder remarketing is the final hook.
            const pastMotionsDeadline =
              courtMs !== null && (ddl === null || chicagoDayISO(dueAt) > ddl.date);
            // Idempotent: any open non-court-reminder follow-up (a pending
            // chase, a manual callback, a billing touch) means the next touch
            // is already scheduled. Far-future court reminders deliberately
            // do NOT count — they were masking three-week silences.
            const hasOpenTouch = openFollowUps.some(
              (f) => !["week_before", "day_before", "warrant"].includes(f.type ?? ""),
            );
            if (!pastMotionsDeadline && !hasOpenTouch) {
              const added = await ensureFollowUp(db, lead.id, {
                dueAt,
                note: chaseNote(attempts.length + 1, lastAttemptTs, lastOutcome, ddl),
                withinMs: 12 * 3600_000,
                type: "chase",
              });
              if (added) chased++;
            }
          } else if (openFollowUps.length === 0 && now - lastAttemptTs >= gap * DAY) {
            // Odd last outcome (auto-logged email/etc.) — keep the legacy
            // generic callback so the lead still can't go silent.
            const added = await ensureFollowUp(db, lead.id, {
              dueAt: now,
              note: `Auto cadence — attempt #${attempts.length + 1} (no connection yet)`,
              withinMs: 12 * 3600_000,
            });
            if (added) chased++;
          }
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
      if (courtDate && courtMs !== null) {
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
          // Free motions-deadline heads-up, ~6 days before the last day to
          // file — the SALES touch this deadline exists for: free value plus
          // the continuance pitch. Unsold leads only (paid_* clients are the
          // PDF app's concern); promised_unpaid still counts — they haven't
          // completed. Same type+proximity dedupe as the court reminders, so
          // it fires once per deadline and a continuance re-arms it.
          const sold = typeof d.saleStatus === "string" && d.saleStatus.startsWith("paid");
          if (!sold && ddl && !ddl.passed) {
            const ddlMs = new Date(`${ddl.date}T09:00:00-05:00`).getTime();
            targets.push({
              type: "week_before",
              dueAt: ddlMs - 6 * DAY,
              note:
                `Free deadline heads-up call — last day to file (incl. Motion to ` +
                `Continue) is ${fmtDeadlineHuman(ddl.date)}. They don't want to ` +
                `travel: pitch us handling the continuance.`,
            });
          }
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
      // Paid-off plans (per the unified ledger — see isSettledPlan) are done;
      // silence is expected, not a stall. Only genuinely active plans are watched.
      if (isSettledPlan(d)) continue;
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
