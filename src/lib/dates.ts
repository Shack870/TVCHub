import {
  addMonths,
  differenceInCalendarDays,
  format,
  isValid,
  parseISO,
} from 'date-fns';
import type { Lead } from '../types';
import { balanceOf } from './leadFlow';

export function fmtDate(iso?: string | null): string {
  if (!iso) return '—';
  const d = parseISO(iso);
  return isValid(d) ? format(d, 'EEE, MMM d, yyyy') : iso;
}

export function fmtShort(iso?: string | null): string {
  if (!iso) return '—';
  const d = parseISO(iso);
  return isValid(d) ? format(d, 'MMM d') : iso;
}

export function fmtMoney(n?: number): string {
  return (n ?? 0).toLocaleString('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  });
}

// When a lead first appeared in the app, formatted for the card stamp:
// e.g. weekday "Tuesday" + rest "6/22/2026 · 9:23pm".
export function fmtAppeared(ms: number): { weekday: string; rest: string } {
  const d = new Date(ms);
  const time = `${format(d, 'h:mm')}${format(d, 'a').toLowerCase()}`;
  return { weekday: format(d, 'EEEE'), rest: `${format(d, 'M/d/yyyy')} · ${time}` };
}

// Fixed day-of-week color coding for the appeared stamp. Wednesday uses dark
// text so a yellow chip stays readable on the yellow pad; weekends are neutral.
export function weekdayColor(ms: number): { bg: string; fg: string } {
  switch (new Date(ms).getDay()) {
    case 1:
      return { bg: '#ea7317', fg: '#ffffff' }; // Monday — orange
    case 2:
      return { bg: '#2f74c0', fg: '#ffffff' }; // Tuesday — blue
    case 3:
      return { bg: '#e6b800', fg: '#3a2f00' }; // Wednesday — yellow
    case 4:
      return { bg: '#7c4dbd', fg: '#ffffff' }; // Thursday — purple
    case 5:
      return { bg: '#2f8f4e', fg: '#ffffff' }; // Friday — green
    default:
      return { bg: '#6b7280', fg: '#ffffff' }; // Sat/Sun — neutral
  }
}

// Days until a court date. Negative means it has already passed.
export function daysUntilCourt(lead: Lead): number | null {
  if (!lead.nextCourtDate) return null;
  const d = parseISO(lead.nextCourtDate);
  if (!isValid(d)) return null;
  return differenceInCalendarDays(d, new Date());
}

export function courtDatePassed(lead: Lead): boolean {
  const d = daysUntilCourt(lead);
  return d !== null && d < 0;
}

// The designed hard rule: no court date passes without being replaced or the
// case being dismissed. When true, the user must enter a new date or mark the
// case dismissed before money actions proceed.
export function needsCourtDateUpdate(lead: Lead): boolean {
  return courtDatePassed(lead) && !lead.caseDismissed;
}

export type FollowUpKind = 'week_before' | 'day_before' | 'warrant' | null;

// Determines which sales-command-center touch is currently relevant for a
// nurture lead, based purely on the court date math.
export function currentTouch(lead: Lead): {
  kind: FollowUpKind;
  due: boolean;
  overdue: boolean;
  label: string;
  days: number | null;
} {
  const days = daysUntilCourt(lead);
  if (days === null) {
    return { kind: null, due: false, overdue: false, label: 'No court date', days };
  }
  if (days < 0) {
    return {
      kind: 'warrant',
      due: true,
      overdue: true,
      label: 'Court date passed — warrant assistance',
      days,
    };
  }
  if (days <= 1) {
    return {
      kind: 'day_before',
      due: true,
      overdue: false,
      label: 'Day-before reminder + pitch',
      days,
    };
  }
  if (days <= 7) {
    return {
      kind: 'week_before',
      due: true,
      overdue: false,
      label: 'Week-before reminder + continuance offer',
      days,
    };
  }
  return {
    kind: null,
    due: false,
    overdue: false,
    label: `Court in ${days} days`,
    days,
  };
}

// Push an ISO date forward one month — used to roll a payment plan's due date
// after a payment is recorded.
export function advanceMonth(iso: string): string {
  const d = parseISO(iso);
  return isValid(d) ? format(addMonths(d, 1), 'yyyy-MM-dd') : iso;
}

// Is a financing payment past due? Only meaningful while a balance is actually
// owed — a paid-in-full client with a stale due date is NOT past due.
export function paymentPastDue(lead: Lead): boolean {
  if (balanceOf(lead) <= 0) return false;
  const due = lead.financing?.nextPaymentDue;
  if (!due) return false;
  const d = parseISO(due);
  if (!isValid(d)) return false;
  return differenceInCalendarDays(d, new Date()) < 0;
}
