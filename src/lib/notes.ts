import type { TvcMessage } from '../types';

// Who stuck the note on the desk. New docs carry an explicit `source`; older
// ones are classified by what wrote them: missed calls and billing escalations
// come from the CallRail sync / cadence engine, and the cadence engine always
// signs its notes "TVCHub Cadence". Everything else is a human email.
export function isSystemNote(m: TvcMessage): boolean {
  if (m.source) return m.source === 'system';
  return (
    m.kind === 'missed_call' ||
    m.kind === 'billing_escalation' ||
    m.from === 'TVCHub Cadence'
  );
}

// Money-on-the-table escalations get the gold treatment. Older escalation docs
// predate the dedicated kind, so fall back to their fixed subject line.
export function isBillingNote(m: TvcMessage): boolean {
  return m.kind === 'billing_escalation' || /^Promised .+ never collected/i.test(m.subject ?? '');
}
