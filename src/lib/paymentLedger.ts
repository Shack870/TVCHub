import type { Lead, Payment } from '../types';

// THE one source of truth for money math, used by every surface (Reports,
// Financing board, Today queue, drawers, CSV export).
//
// Historically the app carried two disjoint ledgers:
//   - Square (where the real money lives): the sync accumulates
//     `squarePaidTotal` and logs each reconciled charge as a via-'square'
//     contact attempt whose note carries the amount
//     ("Square payment received — $562.00 (payment ...)").
//   - Manual `financing.payments`: hand-entered records, mostly predating the
//     Square sync — only a couple of clients ever got entries.
//
// Unified rules:
//   collected(lead)  = squarePaidTotal + manual payments that are NOT the
//                      same money as a Square charge. Double-count guard: a
//                      manual entry is dropped when a Square charge of the
//                      same amount (within $1) landed within 5 days of the
//                      manual entry's date — that is one payment recorded
//                      twice, and the Square copy wins. A manual entry whose
//                      amount matches no nearby Square charge is real money
//                      taken outside Square and counts.
//   totalFee(lead)   = the manually recorded fee (financing.totalFee +
//                      warrantFee) when set, else the call-transcript
//                      saleAmount, else null (fee unknown).
//   outstanding(lead)= max(0, fee - collected) when the fee is known; 0 when
//                      the fee is unknown or the lead is paid in full. A
//                      saleStatus of 'paid_full' counts as settled even when
//                      the charge couldn't be matched to the lead — the
//                      ambiguous-payment post-it owns that reconciliation.

export const DUPLICATE_AMOUNT_TOLERANCE = 1; // dollars
export const DUPLICATE_WINDOW_MS = 5 * 86400_000; // ± 5 days

export interface LedgerEntry {
  ts: number;
  amount: number;
  source: 'square' | 'manual';
  method?: Payment['method'];
  // false = a manual entry judged to be the same money as a Square charge
  // (kept for display/history, excluded from every total).
  counted: boolean;
}

const SQUARE_NOTE_AMOUNT = /Square payment received — \$([\d,]+(?:\.\d+)?)/;

// Individual Square charges credited to this lead, parsed from the sync's
// contact-attempt trail. Used for time-window math and the duplicate guard;
// the all-time total comes from squarePaidTotal (authoritative even if an
// attempt was never logged).
export function squareEntries(lead: Lead): LedgerEntry[] {
  const out: LedgerEntry[] = [];
  for (const a of lead.contactAttempts ?? []) {
    if (a.via !== 'square' || typeof a.ts !== 'number') continue;
    const m = SQUARE_NOTE_AMOUNT.exec(a.notes ?? '');
    if (!m) continue;
    const amount = parseFloat(m[1].replace(/,/g, ''));
    if (!Number.isFinite(amount) || amount <= 0) continue;
    out.push({ ts: a.ts, amount, source: 'square', counted: true });
  }
  return out;
}

// Manual financing.payments with the duplicate guard applied (counted=false
// on entries that look like a Square charge recorded twice).
export function manualEntries(lead: Lead): LedgerEntry[] {
  const square = squareEntries(lead);
  return (lead.financing?.payments ?? []).map((p) => ({
    ts: p.date,
    amount: p.amount,
    source: 'manual' as const,
    method: p.method,
    counted: !square.some(
      (s) =>
        Math.abs(s.amount - p.amount) <= DUPLICATE_AMOUNT_TOLERANCE &&
        Math.abs(s.ts - p.date) <= DUPLICATE_WINDOW_MS,
    ),
  }));
}

// Full unified payment trail, oldest first (uncounted duplicates included,
// flagged, so history views can show them without double-counting).
export function ledgerEntries(lead: Lead): LedgerEntry[] {
  return [...squareEntries(lead), ...manualEntries(lead)].sort((a, b) => a.ts - b.ts);
}

export function collectedOf(lead: Lead): number {
  const manual = manualEntries(lead)
    .filter((e) => e.counted)
    .reduce((s, e) => s + e.amount, 0);
  return (lead.squarePaidTotal ?? 0) + manual;
}

// Money that landed inside [startMs, endMs): Square charges by the payment's
// own timestamp (the attempt ts carries Square's created_at), manual entries
// by their recorded date.
export function collectedInRange(lead: Lead, startMs: number, endMs: number): number {
  return ledgerEntries(lead)
    .filter((e) => e.counted && e.ts >= startMs && e.ts < endMs)
    .reduce((s, e) => s + e.amount, 0);
}

export function totalFeeOf(lead: Lead): number | null {
  const fin = lead.financing;
  const manualFee = fin ? (fin.totalFee ?? 0) + (fin.warrantFee ?? 0) : 0;
  if (manualFee > 0) return manualFee;
  if (typeof lead.saleAmount === 'number' && lead.saleAmount > 0) return lead.saleAmount;
  return null;
}

export function isPaidInFull(lead: Lead): boolean {
  const fee = totalFeeOf(lead);
  if (fee !== null && collectedOf(lead) >= fee) return true;
  return lead.saleStatus === 'paid_full';
}

export function outstandingOf(lead: Lead): number {
  if (isPaidInFull(lead)) return 0;
  const fee = totalFeeOf(lead);
  if (fee === null) return 0;
  return Math.max(0, fee - collectedOf(lead));
}

// When the newest counted payment landed (Square or manual), or null if no
// money has ever been recorded.
export function lastPaymentTs(lead: Lead): number | null {
  const ts = ledgerEntries(lead)
    .filter((e) => e.counted)
    .reduce((m, e) => Math.max(m, e.ts), 0);
  return ts > 0 ? ts : null;
}
