// No Sale auto-routing (pure logic, no Firebase imports — testable).
//
// A HARD decline detected on a call transcript ("already paid the ticket
// myself", "hired another lawyer", "case already resolved", an explicit final
// refusal) means the lead is dead as a prospect — leaving it sitting in the
// pipeline just burns chase touches on someone who has told us no for good.
// This module decides whether a call's analysis may move a lead to 'lost'
// (the No Sale view's stage). SOFT declines (price objection, wants to think,
// wants to see evidence) never move — they stay on the board.
//
// SAFETY VALVES:
//   - Only unsold leads on the working board move; a paying client is never
//     auto-lost, whatever the transcript says.
//   - A lead a human has EVER revived out of 'lost' (lostRevivedAt, stamped
//     by reviveLost in src/lib/actions.ts) is never auto-re-lost — the human
//     decision outranks every past and future call.
//   - Only calls NEWER than the current lostAt may act, so a stale call
//     arriving late from the API can't re-lose a lead.
//   - A possible-existing-client read (already-hired caller) blocks the
//     route: "my case is already handled" from an actual client is identity
//     ambiguity for a human, not a decline.

export type DeclineType = "none" | "soft" | "hard";

export interface DeclineAnalysis {
  declineType?: DeclineType;
  declineReason?: string | null;
  summary?: string;
  existingClientInquiry?: boolean;
}

// Stages the router may move a lead OUT of — mirrors AUTO_MOVE_FROM in
// callrail.ts (the working board; human-set terminal stages never move).
export const AUTO_ROUTE_FROM = ["new", "callback", "pitched", "attorney_call", "nurture"];

// The one automatic route to No Sale: a hard decline on a call, on an unsold
// board lead. Returns the lead patch plus the audit note for the attempt, or
// null when no move is allowed.
export function hardDeclineMove(
  d: Record<string, unknown>,
  analysis: DeclineAnalysis,
  callTs: number,
): { patch: Record<string, unknown>; note: string } | null {
  if (analysis.declineType !== "hard") return null;
  if (analysis.existingClientInquiry) return null; // human verifies identity first
  // Lead-level twin of the same guard: the possible-existing-client flag
  // means retention may have happened outside the app's view (the Parmjeet
  // Singh case) — "we don't want to continue" from an actual client is a
  // service problem, not a sales decline. Human resolves the flag first.
  if (d.possibleExistingClientAt) return null;
  if (!AUTO_ROUTE_FROM.includes(d.stage as string)) return null;
  // Unsold only — money on the books means this is a client conversation.
  if (typeof d.saleStatus === "string" && (d.saleStatus as string).startsWith("paid")) return null;
  // A human once pulled this lead back OUT of lost — never re-lose it automatically.
  if (d.lostRevivedAt) return null;
  // Stale calls (older than the current lost stamp) can't re-lose a lead.
  if (callTs <= ((d.lostAt as number) ?? 0)) return null;

  // Court reminders survive the move: week-before/day-before touches are the
  // No Sale RESURRECTION path (the cadence keeps running them for lost leads
  // with future court dates), and closing them here would also arm the
  // cadence's proximity dedupe — a completed reminder near the target blocks
  // a re-add, killing the remarketing for good.
  const SURVIVES_LOST = ["week_before", "day_before"];
  const reason =
    (analysis.declineReason || "").trim() ||
    (analysis.summary || "").trim() ||
    "Hard decline on call";
  const day = new Date(callTs).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "America/Chicago",
  });
  const note = `Stage moved to No Sale by classifier — hard decline on ${day} call (${reason})`;
  const now = Date.now();
  const followUps = Array.isArray(d.followUps) ? (d.followUps as Record<string, unknown>[]) : [];
  return {
    patch: {
      stage: "lost",
      // Business dates come from the CALL, not from when the sync processed it.
      lostAt: callTs,
      lostReason: reason,
      autoStageNote: note,
      autoStageAt: now, // when the automation acted — audit metadata only
      // Dead prospect — pending SALES follow-ups (chase, callback, billing,
      // motions heads-up…) no longer apply; close them so they don't linger
      // on the calendar / Today queue. Court reminders stay open (above).
      followUps: followUps.map((f) =>
        f.done || SURVIVES_LOST.includes((f.type as string) ?? "")
          ? f
          : { ...f, done: true, doneAt: now },
      ),
    },
    note,
  };
}
