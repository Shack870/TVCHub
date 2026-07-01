import type { Lead } from '../types';

// Minimal Lead factory for unit tests — fill only what a test cares about.
export function makeLead(partial: Partial<Lead> = {}): Lead {
  const now = Date.now();
  return {
    id: partial.id ?? 'test-id',
    name: 'Test Lead',
    source: 'manual',
    receivedAt: now,
    stage: 'new',
    contactAttempts: [],
    followUps: [],
    conflictCheck: { status: 'pending' },
    courtNotesCheck: { allowsTrialInAbstentia: null, allowsWaiver: null },
    createdAt: now,
    updatedAt: now,
    ...partial,
  };
}
