import { useMemo } from 'react';
import { formatDistanceToNow } from 'date-fns';
import { useLeads } from '../store/useLeads';
import { useUI } from '../store/useUI';
import { useAuth } from '../context/AuthContext';
import type { Lead } from '../types';
import { daysUntilCourt, fmtDate } from '../lib/dates';
import { addWarrantFee, logNoContact, markLost } from '../lib/actions';
import { Badge } from '../components/ui/Badge';

type QueueKey =
  | 'day'
  | 'warrant'
  | 'week'
  | 'awaiting'
  | 'callback'
  | 'attorney'
  | 'nurture';

interface QueueDef {
  key: QueueKey;
  title: string;
  say: string; // the talk track / offer for this queue
  tone: 'neutral' | 'red' | 'amber' | 'green' | 'blue';
  urgent?: boolean;
}

// Ordered by sales urgency. `say` is what the rep should actually do/say.
const QUEUES: QueueDef[] = [
  {
    key: 'day',
    title: 'Day Before Court',
    say: 'Court is tomorrow. Last-chance pitch: we can still enter an appearance and protect their record today.',
    tone: 'red',
    urgent: true,
  },
  {
    key: 'warrant',
    title: 'Warrant Assistance',
    say: 'Court date passed — they likely have a warrant. We can resolve it (adds a $500 warrant fee on top of the retainer).',
    tone: 'red',
    urgent: true,
  },
  {
    key: 'week',
    title: 'Week Before Court',
    say: 'Free reminder of next week\u2019s date — and the offer: if they hire us we can request a continuance for them.',
    tone: 'amber',
  },
  {
    key: 'awaiting',
    title: 'Awaiting Decision',
    say: 'Pitch delivered — close them. Handle objections, restate the value (entry + motions), and ask for the card.',
    tone: 'green',
  },
  {
    key: 'callback',
    title: 'Callbacks',
    say: 'No answer / voicemail so far — re-attempt and deliver the pitch.',
    tone: 'amber',
  },
  {
    key: 'attorney',
    title: 'Attorney Calls',
    say: 'Consultation requested — confirm/prepare the attorney call.',
    tone: 'blue',
  },
  {
    key: 'nurture',
    title: 'Nurture',
    say: 'Keep them warm with periodic touches until a court date approaches.',
    tone: 'neutral',
  },
];

function classify(lead: Lead): QueueKey | null {
  switch (lead.stage) {
    case 'attorney_call':
      return 'attorney';
    case 'pitched':
      return 'awaiting';
    case 'callback':
      return 'callback';
    case 'nurture': {
      const d = daysUntilCourt(lead);
      if (d !== null && d < 0) return 'warrant';
      if (d !== null && d <= 1) return 'day';
      if (d !== null && d <= 7) return 'week';
      return 'nurture';
    }
    default:
      return null; // new / retained / lost / handed off don't belong here
  }
}

export function CommandCenter() {
  const leads = useLeads();
  const selectLead = useUI((s) => s.selectLead);
  const { user } = useAuth();
  const by = user?.displayName || user?.email || undefined;

  const grouped = useMemo(() => {
    const g: Record<QueueKey, Lead[]> = {
      day: [], warrant: [], week: [], awaiting: [], callback: [], attorney: [], nurture: [],
    };
    for (const l of leads) {
      if (l.deletedAt) continue;
      const k = classify(l);
      if (k) g[k].push(l);
    }
    const byCourt = (a: Lead, b: Lead) =>
      (daysUntilCourt(a) ?? 9999) - (daysUntilCourt(b) ?? 9999);
    (Object.keys(g) as QueueKey[]).forEach((k) => g[k].sort(byCourt));
    return g;
  }, [leads]);

  const total = QUEUES.reduce((n, q) => n + grouped[q.key].length, 0);

  return (
    <div>
      <header className="mb-6">
        <h1 className="font-hand text-4xl text-white">Sales Command Center</h1>
        <p className="text-manila/70 text-sm">
          {total} contacted {total === 1 ? 'lead' : 'leads'} to work — every
          second touch in one place
        </p>
      </header>

      {total === 0 ? (
        <div className="rounded-2xl bg-black/20 p-12 text-center ring-1 ring-white/10">
          <p className="font-hand text-3xl text-white">Pipeline's quiet.</p>
          <p className="mt-2 font-type text-sm text-manila/50">
            No contacted-but-unretained leads right now. New referrals start in
            Initial Leads on The Desk.
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
          {QUEUES.map((q) => (
            <Queue
              key={q.key}
              def={q}
              leads={grouped[q.key]}
              by={by}
              onOpen={(id) => selectLead(id, 'contact')}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function Queue({
  def,
  leads,
  by,
  onOpen,
}: {
  def: QueueDef;
  leads: Lead[];
  by?: string;
  onOpen: (id: string) => void;
}) {
  return (
    <section className="rounded-2xl bg-black/20 p-4 ring-1 ring-white/10">
      <div className="mb-2 flex items-start justify-between gap-3">
        <div>
          <h2 className="font-hand text-2xl text-white">{def.title}</h2>
          <p className="mt-0.5 font-type text-xs leading-snug text-manila/60">{def.say}</p>
        </div>
        <Badge tone={def.tone} pulse={def.urgent && leads.length > 0}>
          {leads.length}
        </Badge>
      </div>
      {leads.length === 0 ? (
        <p className="py-5 text-center font-type text-xs text-manila/40">Empty</p>
      ) : (
        <ul className="space-y-2">
          {leads.map((l) => (
            <Row key={l.id} lead={l} queue={def.key} by={by} onOpen={() => onOpen(l.id)} />
          ))}
        </ul>
      )}
    </section>
  );
}

function Row({
  lead,
  queue,
  by,
  onOpen,
}: {
  lead: Lead;
  queue: QueueKey;
  by?: string;
  onOpen: () => void;
}) {
  const days = daysUntilCourt(lead);
  const courtTone = days !== null && days < 0 ? 'red' : days !== null && days <= 7 ? 'amber' : 'neutral';
  const attempts = lead.contactAttempts?.length ?? 0;
  const last = attempts ? lead.contactAttempts[attempts - 1] : null;
  const tel = lead.phone ? `tel:${lead.phone.replace(/[^\d+]/g, '')}` : null;

  return (
    <li className="rounded-lg bg-manila/95 px-3 py-2">
      <div className="flex items-start justify-between gap-3">
        <button className="min-w-0 flex-1 text-left" onClick={onOpen}>
          <p className="truncate font-type text-sm font-semibold text-pad-ink">{lead.name}</p>
          <p className="truncate font-type text-xs text-pad-inkSoft">
            {lead.phone || 'no phone'} · {lead.courtName || 'court n/a'} · {fmtDate(lead.nextCourtDate)}
          </p>
          <p className="mt-0.5 font-type text-[11px] text-pad-inkSoft/70">
            {attempts} attempt{attempts === 1 ? '' : 's'}
            {last ? ` · last ${formatDistanceToNow(last.ts, { addSuffix: true })}` : ''}
          </p>
        </button>
        <Badge tone={courtTone}>
          {days === null ? 'no date' : days < 0 ? `${Math.abs(days)}d ago` : `${days}d`}
        </Badge>
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        {tel && (
          <a href={tel} className="quick-chip" onClick={(e) => e.stopPropagation()} title={`Call ${lead.phone}`}>
            📞 Call
          </a>
        )}
        <Chip onClick={() => logNoContact(lead, 'no_answer', by)}>No answer</Chip>
        <Chip onClick={() => logNoContact(lead, 'voicemail', by)}>Voicemail</Chip>
        {queue === 'warrant' && !lead.hasWarrant && (
          <button
            className="rounded bg-pad-red px-2 py-1 font-type text-[11px] font-semibold text-white hover:opacity-90"
            onClick={() => addWarrantFee(lead, 500)}
            title="Add $500 warrant fee"
          >
            +$500 warrant
          </button>
        )}
        <button
          className="rounded bg-emerald-600 px-2 py-1 font-type text-[11px] font-semibold text-white hover:bg-emerald-500"
          onClick={onOpen}
          title="They picked up — log the result / retain"
        >
          Reached →
        </button>
        {(queue === 'nurture' || queue === 'warrant') && (
          <Chip onClick={() => markLost(lead, by)} danger>
            Lost
          </Chip>
        )}
      </div>
    </li>
  );
}

function Chip({
  children,
  onClick,
  danger,
}: {
  children: React.ReactNode;
  onClick: () => void;
  danger?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      className={`rounded px-2 py-1 font-type text-[11px] font-semibold transition ${
        danger
          ? 'bg-pad-red/10 text-pad-red hover:bg-pad-red/20'
          : 'bg-black/10 text-pad-ink hover:bg-black/20'
      }`}
    >
      {children}
    </button>
  );
}
