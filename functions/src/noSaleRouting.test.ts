import { describe, expect, it } from 'vitest';
import { hardDeclineMove } from './noSaleRouting.js';

const CALL_TS = new Date('2026-07-22T16:45:00Z').getTime();

const hard = (over: Record<string, unknown> = {}) => ({
  declineType: 'hard' as const,
  declineReason: 'already paid the citation himself',
  summary: 'The caller confirmed he already paid the citation.',
  existingClientInquiry: false,
  ...over,
});

const lead = (over: Record<string, unknown> = {}) => ({
  stage: 'callback',
  saleStatus: null,
  followUps: [
    { id: 'a', type: 'chase', dueAt: CALL_TS + 86400_000, done: false },
    { id: 'b', type: 'week_before', dueAt: CALL_TS + 5 * 86400_000, done: true, doneAt: 1 },
    { id: 'c', type: 'week_before', dueAt: CALL_TS + 20 * 86400_000, done: false },
    { id: 'd', type: 'day_before', dueAt: CALL_TS + 26 * 86400_000, done: false },
    { id: 'e', type: 'motions', dueAt: CALL_TS + 10 * 86400_000, done: false },
  ],
  ...over,
});

describe('hardDeclineMove', () => {
  it('routes a hard decline on an unsold board lead to lost', () => {
    const move = hardDeclineMove(lead(), hard(), CALL_TS);
    expect(move).not.toBeNull();
    expect(move!.patch.stage).toBe('lost');
    expect(move!.patch.lostAt).toBe(CALL_TS); // business date = the call
    expect(move!.patch.lostReason).toBe('already paid the citation himself');
    expect(move!.note).toMatch(/hard decline/);
    // Pending SALES follow-ups are closed; already-done ones untouched.
    const fus = move!.patch.followUps as { id: string; done: boolean; doneAt?: number }[];
    expect(fus.find((f) => f.id === 'a')!.done).toBe(true);
    expect(fus.find((f) => f.id === 'b')!.doneAt).toBe(1);
    // Court reminders SURVIVE the move — they're the resurrection path, and
    // closing them would arm the cadence's proximity dedupe against re-adds.
    expect(fus.find((f) => f.id === 'c')!.done).toBe(false);
    expect(fus.find((f) => f.id === 'd')!.done).toBe(false);
    // The motions heads-up is a sales touch — it closes.
    expect(fus.find((f) => f.id === 'e')!.done).toBe(true);
  });

  it('falls back to the summary when no declineReason came through', () => {
    const move = hardDeclineMove(lead(), hard({ declineReason: null }), CALL_TS);
    expect(move!.patch.lostReason).toBe('The caller confirmed he already paid the citation.');
  });

  it('never moves soft declines or non-declines', () => {
    expect(hardDeclineMove(lead(), hard({ declineType: 'soft' }), CALL_TS)).toBeNull();
    expect(hardDeclineMove(lead(), hard({ declineType: 'none' }), CALL_TS)).toBeNull();
    expect(hardDeclineMove(lead(), { summary: 'x' }, CALL_TS)).toBeNull();
  });

  it('never touches leads off the working board', () => {
    for (const stage of ['lost', 'financed', 'intake_complete']) {
      expect(hardDeclineMove(lead({ stage }), hard(), CALL_TS)).toBeNull();
    }
  });

  it('never auto-loses a paying client', () => {
    expect(hardDeclineMove(lead({ saleStatus: 'paid_full' }), hard(), CALL_TS)).toBeNull();
    expect(hardDeclineMove(lead({ saleStatus: 'paid_partial' }), hard(), CALL_TS)).toBeNull();
    // promised_unpaid is still unsold — a hard decline DOES kill the promise.
    expect(hardDeclineMove(lead({ saleStatus: 'promised_unpaid' }), hard(), CALL_TS)).not.toBeNull();
  });

  it('safety valve: a lead a human revived out of lost is never re-lost', () => {
    expect(hardDeclineMove(lead({ lostRevivedAt: CALL_TS - 1 }), hard(), CALL_TS)).toBeNull();
    // Even by a call NEWER than the revive — the human decision is final.
    expect(hardDeclineMove(lead({ lostRevivedAt: CALL_TS - 86400_000 }), hard(), CALL_TS)).toBeNull();
  });

  it('safety valve: calls older than the lost stamp cannot act', () => {
    expect(hardDeclineMove(lead({ lostAt: CALL_TS + 1 }), hard(), CALL_TS)).toBeNull();
  });

  it('blocks when the caller reads as an already-hired client', () => {
    expect(hardDeclineMove(lead(), hard({ existingClientInquiry: true }), CALL_TS)).toBeNull();
  });

  it('blocks leads under the possible-existing-client flag', () => {
    // "We don't want to continue with your firm" from someone the firm may
    // have already retained is a service problem, not a sales decline.
    expect(
      hardDeclineMove(lead({ possibleExistingClientAt: CALL_TS - 1 }), hard(), CALL_TS),
    ).toBeNull();
  });
});
