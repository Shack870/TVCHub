import { motion } from 'framer-motion';
import type { FollowUp, Lead } from '../types';
import { fmtDate, daysUntilCourt, fmtAppeared, weekdayColor } from '../lib/dates';
import {
  chicagoDayStart,
  isActiveLead,
  isContactOverdue,
  isSalePending,
  nextPendingFollowUp,
  showsMotionsDeadline,
  STAGE_LABELS,
} from '../lib/leadFlow';
import { motionsDeadlineFor } from '../lib/motionsDeadline';
import { useNow } from '../lib/useNow';
import { Badge } from './ui/Badge';

function PhoneGlyph({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className={className} aria-hidden>
      <path d="M6.6 10.8c1.4 2.8 3.8 5.1 6.6 6.6l2.2-2.2c.3-.3.7-.4 1-.2 1.2.4 2.4.6 3.7.6.6 0 1 .4 1 1V20c0 .6-.4 1-1 1C10.6 21 3 13.4 3 4c0-.6.4-1 1-1h3.5c.6 0 1 .4 1 1 0 1.2.2 2.5.6 3.7.1.3 0 .7-.2 1l-2.3 2.1z" />
    </svg>
  );
}

const FOLLOWUP_LABELS: Record<FollowUp['type'], string> = {
  callback: 'Call back',
  nurture: 'Nurture check-in',
  chase: 'Chase call',
  week_before: 'Week-before-court call',
  day_before: 'Day-before-court call',
  motions: 'Motions-deadline heads-up call',
  warrant: 'Warrant follow-up',
  attorney: 'Attorney call',
  billing: 'Collect promised payment',
};

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
  // Ticking clock, not mount-time: age badges and the fresh-call glow must
  // keep aging while the board sits open.
  const now = useNow();

  const uncontacted = isActiveLead(lead) && (lead.contactAttempts?.length ?? 0) === 0;
  const ageHrs = (now - (lead.receivedAt ?? lead.createdAt)) / 3600000;
  const ageTone = ageHrs >= 24 ? 'red' : ageHrs >= 4 ? 'amber' : 'neutral';
  const ageLabel = ageHrs < 1 ? 'just in' : ageHrs < 48 ? `${Math.round(ageHrs)}h old` : `${Math.round(ageHrs / 24)}d old`;

  const days = daysUntilCourt(lead);
  const courtTone =
    days !== null && days < 0 ? 'red' : days !== null && days <= 7 ? 'amber' : 'neutral';
  const overdue = isContactOverdue(lead, now);

  // The lead's next scheduled touch — what the Follow-Up Pipeline is actually
  // waiting on. Red once its day has passed on the desk clock (Chicago).
  const nextTouch = isActiveLead(lead) ? nextPendingFollowUp(lead) : null;
  const nextTouchOverdue = nextTouch !== null && nextTouch.dueAt < chicagoDayStart(now);

  const appearedAt = lead.receivedAt ?? lead.createdAt;
  const appeared = fmtAppeared(appearedAt);
  const dayColor = weekdayColor(appearedAt);

  // TVC re-sent this case after we already had it — usually a nudge that the
  // referral hasn't been worked yet. Only flag genuine re-sends, not the
  // near-simultaneous text+PDF pair the first referral often arrives as.
  const resent =
    (lead.lastReferralAt ?? 0) - appearedAt > 3600000 &&
    (lead.contactAttempts?.length ?? 0) === 0;

  // CallRail-verified phone activity — shown as a game-style HUD counter that
  // glows while there's been a call in the last 24h.
  const calls = (lead.contactAttempts ?? []).filter((a) => a.via === 'callrail');
  const lastCallTs = calls.reduce((m, a) => Math.max(m, a.ts), 0);
  const freshCall = now - lastCallTs < 86400000;

  // Motions-deadline countdown — active UNSOLD leads only (no paid_* — the
  // deadline is a sales tool), once the (derived) last day to file for a
  // continuance is inside 14 days. Red at 5 days or closed.
  const ddl = showsMotionsDeadline(lead) ? motionsDeadlineFor(lead) : null;
  const showDdl = ddl !== null && ddl.daysLeft <= 14;

  // Money on the table: they said yes on a call but payment was never taken.
  // Gold treatment — louder than anything else, because the pitch is already
  // won and only collection remains.
  const salePending = isSalePending(lead);
  const promiseDays = salePending
    ? Math.floor((now - (lead.salePromisedAt ?? lead.saleStatusAt ?? now)) / 86400000)
    : 0;

  return (
    <motion.div
      whileHover={{ y: -3 }}
      transition={{ duration: 0.12 }}
      className={`legal-pad group relative block w-full overflow-hidden rounded-lg text-left shadow-card ring-1 ring-black/10 ${
        salePending ? 'ring-2 ring-amber-500/80' : overdue ? 'ring-2 ring-pad-red/70' : ''
      } ${big ? 'min-h-[460px]' : 'min-h-[230px]'}`}
    >
      {/* Gold corner ribbon — a verbal yes with money still uncollected. */}
      {salePending && (
        <div className="pointer-events-none absolute -right-10 top-4 z-20 w-40 rotate-45">
          <div className="animate-pulse bg-gradient-to-b from-amber-300 via-amber-400 to-amber-600 py-1 text-center shadow-[0_2px_6px_rgba(0,0,0,0.4)] ring-1 ring-amber-900/40">
            <p className="font-type text-[9px] font-black uppercase leading-tight tracking-widest text-amber-950 drop-shadow-sm">
              Said Yes
            </p>
            <p className="font-type text-[8px] font-bold uppercase leading-tight tracking-wide text-amber-900/90">
              collect{lead.saleAmount ? ` $${lead.saleAmount}` : ''}
              {promiseDays > 0 ? ` · ${promiseDays}d` : ''}
            </p>
          </div>
        </div>
      )}

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
            {calls.length > 0 && (
              <span
                title={`${calls.length} call${calls.length === 1 ? '' : 's'} verified by CallRail`}
                className="inline-flex items-center gap-1.5 rounded-full border border-sky-900/30 bg-gradient-to-b from-sky-500 to-sky-700 py-0.5 pl-1 pr-2.5 shadow-md"
                style={
                  freshCall
                    ? { boxShadow: '0 0 10px 2px rgba(56,146,220,0.65)' }
                    : undefined
                }
              >
                <span className="flex h-4 w-4 items-center justify-center rounded-full bg-gradient-to-b from-amber-300 to-amber-500 shadow-inner">
                  <PhoneGlyph className="h-2.5 w-2.5 text-sky-900" />
                </span>
                <span className="font-type text-[11px] font-bold leading-none text-white drop-shadow">
                  ×{calls.length}
                </span>
              </span>
            )}
            <Badge tone={stageTone(lead.stage)}>{STAGE_LABELS[lead.stage]}</Badge>
            {lead.needsReview && <Badge tone="amber">Needs review</Badge>}
            {resent && (
              <Badge tone="red">
                Resubmitted{' '}
                {new Date(lead.lastReferralAt!).toLocaleDateString('en-US', {
                  month: 'numeric',
                  day: 'numeric',
                })}
              </Badge>
            )}
            {uncontacted && <Badge tone={ageTone}>uncontacted · {ageLabel}</Badge>}
            {showDdl && (
              <Badge tone={ddl.passed || ddl.daysLeft <= 5 ? 'red' : 'amber'}>
                {ddl.passed
                  ? 'Motions window closed'
                  : `Motions ddl ${ddl.daysLeft === 0 ? 'today' : `${ddl.daysLeft}d`}`}
              </Badge>
            )}
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

        {nextTouch && (
          <p
            className={`mt-2 data text-[11px] ${
              nextTouchOverdue ? 'font-bold text-pad-red' : 'text-pad-inkSoft/80'
            }`}
          >
            Next: {FOLLOWUP_LABELS[nextTouch.type]} ·{' '}
            {new Date(nextTouch.dueAt).toLocaleDateString('en-US', {
              month: 'short',
              day: 'numeric',
              timeZone: 'America/Chicago',
            })}
            {nextTouchOverdue ? ' — overdue' : ''}
          </p>
        )}
        {lead.contactAttempts?.length > 0 && (
          <p className={`data text-[11px] text-pad-inkSoft/70 ${nextTouch ? 'mt-0.5' : 'mt-2'}`}>
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
