import type { Payment } from '../types';

// Payments are taken outside the app (the firm's own card terminal, cash, or
// check) and simply *recorded* here so the financing tracker stays accurate.
// No external payment gateway is contacted.

export interface ChargeRequest {
  amount: number;
  method: Payment['method'];
  note?: string;
}

export interface ChargeResult {
  ok: boolean;
  payment?: Payment;
  error?: string;
}

function uid(): string {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

// Validates the amount and builds the payment record to persist.
export function buildPayment(req: ChargeRequest): ChargeResult {
  if (!(req.amount > 0)) {
    return { ok: false, error: 'Amount must be greater than zero.' };
  }
  return {
    ok: true,
    payment: {
      id: uid(),
      amount: req.amount,
      date: Date.now(),
      method: req.method,
      note: req.note,
    },
  };
}

export const PAYMENT_METHODS: { value: Payment['method']; label: string }[] = [
  { value: 'card', label: 'Card' },
  { value: 'cash', label: 'Cash' },
  { value: 'check', label: 'Check' },
  { value: 'other', label: 'Other' },
];
