import { describe, expect, it } from 'vitest';
import {
  balanceOf,
  isActiveLead,
  isClient,
  isFinancingClient,
  isOnBoard,
  isPaidInFull,
  isTerminal,
  makeEmptyLead,
  paidOf,
  stageForOutcome,
  totalFeeOf,
} from './leadFlow';
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

describe('financing math', () => {
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

  it('sums fee, paid, and balance including warrant fee', () => {
    expect(totalFeeOf(lead)).toBe(1500);
    expect(paidOf(lead)).toBe(1000);
    expect(balanceOf(lead)).toBe(500);
  });

  it('treats no-financing leads as zero', () => {
    const bare = makeLead();
    expect(totalFeeOf(bare)).toBe(0);
    expect(balanceOf(bare)).toBe(0);
    expect(isPaidInFull(bare)).toBe(false);
  });

  it('isPaidInFull only when there is a fee and zero balance', () => {
    const paid = makeLead({
      stage: 'intake_complete',
      financing: {
        totalFee: 500,
        payments: [{ id: 'a', amount: 500, date: 0, method: 'card' }],
      },
    });
    expect(isPaidInFull(paid)).toBe(true);
    expect(isFinancingClient(paid)).toBe(false); // paid off => drops out
  });

  it('isFinancingClient when a client still owes', () => {
    expect(isFinancingClient(lead)).toBe(true);
  });

  it('isFinancingClient for a non-client with a warrant fee owed', () => {
    const warrant = makeLead({
      stage: 'nurture',
      hasWarrant: true,
      financing: { totalFee: 0, warrantFee: 500, payments: [] },
    });
    expect(isFinancingClient(warrant)).toBe(true);
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
