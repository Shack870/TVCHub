// Pure guard heuristics for email ingestion (see ingest.ts). Split out so the
// stale-re-send rules are unit-testable without Firebase plumbing.
//
// Background (July 2026 QA): TVC occasionally re-sends referral emails for
// cases that were already worked — sometimes months old, sometimes for
// members who have since RETAINED the firm. When such a re-send slipped past
// dedupe it spawned a fresh "new prospect" card, and the cadence engine
// chased a paying client. These guards make a suspicious new card arrive
// flagged for review instead of chase-able.

export const phoneLast10 = (s: unknown): string =>
  String(s ?? "").replace(/\D/g, "").slice(-10);

// TVC case numbers are sequential 6-8 digit ids. An incoming number this far
// below the newest one on file is a stale re-send, not a fresh referral —
// the office receives referrals roughly in case-number order.
export const STALE_CASE_NUMBER_GAP = 20_000;

const asCaseNumber = (s: unknown): number | null => {
  const str = String(s ?? "").trim();
  if (!/^\d{6,8}$/.test(str)) return null;
  return Number(str);
};

const isISODate = (s: unknown): s is string =>
  typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s);

// Why an incoming referral looks like a stale re-send rather than a fresh
// lead — or null when it looks current. `todayISO` is the office's calendar
// day (America/Chicago), compared lexically against the referral's ISO court
// date.
export function staleReferralReason(opts: {
  nextCourtDate?: unknown;
  caseNumber?: unknown;
  newestCaseNumber?: unknown;
  todayISO: string;
}): string | null {
  // A referral whose court date is ALREADY IN THE PAST can't be worked as a
  // fresh prospect — either the case is over or it continued long ago.
  if (isISODate(opts.nextCourtDate) && opts.nextCourtDate < opts.todayISO) {
    return `its court date (${opts.nextCourtDate}) is already in the past`;
  }
  const incoming = asCaseNumber(opts.caseNumber);
  const newest = asCaseNumber(opts.newestCaseNumber);
  if (incoming !== null && newest !== null && newest - incoming > STALE_CASE_NUMBER_GAP) {
    return (
      `its case number (${incoming}) is ${newest - incoming} below the newest ` +
      `referral on file (${newest}) — an old case re-sent, not a fresh one`
    );
  }
  return null;
}
