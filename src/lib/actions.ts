import { createLead, updateLead } from './db';
import { balanceOf, isActiveLead, makeEmptyLead, stageForOutcome, totalFeeOf } from './leadFlow';
import { advanceMonth, needsCourtDateUpdate } from './dates';
import { computeFollow, DAY, nextTouch } from './followups';
import { buildPayment, type ChargeRequest } from './payments';
import type {
  ContactAttempt,
  ContactOutcome,
  CourtDate,
  FollowUp,
  FollowUpType,
  Lead,
} from '../types';

function uid(): string {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

// Single source of truth for "I had a contact and here's what happened": logs
// the attempt, advances the stage, and schedules the right next touch. Used by
// the quick-log chips on the desk AND the full wizard in the drawer so they
// can never drift apart.
export async function applyOutcome(
  lead: Lead,
  outcome: ContactOutcome,
  opts: {
    notes?: string;
    by?: string;
    followDate?: string;
    followType?: FollowUpType | null;
  } = {},
): Promise<void> {
  const now = Date.now();
  const attempt: ContactAttempt = {
    ts: now,
    outcome,
    notes: opts.notes,
    by: opts.by,
  };
  const patch: Partial<Lead> = {
    contactAttempts: [...(lead.contactAttempts ?? []), attempt],
    stage: stageForOutcome(outcome),
  };
  if (outcome === 'spoke' || outcome === 'thinking' || outcome === 'wants_attorney') {
    patch.pitchDelivered = true;
  }
  if (outcome === 'wants_attorney') {
    // Schedule the attorney call as a real follow-up so it surfaces on the
    // calendar and the Today queue, not just as a hidden timestamp.
    const at = opts.followDate
      ? new Date(opts.followDate + 'T09:00:00').getTime()
      : now + DAY;
    patch.attorneyCallAt = at;
    patch.followUps = [
      ...(lead.followUps ?? []),
      { id: uid(), type: 'attorney', dueAt: at, done: false, note: 'Attorney call' },
    ];
  } else if (outcome === 'lost') {
    // Written off: stop the clock and clear any pending follow-ups so it leaves
    // every active work queue.
    patch.lostAt = now;
    patch.lostReason = opts.notes;
    patch.followUps = (lead.followUps ?? []).map((f) =>
      f.done ? f : { ...f, done: true, doneAt: now },
    );
  } else {
    const f = computeFollow(outcome, lead.nextCourtDate, opts.followDate, opts.followType ?? null);
    if (f) {
      patch.followUps = [
        ...(lead.followUps ?? []),
        { id: uid(), type: f.type, dueAt: f.at, done: false, note: f.note },
      ];
    }
  }
  await updateLead(lead.id, patch);
}

// Flexible call logger for the contact wizard's decision tree: records the
// attempt, advances the stage, and schedules whatever explicit follow-up touches
// the wizard computed (so a decline can drop several court-relative reminders at
// once, etc.).
export async function logCallOutcome(
  lead: Lead,
  outcome: ContactOutcome,
  opts: {
    notes?: string;
    by?: string;
    attorneyCallAt?: number;
    touches?: { type: FollowUpType; dueAt: number; note: string }[];
  } = {},
): Promise<void> {
  const now = Date.now();
  const attempt: ContactAttempt = { ts: now, outcome, notes: opts.notes, by: opts.by };
  const patch: Partial<Lead> = {
    contactAttempts: [...(lead.contactAttempts ?? []), attempt],
    stage: stageForOutcome(outcome),
  };
  if (outcome === 'spoke' || outcome === 'thinking' || outcome === 'wants_attorney') {
    patch.pitchDelivered = true;
  }
  if (opts.attorneyCallAt) patch.attorneyCallAt = opts.attorneyCallAt;
  // Logging this call resolves whatever was already scheduled, so close every
  // open follow-up before adding the new one(s). This keeps exactly one active
  // follow-up thread per lead and prevents stale/duplicate calendar reminders.
  const superseded = (lead.followUps ?? []).map((f) =>
    f.done ? f : { ...f, done: true, doneAt: now },
  );
  const adds: FollowUp[] = (opts.touches ?? []).map((t) => ({
    id: uid(),
    type: t.type,
    dueAt: t.dueAt,
    done: false,
    note: t.note,
  }));
  patch.followUps = [...superseded, ...adds];
  await updateLead(lead.id, patch);
}

// A no-contact attempt (no answer / voicemail) from a work queue: log it and
// reschedule a callback, but DON'T change the sales stage — a pitched lead you
// couldn't reach is still awaiting a decision, not back to square one.
export async function logNoContact(
  lead: Lead,
  outcome: 'no_answer' | 'voicemail',
  by?: string,
): Promise<void> {
  const now = Date.now();
  const attempt: ContactAttempt = { ts: now, outcome, by };
  const followUps: FollowUp[] = (lead.followUps ?? []).filter(
    (f) => !(f.type === 'callback' && !f.done),
  );
  followUps.push({ id: uid(), type: 'callback', dueAt: now + DAY, done: false, note: 'Call back' });
  await updateLead(lead.id, {
    contactAttempts: [...(lead.contactAttempts ?? []), attempt],
    followUps,
  });
}

// Write a lead off as dead/unreachable/not interested.
export async function markLost(lead: Lead, by?: string, reason?: string): Promise<void> {
  await applyOutcome(lead, 'lost', { notes: reason ?? 'Marked lost', by });
}

// Bring a lost lead back into the working pipeline.
export async function reviveLost(lead: Lead): Promise<void> {
  await updateLead(lead.id, { stage: 'callback', lostAt: null });
}

// --- Ownership ---

// Assign a lead to a named rep (chosen from the Claim Lead dropdown). The owner
// label is the source of truth; ownerUid is a stable slug of the name. This is
// the single ownership mechanism in the app.
export async function assignLead(lead: Lead, owner: string | null): Promise<void> {
  await updateLead(lead.id, {
    owner,
    ownerUid: owner ? owner.toLowerCase().replace(/\s+/g, '_') : null,
  });
}

// --- Soft delete ---
// "Deleting" a file archives it (sets deletedAt) instead of destroying it, so a
// mistaken delete is fully recoverable. Archived files are hidden from every
// view. restoreLead brings one back.

export async function archiveLead(lead: Lead): Promise<void> {
  await updateLead(lead.id, { deletedAt: Date.now() });
}

export async function restoreLead(lead: Lead): Promise<void> {
  await updateLead(lead.id, { deletedAt: null });
}

export async function addLead(partial: Partial<Lead>): Promise<string> {
  return createLead(makeEmptyLead(partial));
}

export async function scheduleAttorneyCall(
  lead: Lead,
  whenMs: number,
): Promise<void> {
  // Replace any pending attorney follow-up with one at the new time so the
  // call shows on the calendar / Today queue and we never leave stale duplicates.
  const followUps: FollowUp[] = (lead.followUps ?? []).filter(
    (f) => !(f.type === 'attorney' && !f.done),
  );
  followUps.push({
    id: uid(),
    type: 'attorney',
    dueAt: whenMs,
    done: false,
    note: 'Attorney call',
  });
  await updateLead(lead.id, {
    stage: 'attorney_call',
    attorneyCallAt: whenMs,
    followUps,
  });
}

export async function setConflictCheck(
  lead: Lead,
  status: Lead['conflictCheck']['status'],
  notes?: string,
): Promise<void> {
  await updateLead(lead.id, { conflictCheck: { status, notes } });
}

export async function setCourtNotesCheck(
  lead: Lead,
  patch: Partial<Lead['courtNotesCheck']>,
): Promise<void> {
  await updateLead(lead.id, {
    courtNotesCheck: { ...lead.courtNotesCheck, ...patch },
  });
}

export async function retainLead(
  lead: Lead,
  totalFee: number,
  opts: {
    isFinanced?: boolean;
    nextPaymentDue?: string | null;
    monthlyAmount?: number;
  } = {},
): Promise<void> {
  // Merge onto any existing financing (e.g. a warrant fee added earlier) so the
  // fee entered at retention is always applied and prior payments are kept.
  const existing = lead.financing;
  const now = Date.now();
  await updateLead(lead.id, {
    stage: 'retained',
    retainedAt: lead.retainedAt ?? now,
    isFinanced: opts.isFinanced ?? false,
    // Sales follow-ups no longer apply once retained — close them so they don't
    // linger on the calendar / queues.
    followUps: (lead.followUps ?? []).map((f) =>
      f.done ? f : { ...f, done: true, doneAt: now },
    ),
    financing: {
      ...existing,
      totalFee,
      payments: existing?.payments ?? [],
      nextPaymentDue: opts.nextPaymentDue ?? existing?.nextPaymentDue ?? null,
      monthlyAmount: opts.monthlyAmount ?? existing?.monthlyAmount,
    },
  });
}

// Declining records why and when so the lead doesn't vanish silently into
// nurture: logs the outcome and schedules the next touch via applyOutcome.
export async function declineLead(lead: Lead, by?: string): Promise<void> {
  await applyOutcome(lead, 'declined', { notes: 'Declined — moved to follow-up', by });
}

export async function toggleRetainerSent(lead: Lead, v: boolean): Promise<void> {
  await updateLead(lead.id, { retainerSentForSignature: v });
}

export async function toggleRetainerSigned(lead: Lead, v: boolean): Promise<void> {
  await updateLead(lead.id, { retainerSignedConfirmed: v });
}

export async function markIntakeComplete(lead: Lead): Promise<void> {
  const now = Date.now();
  await updateLead(lead.id, {
    stage: 'intake_complete',
    intakeComplete: true,
    intakeCompleteAt: now,
    followUps: (lead.followUps ?? []).map((f) =>
      f.done ? f : { ...f, done: true, doneAt: now },
    ),
  });
}

export async function reopenIntake(lead: Lead): Promise<void> {
  await updateLead(lead.id, {
    stage: 'retained',
    intakeComplete: false,
    intakeCompleteAt: null,
  });
}

// Move a contacted pipeline lead back to the Initial Leads view. Initial Leads
// are uncontacted by definition, so this resets the contact log (attempts +
// scheduled follow-ups) to keep the model consistent.
export async function sendToInitialLeads(lead: Lead): Promise<void> {
  await updateLead(lead.id, {
    stage: 'new',
    contactAttempts: [],
    followUps: [],
  });
}

// Send a retained client back to the active leads board. Since they were
// contacted to get retained, they land in the Follow-Up Pipeline.
export async function unretain(lead: Lead): Promise<void> {
  const stage = (lead.contactAttempts?.length ?? 0) > 0 ? 'pitched' : 'new';
  await updateLead(lead.id, {
    stage,
    isFinanced: false,
    intakeComplete: false,
    intakeCompleteAt: null,
  });
}

// --- Financing ---

export async function recordPayment(
  lead: Lead,
  req: ChargeRequest,
): Promise<{ ok: boolean; error?: string }> {
  // Enforce the court-date rule at the source so no UI path can bypass it: a
  // passed, unresolved court date must be updated (or the case dismissed) first.
  if (needsCourtDateUpdate(lead)) {
    return {
      ok: false,
      error: 'Court date has passed — set a new date or mark the case dismissed before recording payment.',
    };
  }
  const res = buildPayment(req);
  if (!res.ok || !res.payment) return { ok: false, error: res.error };
  // Don't accept more than is owed — overpayment would silently vanish because
  // the balance floors at zero. Only enforce once a fee has been set.
  const owed = balanceOf(lead);
  if (totalFeeOf(lead) > 0 && req.amount > owed + 0.005) {
    return {
      ok: false,
      error: `Payment exceeds the ${owed.toLocaleString('en-US', {
        style: 'currency',
        currency: 'USD',
        maximumFractionDigits: 2,
      })} balance owed.`,
    };
  }
  const financing = lead.financing ?? { totalFee: 0, payments: [] };
  const payments = [...financing.payments, res.payment];
  const paidTotal = payments.reduce((s, p) => s + p.amount, 0);
  const total = (financing.totalFee ?? 0) + (financing.warrantFee ?? 0);
  const newBalance = Math.max(0, total - paidTotal);
  // Roll the plan's due date forward so a recorded payment doesn't leave the
  // account showing "past due": clear it when paid off, otherwise advance one
  // cycle from the prior due date.
  let nextPaymentDue = financing.nextPaymentDue ?? null;
  if (newBalance <= 0) {
    nextPaymentDue = null;
  } else if (financing.nextPaymentDue) {
    nextPaymentDue = advanceMonth(financing.nextPaymentDue);
  }
  // Don't force isFinanced here — whether a client is "on a payment plan" is set
  // explicitly at retention. Recording a single full payment shouldn't flag it.
  await updateLead(lead.id, {
    financing: { ...financing, payments, nextPaymentDue },
  });
  return { ok: true };
}

export async function setFinancingTerms(
  lead: Lead,
  patch: Partial<NonNullable<Lead['financing']>> & { isFinanced?: boolean },
): Promise<void> {
  const { isFinanced, ...fin } = patch;
  const financing = { ...(lead.financing ?? { totalFee: 0, payments: [] }), ...fin };
  await updateLead(lead.id, {
    financing,
    ...(isFinanced !== undefined ? { isFinanced } : {}),
  });
}

export async function addWarrantFee(lead: Lead, fee = 500): Promise<void> {
  const financing = lead.financing ?? { totalFee: 0, payments: [] };
  await updateLead(lead.id, {
    hasWarrant: true,
    financing: { ...financing, warrantFee: fee },
  });
}

// --- Court date enforcement ---

export async function updateCourtDate(
  lead: Lead,
  newDate: string,
  meta: { time?: string; type?: string } = {},
): Promise<void> {
  const prior: CourtDate | null = lead.nextCourtDate
    ? {
        date: lead.nextCourtDate,
        time: lead.nextCourtTime,
        type: lead.nextCourtType,
      }
    : null;
  const history = [...(lead.courtDateHistory ?? [])];
  if (prior) history.push(prior);
  await updateLead(lead.id, {
    nextCourtDate: newDate,
    nextCourtTime: meta.time ?? lead.nextCourtTime,
    nextCourtType: meta.type ?? lead.nextCourtType,
    courtDateHistory: history,
    caseDismissed: false,
  });
}

export async function markCaseDismissed(lead: Lead): Promise<void> {
  // Dismissing closes the matter, so the now-stale court date is moved to
  // history and cleared — otherwise it lingers as a passed date in views and
  // keeps re-triggering the "court date passed" prompt.
  const history = [...(lead.courtDateHistory ?? [])];
  if (lead.nextCourtDate) {
    history.push({
      date: lead.nextCourtDate,
      time: lead.nextCourtTime,
      type: lead.nextCourtType,
    });
  }
  await updateLead(lead.id, {
    caseDismissed: true,
    nextCourtDate: null,
    courtDateHistory: history,
  });
}

// --- Follow-ups ---

// Push an existing follow-up's due date out by moving it in place (NOT adding a
// new one), so snoozing never duplicates a calendar entry.
export async function snoozeFollowUp(
  lead: Lead,
  id: string,
  newDueAt: number,
): Promise<void> {
  const followUps = (lead.followUps ?? []).map((f) =>
    f.id === id ? { ...f, dueAt: newDueAt } : f,
  );
  await updateLead(lead.id, { followUps });
}

export async function completeFollowUp(lead: Lead, id: string): Promise<void> {
  const now = Date.now();
  const followUps = (lead.followUps ?? []).map((f) =>
    f.id === id ? { ...f, done: true, doneAt: now } : f,
  );
  // Auto-schedule the next touch so an active lead never goes silent after a
  // single follow-up. Only when nothing else is already pending.
  const stillPending = followUps.some((f) => !f.done);
  if (isActiveLead(lead) && !stillPending) {
    const priorTouches = followUps.filter((f) => f.done).length;
    const nt = nextTouch(lead, priorTouches);
    if (nt) {
      followUps.push({ id: uid(), type: nt.type, dueAt: nt.at, done: false, note: nt.note });
    }
  }
  await updateLead(lead.id, { followUps });
}
