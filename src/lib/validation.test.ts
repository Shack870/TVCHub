import { describe, expect, it } from 'vitest';
import { validateLead } from './validation';

describe('validateLead', () => {
  it('passes a clean lead', () => {
    expect(
      validateLead({
        name: 'Jane Doe',
        email: 'jane@example.com',
        phone: '(555) 123-4567',
        nextCourtDate: '2026-09-01',
      }),
    ).toEqual([]);
  });

  it('requires a name', () => {
    expect(validateLead({ name: '' })).toContain('Name is required.');
    expect(validateLead({ name: '   ' })).toContain('Name is required.');
  });

  it('rejects a malformed email', () => {
    const errs = validateLead({ name: 'A', email: 'not-an-email' });
    expect(errs).toContain('Email looks invalid.');
  });

  it('accepts an empty optional email', () => {
    expect(validateLead({ name: 'A', email: '' })).toEqual([]);
  });

  it('flags phone numbers with too few / too many digits', () => {
    expect(validateLead({ name: 'A', phone: '123' })).toContain(
      'Phone should have 10–15 digits.',
    );
    expect(validateLead({ name: 'A', altPhone: '12345678901234567' })).toContain(
      'Alt phone should have 10–15 digits.',
    );
  });

  it('accepts a normally formatted phone', () => {
    expect(validateLead({ name: 'A', phone: '555-123-4567' })).toEqual([]);
  });

  it('rejects an invalid court date', () => {
    expect(validateLead({ name: 'A', nextCourtDate: 'soon' })).toContain(
      'Next court date is not a valid date.',
    );
  });
});
