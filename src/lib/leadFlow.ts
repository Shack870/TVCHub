import { differenceInCalendarDays, isValid, parseISO } from 'date-fns';
import type {
  ContactOutcome,
  FollowUp,
  Lead,
  Stage,
} from '../types';
import { isPaidInFull, outstandingOf } from './paymentLedger';

export const STAGE_LABELS: Record<Stage, string> = {
  new: 'Initial Lead',
  callback: 'Callback Queue',
  pitched: 'Pitched',
  attorney_call: 'Attorney Call',
  nurture: 'Follow-Up',
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

// --- The chase (idle-but-alive leads) ----------------------------------------
// A voicemail or no-answer is NOT a contact. Until one of these outcomes is
// logged, the lead has never had a real two-way conversation and the cadence
// engine keeps chasing it. Mirrors CONVERSATION_OUTCOMES in
// functions/src/cadence.ts — keep the two lists in sync.
export const CONVERSATION_OUTCOMES: ContactOutcome[] = [
  'spoke',
  'thinking',
  'declined',
  'verbal_yes',
  'wants_attorney',
  'retained',
  'lost',
];

// The chase stops after this many total attempts with no conversation.
// Mirrors MAX_CHASE_ATTEMPTS in functions/src/cadence.ts.
export const MAX_CHASE_ATTEMPTS = 8;

// The cadence engine's chase hard-stops once the next touch would land AFTER
// the lead's motions-filing deadline (see src/lib/motionsDeadline.ts and the
// mirror in functions/src/cadence.ts) — after that the free court-reminder
// remarketing is the final hook. The Ripe queue keeps showing the lead all
// the way through the motions window (with escalating deadline tags) and only
// hands off for the last week before court, when the week-before/day-before
// reminders own it.
export const RIPE_COURT_MIN_DAYS = 7;

// Has a real two-way conversation ever happened on this lead?
export function hasConversation(lead: Lead): boolean {
  if (lead.lastConnectedAt) return true;
  return (lead.contactAttempts ?? []).some((a) => CONVERSATION_OUTCOMES.includes(a.outcome));
}

// Escalating script angle for a chase touch number. Mirrors chaseAngleForTouch
// in functions/src/cadence.ts — keep the copy in sync.
export function chaseAngleForTouch(touch: number): string {
  if (touch <= 2) return 'Be specific: court date, county, what a conviction does to a CDL';
  if (touch === 3) return 'Anchor price + ease: most drivers never appear in person — we handle it';
  return 'Deadline framing: we need time to file entry of appearance';
}

// The cadence engine's pending chase follow-up on this lead, if any.
export function pendingChaseFollowUp(lead: Lead): FollowUp | null {
  return (lead.followUps ?? []).find((f) => !f.done && f.type === 'chase') ?? null;
}

// Days until the court date (negative = passed), or null when none is set.
// Local copy so leadFlow doesn't import ./dates (which imports this module).
function courtInDays(lead: Lead): number | null {
  if (!lead.nextCourtDate) return null;
  const d = parseISO(lead.nextCourtDate);
  return isValid(d) ? differenceInCalendarDays(d, new Date()) : null;
}

// RIPE: pitched (or at least voicemailed) but never a real conversation, with
// a future court date. These are alive-but-idle files the far-future court
// reminders used to mask — they get their own warm queue on the Today view,
// sorted by motions deadline (that's what actually expires the pitch). Not
// ripe once the court date is inside the final pre-court week (the
// week-before/day-before reminders own the lead then), once the chase is
// exhausted, or once money is promised/paid (those have their own billing
// tracks).
export function isRipe(lead: Lead): boolean {
  if (!isActiveLead(lead) || lead.deletedAt) return false;
  const attempts = lead.contactAttempts ?? [];
  if (attempts.length === 0 || attempts.length >= MAX_CHASE_ATTEMPTS) return false;
  if (lead.cadenceExhaustedAt) return false;
  if (hasConversation(lead)) return false;
  if (lead.saleStatus && lead.saleStatus !== 'none') return false;
  const days = courtInDays(lead);
  return days !== null && days > RIPE_COURT_MIN_DAYS;
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

// Still being worked: not financed, handed off, or written off.
export function isActiveLead(lead: Lead): boolean {
  return !['financed', 'intake_complete', 'lost'].includes(lead.stage);
}

// Reached a final disposition (won or lost).
export function isTerminal(lead: Lead): boolean {
  return ['financed', 'intake_complete', 'lost'].includes(lead.stage);
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
    // A retained outcome means money moved on the call — paid clients are
    // handed off (the Square/CallRail sync applies the same routing).
    case 'retained':
      return 'intake_complete';
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

// A lead we actually signed (financed or already handed off).
export function isClient(lead: Lead): boolean {
  return lead.stage === 'financed' || lead.stage === 'intake_complete';
}

// A lead belongs on the ACTIVE Financing board while it still owes money —
// either a retained client owing a balance, or a non-client who's been
// charged a warrant fee (so that money is actually collectable somewhere).
// Money math comes from the unified payment ledger (Square + non-duplicate
// manual entries), so a client whose fee Square already covered NEVER shows
// here — they land in the Past Financed archive instead.
// Leads in the dedicated "financed" stage always show while unpaid, even
// before a payment-plan record has been filled in.
export function isFinancingClient(lead: Lead): boolean {
  if (isPaidInFull(lead)) return false;
  if (lead.stage === 'financed') return true;
  if (outstandingOf(lead) <= 0) return false;
  return isClient(lead) || Boolean(lead.hasWarrant);
}

// The Past Financed archive: was on a payment plan (financed stage/flag, a
// manual financing record, or a warrant-fee plan) and is now fully collected.
// Clients who paid in full on the spot were never financed and don't belong
// here.
export function isPastFinanced(lead: Lead): boolean {
  if (!isPaidInFull(lead)) return false;
  if (lead.stage === 'financed' || lead.isFinanced) return true;
  const fin = lead.financing;
  if (fin && ((fin.totalFee ?? 0) + (fin.warrantFee ?? 0) > 0 || fin.payments.length > 0)) {
    return true;
  }
  return Boolean(lead.hasWarrant);
}

// --- Receivables (Square-tracked payment plans) -----------------------------
// The Square sync logs every reconciled charge as a via-'square' contact
// attempt and accumulates squarePaidTotal; these helpers read that trail.

// A plan with no payment this long is considered stalled on the board. The
// cadence engine uses a slightly longer 35-day window before raising a
// post-it (see functions/src/cadence.ts).
export const PLAN_STALL_DAYS = 30;

// Newest Square payment credited to the lead, or null if none ever landed.
export function lastSquarePaymentTs(lead: Lead): number | null {
  const ts = (lead.contactAttempts ?? [])
    .filter((a) => a.via === 'square' && typeof a.ts === 'number')
    .reduce((m, a) => Math.max(m, a.ts), 0);
  return ts > 0 ? ts : null;
}

// Days since the plan last saw money. When no payment ever landed, count from
// when the case entered its financed/paid state instead, so a plan that never
// produced a single payment still ages into the stall flag.
export function daysSinceLastSquarePayment(lead: Lead): number | null {
  const anchor =
    lastSquarePaymentTs(lead) ?? lead.intakeCompleteAt ?? lead.saleStatusAt ?? null;
  if (!anchor) return null;
  return Math.floor((Date.now() - anchor) / 86400_000);
}

export function isPlanStalled(lead: Lead): boolean {
  if (lead.stage !== 'financed') return false;
  // A fully collected plan can't stall — it's done (Past Financed).
  if (isPaidInFull(lead)) return false;
  const days = daysSinceLastSquarePayment(lead);
  return days !== null && days > PLAN_STALL_DAYS;
}
