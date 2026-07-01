import { isValid, parseISO } from 'date-fns';
import type { Lead } from '../types';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Returns the number of digits in a phone string (ignores formatting).
function digitCount(s: string): number {
  return (s.match(/\d/g) ?? []).length;
}

// Validates the user-editable fields of a (possibly partial) lead. Returns a
// list of human-readable problems; an empty list means it's safe to save.
// Kept pure and dependency-light so it can be unit-tested and reused.
export function validateLead(f: Partial<Lead>): string[] {
  const errors: string[] = [];

  if (!f.name || !f.name.trim()) {
    errors.push('Name is required.');
  }

  if (f.email && f.email.trim() && !EMAIL_RE.test(f.email.trim())) {
    errors.push('Email looks invalid.');
  }

  for (const [label, value] of [
    ['Phone', f.phone],
    ['Alt phone', f.altPhone],
  ] as const) {
    if (value && value.trim()) {
      const n = digitCount(value);
      if (n < 10 || n > 15) {
        errors.push(`${label} should have 10–15 digits.`);
      }
    }
  }

  if (f.nextCourtDate && !isValid(parseISO(f.nextCourtDate))) {
    errors.push('Next court date is not a valid date.');
  }

  return errors;
}
