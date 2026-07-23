import { describe, expect, it } from 'vitest';
import {
  collectedInRange,
  collectedOf,
  isPaidInFull,
  lastPaymentTs,
  ledgerEntries,
  manualEntries,
  outstandingOf,
  squareEntries,
  totalFeeOf,
} from './paymentLedger';
import { makeLead } from './testUtils';

const DAY = 86400_000;

// A via-'square' attempt the way syncSquare writes it.
const squareAttempt = (ts: number, dollars: number, id = 'pmt') => ({
  ts,
  outcome: 'retained' as const,
  via: 'square' as const,
  notes: `Square payment received — $${dollars.toFixed(2)} (payment ${id})`,
  paymentId: id,
});

describe('squareEntries', () => {
  it('parses amounts out of the sync attempt notes and skips non-square attempts', () => {
    const lead = makeLead({
      contactAttempts: [
        squareAttempt(1000, 562.5),
        { ts: 2000, outcome: 'spoke' },
        { ts: 3000, outcome: 'retained', via: 'callrail' },
      ],
    });
    expect(squareEntries(lead)).toEqual([
      { ts: 1000, amount: 562.5, source: 'square', counted: true },
    ]);
  });
});

describe('the double-count guard', () => {
  it('drops a manual entry matching a Square charge (same amount within 5 days)', () => {
    const t = Date.now();
    const lead = makeLead({
      squarePaidTotal: 500,
      contactAttempts: [squareAttempt(t, 500)],
      financing: {
        totalFee: 1000,
        payments: [{ id: 'a', amount: 500, date: t - 2 * DAY, method: 'card' }],
      },
    });
    expect(manualEntries(lead)[0].counted).toBe(false);
    expect(collectedOf(lead)).toBe(500); // counted once — the Square copy wins
  });

  it('keeps a manual entry when the amount differs (real money outside Square)', () => {
    // The Bobby Giger shape: manual $625, Square $562+$563 — three payments.
    const t = Date.now();
    const lead = makeLead({
      squarePaidTotal: 1125,
      contactAttempts: [squareAttempt(t, 562, 'p1'), squareAttempt(t + 11 * DAY, 563, 'p2')],
      financing: {
        totalFee: 1125,
        payments: [{ id: 'a', amount: 625, date: t - 6 * DAY, method: 'card' }],
      },
    });
    expect(manualEntries(lead)[0].counted).toBe(true);
    expect(collectedOf(lead)).toBe(1750);
    expect(outstandingOf(lead)).toBe(0);
    expect(isPaidInFull(lead)).toBe(true);
  });

  it('keeps a manual entry when the matching amount is too far away in time', () => {
    const t = Date.now();
    const lead = makeLead({
      squarePaidTotal: 500,
      contactAttempts: [squareAttempt(t, 500)],
      financing: {
        totalFee: 1500,
        payments: [{ id: 'a', amount: 500, date: t - 30 * DAY, method: 'cash' }],
      },
    });
    expect(collectedOf(lead)).toBe(1000);
  });
});

describe('totalFeeOf', () => {
  it('prefers the manual fee (incl. warrant fee), falls back to saleAmount, else null', () => {
    expect(
      totalFeeOf(
        makeLead({ financing: { totalFee: 1000, warrantFee: 500, payments: [] }, saleAmount: 99 }),
      ),
    ).toBe(1500);
    expect(totalFeeOf(makeLead({ saleAmount: 1125 }))).toBe(1125);
    expect(totalFeeOf(makeLead())).toBeNull();
    expect(totalFeeOf(makeLead({ financing: { totalFee: 0, payments: [] } }))).toBeNull();
  });
});

describe('outstanding / paid in full', () => {
  it('outstanding = fee - collected, floored at zero, zero when fee unknown', () => {
    const lead = makeLead({ saleAmount: 1000, squarePaidTotal: 400 });
    expect(outstandingOf(lead)).toBe(600);
    expect(outstandingOf(makeLead({ squarePaidTotal: 400 }))).toBe(0); // no fee on file
  });

  it('saleStatus paid_full settles the account even when no charge matched', () => {
    // The ambiguous-payment case: the money arrived but couldn't be credited.
    const lead = makeLead({ saleAmount: 1125, saleStatus: 'paid_full', squarePaidTotal: 0 });
    expect(isPaidInFull(lead)).toBe(true);
    expect(outstandingOf(lead)).toBe(0);
  });
});

describe('time-window math', () => {
  it('collectedInRange counts Square by payment ts and manual by date, skipping duplicates', () => {
    const t0 = 100 * DAY;
    const lead = makeLead({
      squarePaidTotal: 800,
      contactAttempts: [squareAttempt(t0, 500, 'p1'), squareAttempt(t0 + 20 * DAY, 300, 'p2')],
      financing: {
        totalFee: 2000,
        payments: [
          { id: 'dup', amount: 500, date: t0 + DAY, method: 'card' }, // dup of p1
          { id: 'real', amount: 200, date: t0 + 2 * DAY, method: 'check' },
        ],
      },
    });
    expect(collectedInRange(lead, t0, t0 + 7 * DAY)).toBe(700); // 500 square + 200 manual
    expect(collectedInRange(lead, t0 + 7 * DAY, t0 + 30 * DAY)).toBe(300);
    expect(collectedOf(lead)).toBe(1000);
    expect(ledgerEntries(lead)).toHaveLength(4);
    expect(lastPaymentTs(lead)).toBe(t0 + 20 * DAY);
  });
});
