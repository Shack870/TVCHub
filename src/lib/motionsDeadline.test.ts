import { describe, expect, it } from 'vitest';
import {
  federalHolidays,
  isBusinessDay,
  motionsDeadlineDate,
  motionsDeadlineFor,
  ruleForState,
} from './motionsDeadline';
import { makeLead } from './testUtils';

describe('federalHolidays', () => {
  it('computes the 2026 observed calendar', () => {
    const h = federalHolidays(2026);
    expect(h.has('2026-01-01')).toBe(true); // New Year's (Thu)
    expect(h.has('2026-01-19')).toBe(true); // MLK — 3rd Mon Jan
    expect(h.has('2026-02-16')).toBe(true); // Washington's Birthday — 3rd Mon Feb
    expect(h.has('2026-05-25')).toBe(true); // Memorial — last Mon May
    expect(h.has('2026-06-19')).toBe(true); // Juneteenth (Fri)
    expect(h.has('2026-07-03')).toBe(true); // Independence Day — Jul 4 is a Sat, observed Fri
    expect(h.has('2026-07-04')).toBe(false);
    expect(h.has('2026-09-07')).toBe(true); // Labor — 1st Mon Sep
    expect(h.has('2026-11-11')).toBe(true); // Veterans (Wed)
    expect(h.has('2026-11-26')).toBe(true); // Thanksgiving — 4th Thu Nov
    expect(h.has('2026-12-25')).toBe(true); // Christmas (Fri)
  });

  it('pulls a Saturday New Year back into December of the prior year', () => {
    // Jan 1, 2022 was a Saturday → observed Friday Dec 31, 2021.
    expect(federalHolidays(2021).has('2021-12-31')).toBe(true);
    expect(federalHolidays(2022).has('2022-01-01')).toBe(false);
  });

  it('moves a Sunday holiday to the following Monday', () => {
    // Jul 4, 2027 is a Sunday → observed Monday Jul 5.
    const h = federalHolidays(2027);
    expect(h.has('2027-07-05')).toBe(true);
    expect(h.has('2027-07-04')).toBe(false);
  });
});

describe('isBusinessDay', () => {
  it('rejects weekends and observed holidays', () => {
    expect(isBusinessDay(new Date(2026, 7, 8))).toBe(false); // Saturday
    expect(isBusinessDay(new Date(2026, 7, 9))).toBe(false); // Sunday
    expect(isBusinessDay(new Date(2026, 6, 3))).toBe(false); // observed July 4th
    expect(isBusinessDay(new Date(2026, 7, 10))).toBe(true); // ordinary Monday
  });
});

describe('ruleForState', () => {
  it('maps MO to the business-day rule and everything else (incl. unknown) to AR', () => {
    expect(ruleForState('MO')).toBe('MO-5biz');
    expect(ruleForState(' mo ')).toBe('MO-5biz');
    expect(ruleForState('AR')).toBe('AR-20cal');
    expect(ruleForState('TX')).toBe('AR-20cal');
    expect(ruleForState(undefined)).toBe('AR-20cal');
    expect(ruleForState('')).toBe('AR-20cal');
  });
});

describe('the Missouri 5-business-day rule (Mo. Sup. Ct. Rule 44.01)', () => {
  it("the user's worked example: a Friday hearing → the preceding Friday", () => {
    // Hearing Fri Aug 14, 2026. Counting back business days:
    // Thu 13 (1), Wed 12 (2), Tue 11 (3), Mon 10 (4), Fri 7 (5).
    expect(motionsDeadlineDate('2026-08-14', 'MO-5biz')).toBe('2026-08-07');
  });

  it('skips legal holidays in the count', () => {
    // Hearing Fri Sep 11, 2026 — Labor Day (Mon Sep 7) is excluded:
    // Thu 10 (1), Wed 9 (2), Tue 8 (3), [Mon 7 holiday, weekend], Fri 4 (4), Thu 3 (5).
    expect(motionsDeadlineDate('2026-09-11', 'MO-5biz')).toBe('2026-09-03');
  });

  it('a Monday hearing reaches back across the weekend to the prior Monday', () => {
    // Hearing Mon Aug 17, 2026: Fri 14 (1), Thu 13 (2), Wed 12 (3), Tue 11 (4), Mon 10 (5).
    expect(motionsDeadlineDate('2026-08-17', 'MO-5biz')).toBe('2026-08-10');
  });
});

describe('the Arkansas 20-calendar-day rule', () => {
  it('lands 20 days out on a business day unchanged', () => {
    // Court Thu Aug 27, 2026 → Fri Aug 7 (a plain business day).
    expect(motionsDeadlineDate('2026-08-27', 'AR-20cal')).toBe('2026-08-07');
  });

  it('rolls a weekend landing BACKWARD to the preceding Friday', () => {
    // Court Fri Aug 28, 2026 → 20 days = Sat Aug 8 → back to Fri Aug 7.
    expect(motionsDeadlineDate('2026-08-28', 'AR-20cal')).toBe('2026-08-07');
    // Court Sat Aug 29 → Sun Aug 9 → back to Fri Aug 7.
    expect(motionsDeadlineDate('2026-08-29', 'AR-20cal')).toBe('2026-08-07');
  });

  it('rolls through a holiday that follows the weekend', () => {
    // Court Fri Jul 24, 2026 → 20 days = Sat Jul 4 → Fri Jul 3 is the observed
    // Independence Day → keeps rolling back to Thu Jul 2.
    expect(motionsDeadlineDate('2026-07-24', 'AR-20cal')).toBe('2026-07-02');
  });
});

describe('motionsDeadlineFor', () => {
  const today = new Date(2026, 6, 23); // Thu Jul 23, 2026

  it('returns null with no (or an invalid) court date', () => {
    expect(motionsDeadlineFor(makeLead({ nextCourtDate: null }), today)).toBeNull();
    expect(motionsDeadlineFor(makeLead({ nextCourtDate: 'garbage' }), today)).toBeNull();
  });

  it('returns null once the court date itself has passed', () => {
    expect(
      motionsDeadlineFor(makeLead({ nextCourtDate: '2026-07-20', state: 'AR' }), today),
    ).toBeNull();
  });

  it('computes daysLeft and the rule used for an AR lead', () => {
    const d = motionsDeadlineFor(
      makeLead({ nextCourtDate: '2026-08-27', state: 'AR' }),
      today,
    );
    expect(d).toEqual({ date: '2026-08-07', daysLeft: 15, rule: 'AR-20cal', passed: false });
  });

  it('marks a closed window as passed (court upcoming, deadline behind us)', () => {
    // Court Mon Aug 3 → AR deadline Jul 14 (Tue), 9 days behind Jul 23.
    const d = motionsDeadlineFor(
      makeLead({ nextCourtDate: '2026-08-03', state: 'AR' }),
      today,
    );
    expect(d?.date).toBe('2026-07-14');
    expect(d?.daysLeft).toBe(-9);
    expect(d?.passed).toBe(true);
  });

  it('uses the MO rule for Missouri leads and defaults unknown states to AR', () => {
    const mo = motionsDeadlineFor(
      makeLead({ nextCourtDate: '2026-08-14', state: 'MO' }),
      today,
    );
    expect(mo).toEqual({ date: '2026-08-07', daysLeft: 15, rule: 'MO-5biz', passed: false });

    const unknown = motionsDeadlineFor(makeLead({ nextCourtDate: '2026-08-14' }), today);
    expect(unknown?.rule).toBe('AR-20cal');
    expect(unknown?.date).toBe('2026-07-24'); // 20 cal days = Sat Jul 25 → rolls to Fri
  });

  it('deadline day itself is daysLeft 0 and NOT passed', () => {
    const d = motionsDeadlineFor(
      makeLead({ nextCourtDate: '2026-08-12', state: 'AR' }),
      today,
    );
    expect(d?.date).toBe('2026-07-23');
    expect(d?.daysLeft).toBe(0);
    expect(d?.passed).toBe(false);
  });
});
