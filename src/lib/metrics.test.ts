import { describe, expect, it } from 'vitest';
import { buildReport, weekRangeFor } from './metrics';
import { DAY } from './followups';
import { makeLead } from './testUtils';

describe('weekRangeFor', () => {
  it('produces a Monday-start, exclusive-Monday-end range', () => {
    const r = weekRangeFor(new Date('2026-06-17T12:00:00')); // a Wednesday
    expect(new Date(r.start).getDay()).toBe(1); // Monday
    expect(r.end - r.start).toBe(7 * DAY);
  });
});

describe('buildReport', () => {
  const ref = new Date('2026-06-17T12:00:00');
  const thisWeek = weekRangeFor(ref).start + DAY; // sometime inside the week

  it('counts the live pipeline and close rate', () => {
    const leads = [
      makeLead({ id: '1', stage: 'new', receivedAt: thisWeek, createdAt: thisWeek }),
      makeLead({
        id: '2',
        stage: 'retained',
        receivedAt: thisWeek,
        createdAt: thisWeek,
        retainedAt: thisWeek,
        contactAttempts: [{ ts: thisWeek, outcome: 'retained' }],
        financing: { totalFee: 1000, payments: [{ id: 'p', amount: 1000, date: thisWeek, method: 'card' }] },
      }),
      makeLead({ id: '3', stage: 'lost', lostAt: thisWeek }),
    ];
    const r = buildReport(leads, ref);
    expect(r.totalLeads).toBe(3);
    expect(r.clients).toBe(1);
    expect(r.lost).toBe(1);
    expect(r.closeRate).toBe(Math.round((1 / 3) * 100));
    expect(r.retainedThisWeek).toBe(1);
    expect(r.lostThisWeek).toBe(1);
    expect(r.revenueCollected).toBe(1000);
    expect(r.collectedAllTime).toBe(1000);
  });

  it('handles an empty book without dividing by zero', () => {
    const r = buildReport([], ref);
    expect(r.totalLeads).toBe(0);
    expect(r.closeRate).toBe(0);
    expect(r.financeRate).toBe(0);
    expect(r.outstanding).toBe(0);
  });
});
