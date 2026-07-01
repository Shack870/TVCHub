import {
  addWeeks,
  eachDayOfInterval,
  endOfWeek,
  format,
  startOfWeek,
  subDays,
} from 'date-fns';
import type { Lead } from '../types';
import { balanceOf, isClient, paidOf, totalFeeOf } from './leadFlow';
import { paymentPastDue } from './dates';

// The firm's sales week runs Monday 00:00 → the following Monday 00:00.
const WEEK_OPTS = { weekStartsOn: 1 as const };

export interface WeekRange {
  start: number; // inclusive (ms)
  end: number; // exclusive (ms) — next Monday
  label: string; // "Mon Jun 15 – Sun Jun 21"
}

export function weekRangeFor(ref: Date): WeekRange {
  const start = startOfWeek(ref, WEEK_OPTS);
  const end = addWeeks(start, 1);
  return {
    start: start.getTime(),
    end: end.getTime(),
    label: `${format(start, 'EEE MMM d')} – ${format(endOfWeek(ref, WEEK_OPTS), 'EEE MMM d')}`,
  };
}

function inRange(ts: number | null | undefined, r: WeekRange): boolean {
  return ts != null && ts >= r.start && ts < r.end;
}

function receivedAt(l: Lead): number {
  return l.receivedAt ?? l.createdAt ?? 0;
}

function pct(num: number, den: number): number {
  return den > 0 ? Math.round((num / den) * 100) : 0;
}

export interface DayBar {
  label: string;
  value: number;
}

export interface SalesReport {
  range: WeekRange;
  generatedAt: number;

  // This week's flow (Mon → end of week)
  leadsIn: number;
  callsLogged: number; // contact attempts logged this week (all leads)
  retainedThisWeek: number; // leads whose retainedAt falls in this week
  declinedThisWeek: number; // decline outcomes logged this week
  lostThisWeek: number; // leads written off this week
  revenueCollected: number; // payments dated this week
  attorneyRequests: number; // wants-attorney attempts this week

  // Cohort: of leads received THIS week, how the funnel looks so far
  cohortContacted: number;
  cohortRetained: number;
  cohortCloseRate: number; // %

  // Per-day leads-in for the bar chart (Mon..Sun)
  daily: DayBar[];

  // All-time book / rates
  totalLeads: number;
  contactedRate: number; // % of all leads with >=1 attempt
  clients: number; // ever retained
  lost: number; // written off
  closeRate: number; // clients / total leads, %
  decisionCloseRate: number; // clients / decided (clients + declined + lost), %
  declineRate: number; // declined / total, %
  financed: number;
  paidInFull: number;
  financeRate: number; // financed / clients, %
  avgFee: number;
  avgAttemptsToClose: number;
  avgSpeedToContactHours: number | null; // received -> first attempt
  pastDueAccounts: number; // clients with a payment past due
  outstanding: number;
  collectedAllTime: number;

  // Current pipeline snapshot (live counts by stage group)
  funnel: { label: string; value: number }[];
}

function hasDeclined(l: Lead): boolean {
  return (l.contactAttempts ?? []).some((a) => a.outcome === 'declined');
}

export function buildReport(leads: Lead[], ref: Date = new Date()): SalesReport {
  const range = weekRangeFor(ref);

  // --- This week's flow ---
  const leadsInList = leads.filter((l) => inRange(receivedAt(l), range));
  let callsLogged = 0;
  let declinedThisWeek = 0;
  let attorneyRequests = 0;
  let revenueCollected = 0;
  for (const l of leads) {
    for (const a of l.contactAttempts ?? []) {
      if (inRange(a.ts, range)) {
        callsLogged += 1;
        if (a.outcome === 'declined') declinedThisWeek += 1;
        if (a.outcome === 'wants_attorney') attorneyRequests += 1;
      }
    }
    for (const p of l.financing?.payments ?? []) {
      if (inRange(p.date, range)) revenueCollected += p.amount;
    }
  }
  const retainedThisWeek = leads.filter((l) => inRange(l.retainedAt, range)).length;
  const lostThisWeek = leads.filter((l) => inRange(l.lostAt, range)).length;

  // --- Cohort (received this week) ---
  const cohortContacted = leadsInList.filter((l) => (l.contactAttempts ?? []).length > 0).length;
  const cohortRetained = leadsInList.filter(isClient).length;

  // --- Daily bars ---
  const days = eachDayOfInterval({
    start: new Date(range.start),
    end: subDays(new Date(range.end), 1),
  });
  const daily: DayBar[] = days.map((d) => {
    const dayStart = d.getTime();
    const dayEnd = dayStart + 24 * 3600 * 1000;
    return {
      label: format(d, 'EEE'),
      value: leads.filter((l) => {
        const r = receivedAt(l);
        return r >= dayStart && r < dayEnd;
      }).length,
    };
  });

  // --- All-time rates ---
  const totalLeads = leads.length;
  const contacted = leads.filter((l) => (l.contactAttempts ?? []).length > 0).length;
  const clientList = leads.filter(isClient);
  const clients = clientList.length;
  const lost = leads.filter((l) => l.stage === 'lost').length;
  const declined = leads.filter((l) => !isClient(l) && l.stage !== 'lost' && hasDeclined(l)).length;
  const decided = clients + declined + lost;
  // Bucket by the live balance, not the flag: a client who paid off their plan
  // counts as paid in full, not financed.
  const paidInFull = clientList.filter((l) => balanceOf(l) === 0).length;
  const financed = clients - paidInFull;

  const avgFee = clients > 0 ? clientList.reduce((s, l) => s + totalFeeOf(l), 0) / clients : 0;
  const attemptsToClose = clientList.map((l) => (l.contactAttempts ?? []).length).filter((n) => n > 0);
  const avgAttemptsToClose =
    attemptsToClose.length > 0
      ? attemptsToClose.reduce((s, n) => s + n, 0) / attemptsToClose.length
      : 0;

  // Speed to first contact: received -> first logged attempt, in hours.
  const speeds: number[] = [];
  for (const l of leads) {
    const attempts = l.contactAttempts ?? [];
    if (attempts.length === 0) continue;
    const first = Math.min(...attempts.map((a) => a.ts));
    const gap = first - receivedAt(l);
    if (gap >= 0) speeds.push(gap);
  }
  const avgSpeedToContactHours =
    speeds.length > 0 ? speeds.reduce((s, n) => s + n, 0) / speeds.length / 3600000 : null;

  const pastDueAccounts = leads.filter((l) => isClient(l) && paymentPastDue(l)).length;
  const outstanding = clientList.reduce((s, l) => s + balanceOf(l), 0);
  const collectedAllTime = leads.reduce((s, l) => s + paidOf(l), 0);

  // --- Live pipeline snapshot ---
  const byStage = (fn: (l: Lead) => boolean) => leads.filter(fn).length;
  const funnel = [
    { label: 'New', value: byStage((l) => l.stage === 'new') },
    {
      label: 'Working',
      value: byStage((l) => ['callback', 'pitched', 'attorney_call'].includes(l.stage)),
    },
    { label: 'Nurture', value: byStage((l) => l.stage === 'nurture') },
    { label: 'Retained', value: byStage((l) => l.stage === 'retained') },
    { label: 'Intake Done', value: byStage((l) => l.stage === 'intake_complete') },
    { label: 'No Sale', value: byStage((l) => l.stage === 'lost') },
  ];

  return {
    range,
    generatedAt: Date.now(),
    leadsIn: leadsInList.length,
    callsLogged,
    retainedThisWeek,
    declinedThisWeek,
    lostThisWeek,
    revenueCollected,
    attorneyRequests,
    cohortContacted,
    cohortRetained,
    cohortCloseRate: pct(cohortRetained, leadsInList.length),
    daily,
    totalLeads,
    contactedRate: pct(contacted, totalLeads),
    clients,
    lost,
    closeRate: pct(clients, totalLeads),
    decisionCloseRate: pct(clients, decided),
    declineRate: pct(declined, totalLeads),
    financed,
    paidInFull,
    financeRate: pct(financed, clients),
    avgFee,
    avgAttemptsToClose,
    avgSpeedToContactHours,
    pastDueAccounts,
    outstanding,
    collectedAllTime,
    funnel,
  };
}

// Leads received per week for the last `count` weeks (oldest → newest).
export function weeklyLeadTrend(
  leads: Lead[],
  ref: Date = new Date(),
  count = 8,
): { label: string; value: number }[] {
  const out: { label: string; value: number }[] = [];
  for (let i = count - 1; i >= 0; i--) {
    const r = weekRangeFor(addWeeks(startOfWeek(ref, WEEK_OPTS), -i));
    const value = leads.filter((l) => {
      const t = l.receivedAt ?? l.createdAt ?? 0;
      return t >= r.start && t < r.end;
    }).length;
    out.push({ label: format(new Date(r.start), 'M/d'), value });
  }
  return out;
}

// Plain-text summary for pasting into the Friday email / Slack.
export function reportToText(r: SalesReport): string {
  const money = (n: number) =>
    n.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
  return [
    `TVCHub Weekly Sales Report`,
    `Week: ${r.range.label}`,
    `Generated: ${format(r.generatedAt, 'EEE MMM d, h:mm a')}`,
    ``,
    `THIS WEEK`,
    `• New leads in: ${r.leadsIn}`,
    `• Calls logged: ${r.callsLogged}`,
    `• Retained: ${r.retainedThisWeek}`,
    `• Declined: ${r.declinedThisWeek}`,
    `• No Sale: ${r.lostThisWeek}`,
    `• Attorney requests: ${r.attorneyRequests}`,
    `• Revenue collected: ${money(r.revenueCollected)}`,
    `• This week's cohort close rate: ${r.cohortCloseRate}% (${r.cohortRetained}/${r.leadsIn})`,
    ``,
    `RATES (all-time)`,
    `• Close rate: ${r.closeRate}% (${r.clients}/${r.totalLeads})`,
    `• Decision close rate: ${r.decisionCloseRate}% (of decided leads)`,
    `• Decline rate: ${r.declineRate}%`,
    `• Contacted rate: ${r.contactedRate}%`,
    `• Avg speed to first contact: ${r.avgSpeedToContactHours == null ? '—' : r.avgSpeedToContactHours.toFixed(1) + ' hrs'}`,
    `• Finance rate: ${r.financeRate}% financed (${r.financed} financed / ${r.paidInFull} paid in full)`,
    `• Avg fee: ${money(r.avgFee)}`,
    `• Avg attempts to close: ${r.avgAttemptsToClose.toFixed(1)}`,
    ``,
    `BOOK`,
    `• Outstanding balance: ${money(r.outstanding)}`,
    `• Past-due accounts: ${r.pastDueAccounts}`,
    `• Collected (all-time): ${money(r.collectedAllTime)}`,
  ].join('\n');
}
