import type {
  ContactOutcome,
  Lead,
  Stage,
} from '../types';

export const STAGE_LABELS: Record<Stage, string> = {
  new: 'Initial Lead',
  callback: 'Callback Queue',
  pitched: 'Pitched',
  attorney_call: 'Attorney Call',
  nurture: 'Follow-Up',
  retained: 'Retained',
  financed: 'Financed',
  intake_complete: 'Intake Complete',
  lost: 'No Sale',
};

export const OUTCOME_LABELS: Record<ContactOutcome, string> = {
  no_answer: 'No Answer',
  voicemail: 'Left Voicemail',
  spoke: 'Spoke With Lead',
  declined: 'Declined',
  thinking: 'Thinking About It',
  verbal_yes: 'Said Yes — Billing Pending',
  wants_attorney: 'Wants Attorney',
  retained: 'Retained',
  lost: 'No Sale',
};

// The money-on-the-table state: a verbal yes with no payment collected, on a
// lead that hasn't actually been retained/closed yet.
export function isSalePending(lead: Lead): boolean {
  return lead.saleStatus === 'promised_unpaid' && isActiveLead(lead);
}

// Leads shown on the main notepad board (active intake, not yet decided/handed off).
export function isOnBoard(lead: Lead): boolean {
  return ['new', 'callback', 'pitched', 'attorney_call', 'nurture'].includes(lead.stage);
}

// Initial Leads: brand-new, uncontacted (no first attempt logged yet).
export function isInitialLead(lead: Lead): boolean {
  return lead.stage === 'new';
}

// Oversight: a contact that should have happened didn't. Two cases:
//   1. First-contact SLA — an uncontacted, still-active lead that arrived on a
//      prior day (you should reach every lead the day it comes in).
//   2. Lapsed reminder — a scheduled follow-up's day passed with no contact
//      logged on/after it.
// Either way, the only thing that clears it is logging a new contact attempt.
export function isContactOverdue(lead: Lead): boolean {
  const startToday = new Date();
  startToday.setHours(0, 0, 0, 0);
  const cutoff = startToday.getTime();
  const attempts = lead.contactAttempts ?? [];

  // 1. Never contacted and it's been sitting since before today.
  if (isActiveLead(lead) && attempts.length === 0) {
    const received = lead.receivedAt ?? lead.createdAt;
    return received < cutoff;
  }

  // 2. A reminder lapsed without a contact since it came due.
  const followUps = lead.followUps ?? [];
  if (followUps.length === 0) return false;
  const lastContact = attempts.reduce((m, a) => Math.max(m, a.ts), 0);
  return followUps.some((f) => !f.done && f.dueAt < cutoff && lastContact < f.dueAt);
}

// Follow-Up Pipeline: contacted but not yet retained / handed off / written off.
export function isPipelineLead(lead: Lead): boolean {
  return ['callback', 'pitched', 'attorney_call', 'nurture'].includes(lead.stage);
}

// Still being worked: not retained, financed, handed off, or written off.
export function isActiveLead(lead: Lead): boolean {
  return !['retained', 'financed', 'intake_complete', 'lost'].includes(lead.stage);
}

// Reached a final disposition (won or lost).
export function isTerminal(lead: Lead): boolean {
  return ['retained', 'financed', 'intake_complete', 'lost'].includes(lead.stage);
}

// Which stage a contact outcome moves the lead to.
export function stageForOutcome(outcome: ContactOutcome): Stage {
  switch (outcome) {
    case 'no_answer':
    case 'voicemail':
      return 'callback';
    case 'spoke':
    case 'thinking':
    // A verbal yes isn't retained until money is collected — the lead stays
    // pitched with the gold billing treatment driving the collection.
    case 'verbal_yes':
      return 'pitched';
    case 'wants_attorney':
      return 'attorney_call';
    case 'declined':
      return 'nurture';
    case 'retained':
      return 'retained';
    case 'lost':
      return 'lost';
    default:
      return 'pitched';
  }
}

export function makeEmptyLead(partial: Partial<Lead>): Omit<Lead, 'id'> {
  const now = Date.now();
  return {
    name: 'Unknown',
    source: 'manual',
    receivedAt: now,
    stage: 'new',
    contactAttempts: [],
    followUps: [],
    conflictCheck: { status: 'clear' },
    courtNotesCheck: { allowsTrialInAbstentia: null, allowsWaiver: null },
    createdAt: now,
    updatedAt: now,
    ...partial,
  };
}

// A lead we actually signed (retained/financed, possibly already handed off).
export function isClient(lead: Lead): boolean {
  return (
    lead.stage === 'retained' || lead.stage === 'financed' || lead.stage === 'intake_complete'
  );
}

// Has a fee and owes nothing — the balance is the source of truth, regardless
// of whether the `isFinanced` flag was ever set.
export function isPaidInFull(lead: Lead): boolean {
  return totalFeeOf(lead) > 0 && balanceOf(lead) === 0;
}

// A lead belongs in the Financing view while it owes money — either a retained
// client on/owing a balance, or a non-client who's been charged a warrant fee
// (so that money is actually collectable somewhere). Paid-off = drops out.
// Leads in the dedicated "financed" stage always show here, even before a
// payment-plan record has been filled in.
export function isFinancingClient(lead: Lead): boolean {
  if (lead.stage === 'financed') return true;
  if (balanceOf(lead) <= 0) return false;
  return isClient(lead) || Boolean(lead.hasWarrant);
}

export function balanceOf(lead: Lead): number {
  if (!lead.financing) return 0;
  const paid = lead.financing.payments.reduce((s, p) => s + p.amount, 0);
  const total = lead.financing.totalFee + (lead.financing.warrantFee ?? 0);
  return Math.max(0, total - paid);
}

export function paidOf(lead: Lead): number {
  if (!lead.financing) return 0;
  return lead.financing.payments.reduce((s, p) => s + p.amount, 0);
}

export function totalFeeOf(lead: Lead): number {
  if (!lead.financing) return 0;
  return lead.financing.totalFee + (lead.financing.warrantFee ?? 0);
}
