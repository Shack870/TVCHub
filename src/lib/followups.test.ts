import { describe, expect, it } from 'vitest';
import { computeFollow, DAY, nextTouch } from './followups';
import { makeLead } from './testUtils';

describe('computeFollow', () => {
  it('honors a manually chosen date above all else', () => {
    const f = computeFollow('spoke', undefined, '2999-01-01', 'callback');
    expect(f).not.toBeNull();
    expect(f!.type).toBe('callback');
    expect(f!.at).toBe(new Date('2999-01-01T09:00:00').getTime());
  });

  it('schedules a next-day callback for no-answer / voicemail', () => {
    const before = Date.now();
    const f = computeFollow('no_answer', undefined);
    expect(f!.type).toBe('callback');
    expect(f!.at).toBeGreaterThanOrEqual(before + DAY - 1000);
  });

  it('returns null when there is nothing to schedule', () => {
    expect(computeFollow('wants_attorney', undefined)).toBeNull();
    expect(computeFollow('retained', undefined)).toBeNull();
  });

  it('drives a declined lead toward a pre-court check-in when a court date exists', () => {
    const courtIso = new Date(Date.now() + 30 * DAY).toISOString().slice(0, 10);
    const f = computeFollow('declined', courtIso);
    expect(f!.type).toBe('week_before');
  });
});

describe('nextTouch', () => {
  it('walks the escalating cadence by prior-touch count', () => {
    const lead = makeLead();
    const now = Date.now();
    const t0 = nextTouch(lead, 0)!;
    const t1 = nextTouch(lead, 1)!;
    expect(t0.type).toBe('nurture');
    // 1 day vs 2 days out
    expect(Math.round((t0.at - now) / DAY)).toBe(1);
    expect(Math.round((t1.at - now) / DAY)).toBe(2);
  });

  it('returns null once the cadence is exhausted', () => {
    expect(nextTouch(makeLead(), 99)).toBeNull();
  });

  it('prioritizes the pre-court call when court is near', () => {
    const courtIso = new Date(Date.now() + 5 * DAY).toISOString().slice(0, 10);
    const lead = makeLead({ nextCourtDate: courtIso });
    const t = nextTouch(lead, 0)!;
    expect(t.type).toBe('day_before');
  });
});
