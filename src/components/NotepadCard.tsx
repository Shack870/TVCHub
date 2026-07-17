import { useState } from 'react';
import { motion } from 'framer-motion';
import type { Lead } from '../types';
import { fmtDate, daysUntilCourt, fmtAppeared, weekdayColor } from '../lib/dates';
import { isActiveLead, isContactOverdue, STAGE_LABELS } from '../lib/leadFlow';
import { Badge } from './ui/Badge';

function stageTone(stage: Lead['stage']) {
  switch (stage) {
    case 'new':
      return 'blue' as const;
    case 'callback':
      return 'amber' as const;
    case 'pitched':
      return 'green' as const;
    case 'attorney_call':
      return 'blue' as const;
    default:
      return 'neutral' as const;
  }
}

export function NotepadCard({
  lead,
  onOpen,
  big = false,
}: {
  lead: Lead;
  onOpen?: () => void;
  big?: boolean;
}) {
  const [now] = useState(() => Date.now());

  const uncontacted = isActiveLead(lead) && (lead.contactAttempts?.length ?? 0) === 0;
  const ageHrs = (now - (lead.receivedAt ?? lead.createdAt)) / 3600000;
  const ageTone = ageHrs >= 24 ? 'red' : ageHrs >= 4 ? 'amber' : 'neutral';
  const ageLabel = ageHrs < 1 ? 'just in' : ageHrs < 48 ? `${Math.round(ageHrs)}h old` : `${Math.round(ageHrs / 24)}d old`;

  const days = daysUntilCourt(lead);
  const courtTone =
    days !== null && days < 0 ? 'red' : days !== null && days <= 7 ? 'amber' : 'neutral';
  const overdue = isContactOverdue(lead);

  const appearedAt = lead.receivedAt ?? lead.createdAt;
  const appeared = fmtAppeared(appearedAt);
  const dayColor = weekdayColor(appearedAt);

  // TVC re-sent this case after we already had it — usually a nudge that the
  // referral hasn't been worked yet. Only flag genuine re-sends, not the
  // near-simultaneous text+PDF pair the first referral often arrives as.
  const resent =
    (lead.lastReferralAt ?? 0) - appearedAt > 3600000 &&
    (lead.contactAttempts?.length ?? 0) === 0;

  return (
    <motion.div
      whileHover={{ y: -3 }}
      transition={{ duration: 0.12 }}
      className={`legal-pad group relative block w-full overflow-hidden rounded-lg text-left shadow-card ring-1 ring-black/10 ${
        overdue ? 'ring-2 ring-pad-red/70' : ''
      } ${big ? 'min-h-[460px]' : 'min-h-[230px]'}`}
    >
      {/* top binding strip with holes */}
      <div className="pad-binding flex h-7 items-center gap-6 px-12">
        {Array.from({ length: 7 }).map((_, i) => (
          <span key={i} className="h-3 w-3 rounded-full bg-felt/70 shadow-inner" />
        ))}
      </div>

      {/* Oversight stamp — cleared only by logging a new contact attempt.
          Sits over the blank space to the right of the client's name. */}
      {overdue && (
        <div
          className={`pointer-events-none absolute right-3 z-10 -rotate-12 ${
            big ? 'top-40' : 'top-[6.5rem]'
          }`}
        >
          <span className={`stamp text-pad-red ${big ? 'text-2xl' : 'text-base'}`}>
            Contact Overdue
          </span>
        </div>
      )}

      {/* Body — clicking opens the full file (on the Contact Attempt tab). */}
      <div
        role="button"
        tabIndex={0}
        onClick={onOpen}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            onOpen?.();
          }
        }}
        className={`relative cursor-pointer pl-16 pr-6 outline-none ${big ? 'pt-5 pb-4' : 'pt-3 pb-4'}`}
      >
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            {/* When this lead appeared in the app — weekday color-coded. */}
            <div className="mb-1 flex items-center gap-2">
              <span
                className="rounded px-1.5 py-0.5 font-type text-[10px] font-bold uppercase tracking-wide"
                style={{ backgroundColor: dayColor.bg, color: dayColor.fg }}
              >
                {appeared.weekday}
              </span>
              <span className="data text-[11px] text-pad-inkSoft/80">{appeared.rest}</span>
            </div>
            <p className="data text-pad-inkSoft/70 text-[11px] leading-none">
              TVC #{lead.tvcCaseNumber || '—'}
            </p>
            <h3
              className={`font-hand ink leading-tight ${big ? 'text-5xl' : 'text-3xl'}`}
            >
              {lead.name}
            </h3>
          </div>
          <div className="flex shrink-0 flex-col items-end gap-1">
            <Badge tone={stageTone(lead.stage)}>{STAGE_LABELS[lead.stage]}</Badge>
            {lead.needsReview && <Badge tone="amber">Needs review</Badge>}
            {resent && (
              <Badge tone="red">
                re-sent by TVC{' '}
                {new Date(lead.lastReferralAt!).toLocaleDateString('en-US', {
                  month: 'numeric',
                  day: 'numeric',
                })}
              </Badge>
            )}
            {uncontacted && <Badge tone={ageTone}>uncontacted · {ageLabel}</Badge>}
            {lead.owner && (
              <span className="data text-[10px] text-pad-inkSoft/70">{lead.owner}</span>
            )}
          </div>
        </div>

        <div
          className={`mt-2 grid gap-x-6 gap-y-1 text-pad-ink ${
            big ? 'grid-cols-2 text-sm' : 'grid-cols-1 text-xs'
          }`}
        >
          <Row label="Charge" value={lead.charge || lead.nextCourtType || '—'} />
          <PhoneRow phone={lead.phone} />
          {lead.altPhone && <PhoneRow phone={lead.altPhone} label="Alt" />}
          {lead.email && <EmailRow email={lead.email} />}
          <Row label="Court" value={lead.courtName || '—'} />
          <Row
            label="County"
            value={[lead.county, lead.state].filter(Boolean).join(', ') || '—'}
          />
          <div className="col-span-full mt-1 flex items-center gap-2">
            <span className="field-label">Court Date</span>
            <Badge tone={courtTone}>
              <span className="data">
                {fmtDate(lead.nextCourtDate)}
                {days !== null && (
                  <span className="opacity-80">
                    {' '}· {days < 0 ? `${Math.abs(days)}d ago` : `${days}d`}
                  </span>
                )}
              </span>
            </Badge>
          </div>
        </div>

        {lead.contactAttempts?.length > 0 && (
          <p className="mt-2 data text-[11px] text-pad-inkSoft/70">
            {lead.contactAttempts.length} attempt
            {lead.contactAttempts.length > 1 ? 's' : ''} logged
          </p>
        )}
      </div>
    </motion.div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline gap-2 truncate">
      <span className="field-label shrink-0">{label}</span>
      <span className="truncate data">{value}</span>
    </div>
  );
}

function PhoneRow({ phone, label = 'Phone' }: { phone?: string; label?: string }) {
  return (
    <div className="flex items-baseline gap-2 truncate">
      <span className="field-label shrink-0">{label}</span>
      {phone ? (
        <a
          href={`tel:${phone.replace(/[^\d+]/g, '')}`}
          onClick={(e) => e.stopPropagation()}
          className="ink-link truncate"
          title={`Call ${phone}`}
        >
          {phone}
        </a>
      ) : (
        <span className="data text-pad-inkSoft/60">—</span>
      )}
    </div>
  );
}

function EmailRow({ email }: { email: string }) {
  return (
    <div className="flex items-baseline gap-2 truncate">
      <span className="field-label shrink-0">Email</span>
      <a
        href={`mailto:${email}`}
        onClick={(e) => e.stopPropagation()}
        className="ink-link truncate"
        title={`Email ${email}`}
      >
        {email}
      </a>
    </div>
  );
}
