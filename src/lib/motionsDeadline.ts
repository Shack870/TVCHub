import { differenceInCalendarDays, isValid, parseISO } from 'date-fns';
import type { Lead } from '../types';

// THE one source of truth for motions-filing deadlines. Every court date
// carries a last-day-to-file deadline (including a Motion to Continue — for
// unsold leads that's "Last Day to File for a Continuance"), and it is
// DERIVED from the lead's court date + state everywhere, never stored.
//
// Rules:
//   ARKANSAS ('AR', and the default for unknown states — most cases are AR):
//     deadline = 20 CALENDAR days before the court date. If that lands on a
//     Saturday, Sunday, or legal holiday, roll BACKWARD to the preceding
//     business day.
//   MISSOURI ('MO'): per Mo. Sup. Ct. Rule 44.01(c) a written motion + notice
//     must be served no later than 5 days before the hearing; because that
//     period is under 7 days, Rule 44.01(a) EXCLUDES Saturdays, Sundays, and
//     legal holidays from the count. So: count back 5 BUSINESS days (skipping
//     weekends and legal holidays) from the hearing date. Example: a Friday
//     hearing → deadline the preceding Friday (absent holidays).
//
// Legal holidays: the federal-holiday calendar (observed dates), computed in
// code below. NOTE this is an APPROXIMATION — state court holiday calendars
// (AR and MO both) may add days (state holidays, court closure days); when a
// deadline matters, verify against the court's own calendar.
//
// Mirrored in functions/src/motionsDeadline.ts (functions can't import src/,
// same precedent as paymentLedger.ts / isSettledPlan) — keep the two in sync.

export type MotionsRule = 'AR-20cal' | 'MO-5biz';

export interface MotionsDeadline {
  date: string; // ISO yyyy-mm-dd — the last day a motion can be filed
  daysLeft: number; // calendar days from today (0 = today, negative = passed)
  rule: MotionsRule;
  passed: boolean; // the filing window has closed
}

const pad2 = (n: number) => String(n).padStart(2, '0');
const toISO = (d: Date) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
const fromISO = (iso: string) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  return m ? new Date(+m[1], +m[2] - 1, +m[3]) : null;
};
const addDays = (d: Date, n: number) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);

// nth (1-based) occurrence of a weekday (0=Sun..6=Sat) in a month (0-based).
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

// A fixed-date holiday falling on Saturday is observed the preceding Friday;
// on Sunday, the following Monday (federal observation rules).
function observed(d: Date): Date {
  if (d.getDay() === 6) return addDays(d, -1);
  if (d.getDay() === 0) return addDays(d, 1);
  return d;
}

// Observed federal holidays that fall within calendar year `year`, as ISO
// strings. Includes next year's New Year's Day when its observed date rolls
// back into December of this year (Jan 1 on a Saturday → observed Dec 31).
export function federalHolidays(year: number): Set<string> {
  const out = new Set<string>();
  const fixed = (month: number, day: number) => observed(new Date(year, month, day));
  const days: Date[] = [
    fixed(0, 1), // New Year's Day
    nthWeekday(year, 0, 1, 3), // Martin Luther King Jr. Day — 3rd Mon of Jan
    nthWeekday(year, 1, 1, 3), // Washington's Birthday — 3rd Mon of Feb
    lastWeekday(year, 4, 1), // Memorial Day — last Mon of May
    fixed(5, 19), // Juneteenth
    fixed(6, 4), // Independence Day
    nthWeekday(year, 8, 1, 1), // Labor Day — 1st Mon of Sep
    fixed(10, 11), // Veterans Day
    nthWeekday(year, 10, 4, 4), // Thanksgiving — 4th Thu of Nov
    fixed(11, 25), // Christmas Day
    observed(new Date(year + 1, 0, 1)), // next New Year's, if observed Dec 31
  ];
  for (const d of days) {
    if (d.getFullYear() === year) out.add(toISO(d));
  }
  return out;
}

const holidayCache = new Map<number, Set<string>>();

export function isLegalHoliday(d: Date): boolean {
  const y = d.getFullYear();
  let set = holidayCache.get(y);
  if (!set) {
    set = federalHolidays(y);
    holidayCache.set(y, set);
  }
  return set.has(toISO(d));
}

export function isBusinessDay(d: Date): boolean {
  const dow = d.getDay();
  return dow !== 0 && dow !== 6 && !isLegalHoliday(d);
}

// Which rule applies for a state code. Unknown/absent states default to the
// AR rule (most of the book is Arkansas) — the returned `rule` marks which
// one was actually used.
export function ruleForState(state?: string | null): MotionsRule {
  return String(state ?? '').trim().toUpperCase() === 'MO' ? 'MO-5biz' : 'AR-20cal';
}

// The motions-filing deadline for a court date under a rule. Pure date math —
// no "today" involved.
export function motionsDeadlineDate(courtDateISO: string, rule: MotionsRule): string | null {
  const court = fromISO(courtDateISO);
  if (!court) return null;
  if (rule === 'MO-5biz') {
    // Count back 5 business days from the hearing (the hearing day itself is
    // not counted): Friday hearing → Thu(1) Wed(2) Tue(3) Mon(4) Fri(5).
    let d = court;
    let counted = 0;
    while (counted < 5) {
      d = addDays(d, -1);
      if (isBusinessDay(d)) counted++;
    }
    return toISO(d);
  }
  // AR: 20 calendar days before, rolled BACKWARD off weekends/holidays.
  let d = addDays(court, -20);
  while (!isBusinessDay(d)) d = addDays(d, -1);
  return toISO(d);
}

// The lead's motions deadline, or null when there's no upcoming court date
// (missing/invalid date, or the court date itself has already passed).
// `today` is injectable for tests.
export function motionsDeadlineFor(
  lead: Pick<Lead, 'nextCourtDate' | 'state'>,
  today: Date = new Date(),
): MotionsDeadline | null {
  if (!lead.nextCourtDate) return null;
  const court = parseISO(lead.nextCourtDate);
  if (!isValid(court)) return null;
  if (differenceInCalendarDays(court, today) < 0) return null; // court already passed

  const rule = ruleForState(lead.state);
  const date = motionsDeadlineDate(lead.nextCourtDate, rule);
  if (!date) return null;
  const daysLeft = differenceInCalendarDays(parseISO(date), today);
  return { date, daysLeft, rule, passed: daysLeft < 0 };
}
