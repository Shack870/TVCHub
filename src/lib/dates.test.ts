import { describe, expect, it } from 'vitest';
import {
  courtDatePassed,
  daysUntilCourt,
  fmtMoney,
  paymentPastDue,
} from './dates';
import { DAY } from './followups';
import { makeLead } from './testUtils';

const iso = (ms: number) => new Date(ms).toISOString().slice(0, 10);

describe('daysUntilCourt', () => {
  it('returns null without a court date', () => {
    expect(daysUntilCourt(makeLead())).toBeNull();
  });

  it('is negative once the court date has passed', () => {
    const lead = makeLead({ nextCourtDate: iso(Date.now() - 3 * DAY) });
    expect(daysUntilCourt(lead)!).toBeLessThan(0);
    expect(courtDatePassed(lead)).toBe(true);
  });

  it('is positive for a future date', () => {
    const lead = makeLead({ nextCourtDate: iso(Date.now() + 10 * DAY) });
    expect(daysUntilCourt(lead)!).toBeGreaterThan(0);
    expect(courtDatePassed(lead)).toBe(false);
  });
});

describe('paymentPastDue', () => {
  it('is false without a due date', () => {
    expect(paymentPastDue(makeLead())).toBe(false);
  });

  it('is true when the next payment due date is in the past', () => {
    // 3 days back so the assertion can't straddle a local/UTC day boundary.
    const lead = makeLead({
      financing: { totalFee: 100, payments: [], nextPaymentDue: iso(Date.now() - 3 * DAY) },
    });
    expect(paymentPastDue(lead)).toBe(true);
  });
});

describe('fmtMoney', () => {
  it('formats whole-dollar USD', () => {
    expect(fmtMoney(1500)).toBe('$1,500');
    expect(fmtMoney(0)).toBe('$0');
    expect(fmtMoney(undefined)).toBe('$0');
  });
});
