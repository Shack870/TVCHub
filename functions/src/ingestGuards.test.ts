import { describe, expect, it } from 'vitest';
import { phoneLast10, staleReferralReason } from './ingestGuards.js';

const TODAY = '2026-07-24';

describe('staleReferralReason', () => {
  it('flags a court date already in the past', () => {
    const reason = staleReferralReason({ nextCourtDate: '2026-07-06', todayISO: TODAY });
    expect(reason).toMatch(/court date \(2026-07-06\) is already in the past/);
  });

  it('accepts today and future court dates', () => {
    expect(staleReferralReason({ nextCourtDate: TODAY, todayISO: TODAY })).toBeNull();
    expect(staleReferralReason({ nextCourtDate: '2026-08-10', todayISO: TODAY })).toBeNull();
  });

  it('ignores malformed court dates', () => {
    expect(staleReferralReason({ nextCourtDate: '07/06/2026', todayISO: TODAY })).toBeNull();
    expect(staleReferralReason({ nextCourtDate: null, todayISO: TODAY })).toBeNull();
  });

  it('flags a case number >20,000 below the newest lead', () => {
    const reason = staleReferralReason({
      caseNumber: '1521022',
      newestCaseNumber: '1563109',
      todayISO: TODAY,
    });
    expect(reason).toMatch(/42087 below the newest referral/);
  });

  it('accepts a case number within the 20,000 window', () => {
    expect(
      staleReferralReason({ caseNumber: '1550000', newestCaseNumber: '1563109', todayISO: TODAY }),
    ).toBeNull();
    // Exactly at the gap is NOT stale (strictly greater-than).
    expect(
      staleReferralReason({ caseNumber: '1543109', newestCaseNumber: '1563109', todayISO: TODAY }),
    ).toBeNull();
  });

  it('ignores non-numeric or out-of-shape case numbers', () => {
    expect(
      staleReferralReason({ caseNumber: '50843389123', newestCaseNumber: '1563109', todayISO: TODAY }),
    ).toBeNull();
    expect(
      staleReferralReason({ caseNumber: 'ABC123', newestCaseNumber: '1563109', todayISO: TODAY }),
    ).toBeNull();
    expect(staleReferralReason({ caseNumber: '1500000', todayISO: TODAY })).toBeNull();
  });

  it('prefers the court-date reason when both apply', () => {
    const reason = staleReferralReason({
      nextCourtDate: '2026-01-05',
      caseNumber: '1500000',
      newestCaseNumber: '1563109',
      todayISO: TODAY,
    });
    expect(reason).toMatch(/court date/);
  });
});

describe('phoneLast10', () => {
  it('normalizes formatted numbers to their last 10 digits', () => {
    expect(phoneLast10('+1 (773) 595-8455')).toBe('7735958455');
    expect(phoneLast10('773-595-8455')).toBe('7735958455');
    expect(phoneLast10(null)).toBe('');
  });
});
