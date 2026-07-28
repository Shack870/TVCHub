import type { Lead, TvcMessage } from '../types';

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

const last10 = (p?: string | null) => (p ?? '').replace(/\D/g, '').slice(-10);

// Which client is this note about? Lets the post-it link straight to their
// file. Tries the strongest identity signals first (explicit leadId, TVC case
// number), then contact info, then a name mention in the note text. Every
// fuzzy signal only counts when exactly ONE lead fits — a wrong link is worse
// than no link.
export function resolveNoteLead(m: TvcMessage, leads: Lead[]): Lead | null {
  const live = leads.filter((l) => !l.deletedAt);

  if (m.leadId) {
    const hit = live.find((l) => l.id === m.leadId);
    if (hit) return hit;
  }

  if (m.tvcCaseNumber) {
    const hits = live.filter(
      (l) => String(l.tvcCaseNumber ?? '').trim() === String(m.tvcCaseNumber).trim(),
    );
    if (hits.length === 1) return hits[0];
  }

  const email = (m.email ?? '').trim().toLowerCase();
  if (email) {
    const hits = live.filter((l) => (l.email ?? '').trim().toLowerCase() === email);
    if (hits.length === 1) return hits[0];
  }

  const phone = last10(m.phone);
  if (phone.length === 10) {
    const hits = live.filter((l) => last10(l.phone) === phone || last10(l.altPhone) === phone);
    if (hits.length === 1) return hits[0];
  }

  // Name mention: the Re: memberName field, or the lead's full name written in
  // the subject/body ("Possible existing client — Avtar Singh Cheira"). Full
  // names of 6+ chars only, so short names can't collide by accident.
  const text = `${m.memberName ?? ''} ${m.subject ?? ''} ${m.message ?? ''}`.toLowerCase();
  const named = live.filter((l) => {
    const n = (l.name ?? '').trim().toLowerCase();
    return n.length >= 6 && text.includes(n);
  });
  if (named.length === 1) return named[0];

  return null;
}
