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
//
// The sweep only ever ADDS follow-ups when a lead has nothing scheduled, and
// never changes stage — humans decide outcomes; this just prevents silence.

const DAY = 86400_000;

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
  lead: { id: string; name: string },
  subject: string,
  message: string,
): Promise<void> {
  await db.collection("messages").add({
    kind: "tvc_message",
    from: "TVCHub Cadence",
    fromName: "Cadence Engine",
    subject,
    message,
    tvcCaseNumber: null,
    memberName: lead.name,
    leadId: lead.id,
    gmailMessageId: null,
    receivedAt: Date.now(),
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

    for (const doc of snap.docs) {
      const d = doc.data();
      if (d.deletedAt) continue;
      const lead = { id: doc.id, name: (d.name as string) || "(unnamed)" };
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
        Boolean(d.lastConnectedAt) || attempts.some((a) => a.outcome === "spoke");

      // --- 1. CHASE: no conversation yet -----------------------------------
      if (!connected) {
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
      } else if (!["retained", "intake_complete", "lost"].includes(d.stage)) {
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
            );
            flagged++;
          }
        }
      }
    }

    logger.info("Cadence sweep complete", {
      activeLeads: snap.size,
      chaseCallbacks: chased,
      undecidedNudges: nudged,
      courtReminders: reminders,
      decisionPostIts: flagged,
    });
  },
);
