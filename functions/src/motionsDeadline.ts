// Motions-filing deadline math — MIRRORS src/lib/motionsDeadline.ts.
// Functions can't import from src/, so the shared helper is replicated here
// (same precedent as the paymentLedger port in cadence.ts isSettledPlan).
// Keep the two modules in sync.
//
// Every court date carries a last-day-to-file deadline (including a Motion to
// Continue — for unsold leads that's "Last Day to File for a Continuance"),
// and it is DERIVED from the lead's court date + state, never stored.
//
// Rules:
//   ARKANSAS ('AR', and the default for unknown states — most cases are AR):
//     deadline = 20 CALENDAR days before the court date; a weekend/holiday
//     landing rolls BACKWARD to the preceding business day.
//   MISSOURI ('MO'): Mo. Sup. Ct. Rule 44.01(c) — motion + notice served no
//     later than 5 days before the hearing; the period is under 7 days, so
//     Rule 44.01(a) EXCLUDES Saturdays, Sundays, and legal holidays from the
//     count: count back 5 BUSINESS days from the hearing date. Example: a
//     Friday hearing → deadline the preceding Friday (absent holidays).
//
// Legal holidays: the federal-holiday calendar (observed dates), computed
// below. NOTE this is an APPROXIMATION — state court holiday calendars may
// add days; verify against the court's own calendar when a deadline matters.

export type MotionsRule = "AR-20cal" | "MO-5biz";

export interface MotionsDeadline {
  date: string; // ISO yyyy-mm-dd — the last day a motion can be filed
  daysLeft: number; // calendar days from `today` (0 = today, negative = passed)
  rule: MotionsRule;
  passed: boolean;
}

const pad2 = (n: number) => String(n).padStart(2, "0");
const toISO = (d: Date) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
const fromISO = (iso: string): Date | null => {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  return m ? new Date(+m[1], +m[2] - 1, +m[3]) : null;
};
const addDays = (d: Date, n: number) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);

function nthWeekday(year: number, month: number, weekday: number, nth: number): Date {
  const first = new Date(year, month, 1);
  const offset = (weekday - first.getDay() + 7) % 7;
  return new Date(year, month, 1 + offset + (nth - 1) * 7);
}

function lastWeekday(year: number, month: number, weekday: number): Date {
  const last = new Date(year, month + 1, 0);
  const offset = (last.getDay() - weekday + 7) % 7;
  return new Date(year, month, last.getDate() - offset);
}

// Sat holidays are observed the preceding Fri; Sun holidays the following Mon.
function observed(d: Date): Date {
  if (d.getDay() === 6) return addDays(d, -1);
  if (d.getDay() === 0) return addDays(d, 1);
  return d;
}

export function federalHolidays(year: number): Set<string> {
  const out = new Set<string>();
  const fixed = (month: number, day: number) => observed(new Date(year, month, day));
  const days: Date[] = [
    fixed(0, 1), // New Year's Day
    nthWeekday(year, 0, 1, 3), // MLK Day — 3rd Mon of Jan
    nthWeekday(year, 1, 1, 3), // Washington's Birthday — 3rd Mon of Feb
    lastWeekday(year, 4, 1), // Memorial Day — last Mon of May
    fixed(5, 19), // Juneteenth
    fixed(6, 4), // Independence Day
    nthWeekday(year, 8, 1, 1), // Labor Day — 1st Mon of Sep
    fixed(10, 11), // Veterans Day
    nthWeekday(year, 10, 4, 4), // Thanksgiving — 4th Thu of Nov
    fixed(11, 25), // Christmas Day
    observed(new Date(year + 1, 0, 1)), // next New Year's when observed Dec 31
  ];
  for (const d of days) {
    if (d.getFullYear() === year) out.add(toISO(d));
  }
  return out;
}

const holidayCache = new Map<number, Set<string>>();

function isLegalHoliday(d: Date): boolean {
  const y = d.getFullYear();
  let set = holidayCache.get(y);
  if (!set) {
    set = federalHolidays(y);
    holidayCache.set(y, set);
  }
  return set.has(toISO(d));
}

function isBusinessDay(d: Date): boolean {
  const dow = d.getDay();
  return dow !== 0 && dow !== 6 && !isLegalHoliday(d);
}

export function ruleForState(state?: string | null): MotionsRule {
  return String(state ?? "").trim().toUpperCase() === "MO" ? "MO-5biz" : "AR-20cal";
}

export function motionsDeadlineDate(courtDateISO: string, rule: MotionsRule): string | null {
  const court = fromISO(courtDateISO);
  if (!court) return null;
  if (rule === "MO-5biz") {
    let d = court;
    let counted = 0;
    while (counted < 5) {
      d = addDays(d, -1);
      if (isBusinessDay(d)) counted++;
    }
    return toISO(d);
  }
  let d = addDays(court, -20);
  while (!isBusinessDay(d)) d = addDays(d, -1);
  return toISO(d);
}

// The deadline for a lead-shaped doc, judged against a caller-supplied
// local-courthouse "today" (the sweep passes the current America/Chicago
// date). Null when there's no upcoming court date.
export function motionsDeadlineFor(
  lead: { nextCourtDate?: string | null; state?: string | null },
  todayISO: string,
): MotionsDeadline | null {
  const courtISO =
    typeof lead.nextCourtDate === "string" && /^\d{4}-\d{2}-\d{2}$/.test(lead.nextCourtDate)
      ? lead.nextCourtDate
      : null;
  if (!courtISO) return null;
  const court = fromISO(courtISO);
  const today = fromISO(todayISO);
  if (!court || !today) return null;
  const dayDiff = (a: Date, b: Date) => Math.round((a.getTime() - b.getTime()) / 86400_000);
  if (dayDiff(court, today) < 0) return null; // court already passed

  const rule = ruleForState(lead.state);
  const date = motionsDeadlineDate(courtISO, rule);
  if (!date) return null;
  const deadline = fromISO(date)!;
  const daysLeft = dayDiff(deadline, today);
  return { date, daysLeft, rule, passed: daysLeft < 0 };
}
