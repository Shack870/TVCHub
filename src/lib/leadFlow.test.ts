import { describe, expect, it } from 'vitest';
import {
  chaseAngleForTouch,
  chicagoDayStart,
  isActiveLead,
  isClient,
  isContactOverdue,
  isFinancingClient,
  isOnBoard,
  isPastFinanced,
  isPlanStalled,
  isRipe,
  isTerminal,
  makeEmptyLead,
  nextPendingFollowUp,
  showsMotionsDeadline,
  stageForOutcome,
} from './leadFlow';
import { isPaidInFull } from './paymentLedger';
import { makeLead } from './testUtils';

describe('stageForOutcome', () => {
  it('maps outcomes to the right stage', () => {
    expect(stageForOutcome('no_answer')).toBe('callback');
    expect(stageForOutcome('voicemail')).toBe('callback');
    expect(stageForOutcome('spoke')).toBe('pitched');
    expect(stageForOutcome('thinking')).toBe('pitched');
    expect(stageForOutcome('wants_attorney')).toBe('attorney_call');
    expect(stageForOutcome('declined')).toBe('nurture');
    expect(stageForOutcome('retained')).toBe('intake_complete');
    expect(stageForOutcome('lost')).toBe('lost');
  });
});

describe('stage predicates', () => {
  it('isOnBoard covers active intake stages only', () => {
    expect(isOnBoard(makeLead({ stage: 'new' }))).toBe(true);
    expect(isOnBoard(makeLead({ stage: 'pitched' }))).toBe(true);
    expect(isOnBoard(makeLead({ stage: 'nurture' }))).toBe(true);
    expect(isOnBoard(makeLead({ stage: 'financed' }))).toBe(false);
  });

  it('isActiveLead excludes terminal stages', () => {
    expect(isActiveLead(makeLead({ stage: 'nurture' }))).toBe(true);
    expect(isActiveLead(makeLead({ stage: 'financed' }))).toBe(false);
    expect(isActiveLead(makeLead({ stage: 'intake_complete' }))).toBe(false);
    expect(isActiveLead(makeLead({ stage: 'lost' }))).toBe(false);
  });

  it('isTerminal is the inverse set', () => {
    expect(isTerminal(makeLead({ stage: 'financed' }))).toBe(true);
    expect(isTerminal(makeLead({ stage: 'new' }))).toBe(false);
  });

  it('isClient is financed or handed off', () => {
    expect(isClient(makeLead({ stage: 'financed' }))).toBe(true);
    expect(isClient(makeLead({ stage: 'intake_complete' }))).toBe(true);
    expect(isClient(makeLead({ stage: 'lost' }))).toBe(false);
  });
});

describe('showsMotionsDeadline (deadline surfaces are a sales tool)', () => {
  it('shows for active unsold leads, incl. promised_unpaid', () => {
    expect(showsMotionsDeadline(makeLead({ stage: 'pitched' }))).toBe(true);
    expect(showsMotionsDeadline(makeLead({ stage: 'nurture', saleStatus: 'none' }))).toBe(true);
    // A verbal yes with no money collected hasn't completed — still a sale in flight.
    expect(
      showsMotionsDeadline(makeLead({ stage: 'pitched', saleStatus: 'promised_unpaid' })),
    ).toBe(true);
  });

  it('hides for retained, paid, lost, or archived leads', () => {
    expect(showsMotionsDeadline(makeLead({ stage: 'intake_complete' }))).toBe(false);
    expect(showsMotionsDeadline(makeLead({ stage: 'financed' }))).toBe(false);
    expect(showsMotionsDeadline(makeLead({ stage: 'lost' }))).toBe(false);
    expect(showsMotionsDeadline(makeLead({ stage: 'pitched', saleStatus: 'paid_full' }))).toBe(
      false,
    );
    expect(
      showsMotionsDeadline(makeLead({ stage: 'pitched', saleStatus: 'paid_partial' })),
    ).toBe(false);
    expect(showsMotionsDeadline(makeLead({ stage: 'pitched', deletedAt: Date.now() }))).toBe(
      false,
    );
  });
});

describe('financing board membership (unified ledger)', () => {
  const lead = makeLead({
    stage: 'financed',
    financing: {
      totalFee: 1000,
      warrantFee: 500,
      payments: [
        { id: 'a', amount: 600, date: 0, method: 'card' },
        { id: 'b', amount: 400, date: 0, method: 'cash' },
      ],
    },
  });

  it('isPaidInFull via manual payments covering the fee', () => {
    const paid = makeLead({
      stage: 'intake_complete',
      financing: {
        totalFee: 500,
        payments: [{ id: 'a', amount: 500, date: 0, method: 'card' }],
      },
    });
    expect(isPaidInFull(paid)).toBe(true);
    expect(isFinancingClient(paid)).toBe(false); // paid off => drops out
    expect(isPastFinanced(paid)).toBe(true); // manual plan, settled
  });

  it('isFinancingClient when a client still owes', () => {
    expect(isFinancingClient(lead)).toBe(true);
    expect(isPastFinanced(lead)).toBe(false);
  });

  it('isFinancingClient for a non-client with a warrant fee owed', () => {
    const warrant = makeLead({
      stage: 'nurture',
      hasWarrant: true,
      financing: { totalFee: 0, warrantFee: 500, payments: [] },
    });
    expect(isFinancingClient(warrant)).toBe(true);
  });

  it('a financed-stage lead whose fee Square covered leaves the active board for Past Financed', () => {
    const squarePaid = makeLead({
      stage: 'financed',
      saleAmount: 700,
      squarePaidTotal: 700,
      saleStatus: 'paid_partial',
      isFinanced: true,
    });
    expect(isPaidInFull(squarePaid)).toBe(true);
    expect(isFinancingClient(squarePaid)).toBe(false); // never on the active board
    expect(isPastFinanced(squarePaid)).toBe(true);
    expect(isPlanStalled(squarePaid)).toBe(false); // settled plans can't stall
  });

  it('a paid-on-the-spot client was never financed and skips Past Financed', () => {
    const cashClient = makeLead({
      stage: 'intake_complete',
      saleAmount: 1125,
      squarePaidTotal: 1125,
      saleStatus: 'paid_full',
    });
    expect(isPaidInFull(cashClient)).toBe(true);
    expect(isPastFinanced(cashClient)).toBe(false);
    expect(isFinancingClient(cashClient)).toBe(false);
  });
});

describe('isRipe (the chase queue)', () => {
  const DAY = 86400_000;
  const iso = (daysOut: number) =>
    new Date(Date.now() + daysOut * DAY).toISOString().slice(0, 10);
  // The James-Thomas shape: one voicemail, silence, court far out.
  const ripeLead = (over: Partial<ReturnType<typeof makeLead>> = {}) =>
    makeLead({
      stage: 'callback',
      contactAttempts: [{ ts: Date.now() - 21 * DAY, outcome: 'voicemail' }],
      nextCourtDate: iso(45),
      ...over,
    });

  it('flags a voicemailed lead with a far-future court date', () => {
    expect(isRipe(ripeLead())).toBe(true);
  });

  it('a voicemail or no-answer is not a conversation, but spoke/thinking are', () => {
    expect(
      isRipe(
        ripeLead({
          contactAttempts: [
            { ts: Date.now() - 30 * DAY, outcome: 'voicemail' },
            { ts: Date.now() - 21 * DAY, outcome: 'no_answer' },
          ],
        }),
      ),
    ).toBe(true);
    expect(
      isRipe(ripeLead({ contactAttempts: [{ ts: Date.now(), outcome: 'spoke' }] })),
    ).toBe(false);
    expect(
      isRipe(ripeLead({ contactAttempts: [{ ts: Date.now(), outcome: 'thinking' }] })),
    ).toBe(false);
    expect(isRipe(ripeLead({ lastConnectedAt: Date.now() }))).toBe(false);
  });

  it('not ripe when uncontacted, exhausted, or court is inside the final week', () => {
    expect(isRipe(ripeLead({ contactAttempts: [] }))).toBe(false);
    expect(isRipe(ripeLead({ cadenceExhaustedAt: Date.now() }))).toBe(false);
    // Inside the motions window is still ripe (the deadline tags escalate it);
    // only the last pre-court week belongs to the week/day-before reminders.
    expect(isRipe(ripeLead({ nextCourtDate: iso(14) }))).toBe(true);
    expect(isRipe(ripeLead({ nextCourtDate: iso(5) }))).toBe(false); // reminders own it
    expect(isRipe(ripeLead({ nextCourtDate: null }))).toBe(false);
    expect(
      isRipe(
        ripeLead({
          contactAttempts: Array.from({ length: 8 }, (_, i) => ({
            ts: Date.now() - i * DAY,
            outcome: 'voicemail' as const,
          })),
        }),
      ),
    ).toBe(false);
  });

  it('not ripe once money is promised or paid (billing owns those)', () => {
    expect(isRipe(ripeLead({ saleStatus: 'promised_unpaid' }))).toBe(false);
    expect(isRipe(ripeLead({ saleStatus: 'paid_full' }))).toBe(false);
    expect(isRipe(ripeLead({ saleStatus: 'none' }))).toBe(true);
  });

  it('escalates the script angle by touch number', () => {
    expect(chaseAngleForTouch(2)).toMatch(/CDL/);
    expect(chaseAngleForTouch(3)).toMatch(/price/);
    expect(chaseAngleForTouch(4)).toMatch(/entry of appearance/);
    expect(chaseAngleForTouch(7)).toMatch(/entry of appearance/);
  });
});

describe('chicagoDayStart (the desk day boundary)', () => {
  const chicago = (ts: number) =>
    new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/Chicago',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).format(new Date(ts));

  it('returns midnight in Chicago for the day containing now', () => {
    // Summer (CDT, UTC-5) and winter (CST, UTC-6) instants.
    for (const iso of ['2026-07-23T20:15:00Z', '2026-01-15T03:15:00Z']) {
      const now = new Date(iso).getTime();
      const start = chicagoDayStart(now);
      const day = chicago(now).slice(0, 10);
      expect(chicago(start)).toBe(`${day}, 00:00`);
      expect(start).toBeLessThanOrEqual(now);
      expect(now - start).toBeLessThan(86400_000 + 3600_000);
    }
  });

  it('late-evening UTC still belongs to the same Chicago day', () => {
    // 2026-07-24T03:00Z is 10pm Jul 23 in Chicago — the desk day is Jul 23.
    const now = new Date('2026-07-24T03:00:00Z').getTime();
    expect(chicago(chicagoDayStart(now))).toBe('2026-07-23, 00:00');
  });
});

describe('nextPendingFollowUp', () => {
  const fu = (id: string, dueAt: number, done = false) => ({
    id,
    type: 'callback' as const,
    dueAt,
    done,
  });

  it('picks the soonest not-done follow-up', () => {
    const lead = makeLead({ followUps: [fu('later', 500), fu('done', 10, true), fu('soon', 100)] });
    expect(nextPendingFollowUp(lead)?.id).toBe('soon');
  });

  it('null when everything is done or nothing is scheduled', () => {
    expect(nextPendingFollowUp(makeLead())).toBeNull();
    expect(nextPendingFollowUp(makeLead({ followUps: [fu('done', 10, true)] }))).toBeNull();
  });
});

describe('isContactOverdue (pinned to the Chicago desk day)', () => {
  const DAY = 86400_000;
  const now = Date.now();
  const cutoff = chicagoDayStart(now);

  it('uncontacted lead from a prior desk day is overdue; from today is not', () => {
    expect(isContactOverdue(makeLead({ receivedAt: cutoff - DAY }), now)).toBe(true);
    expect(isContactOverdue(makeLead({ receivedAt: cutoff + 1 }), now)).toBe(false);
  });

  it('lapsed reminder flags until a contact lands on/after it', () => {
    const lapsed = makeLead({
      contactAttempts: [{ ts: cutoff - 5 * DAY, outcome: 'voicemail' }],
      followUps: [{ id: 'f', type: 'callback', dueAt: cutoff - 2 * DAY, done: false }],
    });
    expect(isContactOverdue(lapsed, now)).toBe(true);
    const answered = makeLead({
      ...lapsed,
      contactAttempts: [...lapsed.contactAttempts, { ts: cutoff - DAY, outcome: 'no_answer' as const }],
    });
    expect(isContactOverdue(answered, now)).toBe(false);
  });
});

describe('makeEmptyLead', () => {
  it('fills sensible defaults and honors overrides', () => {
    const l = makeEmptyLead({ name: 'Jane', phone: '5551234567' });
    expect(l.name).toBe('Jane');
    expect(l.phone).toBe('5551234567');
    expect(l.stage).toBe('new');
    expect(l.source).toBe('manual');
    expect(l.conflictCheck.status).toBe('clear');
    expect(Array.isArray(l.followUps)).toBe(true);
  });
});
