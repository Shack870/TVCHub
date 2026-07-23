import { useMemo, useState } from 'react';
import { motion } from 'framer-motion';
import {
  addMonths,
  eachDayOfInterval,
  endOfMonth,
  endOfWeek,
  format,
  isSameDay,
  isSameMonth,
  isToday,
  parseISO,
  startOfMonth,
  startOfWeek,
} from 'date-fns';
import { useLeads } from '../store/useLeads';
import { fmtShort } from '../lib/dates';
import { useUI } from '../store/useUI';
import type { FollowUpType, Lead } from '../types';
import { completeFollowUp } from '../lib/actions';
import { showsMotionsDeadline } from '../lib/leadFlow';
import { motionsDeadlineFor } from '../lib/motionsDeadline';
import { ConfirmDialog } from '../components/ui/ConfirmDialog';
import { Modal } from '../components/ui/Modal';

interface CalEvent {
  leadId: string;
  leadName: string;
  date: Date;
  kind: 'followup' | 'court' | 'motions';
  type?: FollowUpType;
  note?: string;
  followUpId?: string;
}

const FOLLOWUP_LABEL: Record<FollowUpType, string> = {
  callback: 'Call back',
  nurture: 'Nurture',
  chase: 'Chase call',
  week_before: 'Week before court',
  day_before: 'Day before court',
  motions: 'Motions-deadline heads-up',
  warrant: 'Warrant',
  attorney: 'Attorney call',
  billing: 'Collect payment',
};

function leadEvents(lead: Lead): CalEvent[] {
  const out: CalEvent[] = [];
  for (const f of lead.followUps ?? []) {
    if (f.done) continue;
    out.push({
      leadId: lead.id,
      leadName: lead.name,
      date: new Date(f.dueAt),
      kind: 'followup',
      type: f.type,
      note: f.note,
      followUpId: f.id,
    });
  }
  // Court dates for still-active cases (not dismissed / handed off / written off).
  if (
    lead.nextCourtDate &&
    !lead.caseDismissed &&
    lead.stage !== 'intake_complete' &&
    lead.stage !== 'lost'
  ) {
    const d = parseISO(lead.nextCourtDate);
    if (!isNaN(d.getTime())) {
      out.push({ leadId: lead.id, leadName: lead.name, date: d, kind: 'court' });
      // The derived motions-filing deadline rides along as its own event —
      // visually distinct from the court appearance (blue ink, not red).
      // Unsold leads only: the deadline is a sales tool, so retained (incl.
      // financed / paid_*) files keep their court event but get no ddl event.
      const ddl = showsMotionsDeadline(lead) ? motionsDeadlineFor(lead) : null;
      if (ddl) {
        out.push({
          leadId: lead.id,
          leadName: lead.name,
          date: parseISO(ddl.date),
          kind: 'motions',
          note: ddl.rule === 'MO-5biz' ? 'MO 5-business-day rule' : undefined,
        });
      }
    }
  }
  return out;
}

export function CalendarView() {
  const leads = useLeads();
  const selectLead = useUI((s) => s.selectLead);
  const [cursor, setCursor] = useState(new Date());
  const [selected, setSelected] = useState(new Date());
  const [confirmClear, setConfirmClear] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [dayCard, setDayCard] = useState<Date | null>(null);

  const events = useMemo(() => leads.flatMap(leadEvents), [leads]);

  const byDay = useMemo(() => {
    const m = new Map<string, CalEvent[]>();
    for (const e of events) {
      const k = format(e.date, 'yyyy-MM-dd');
      if (!m.has(k)) m.set(k, []);
      m.get(k)!.push(e);
    }
    return m;
  }, [events]);

  const days = useMemo(
    () =>
      eachDayOfInterval({
        start: startOfWeek(startOfMonth(cursor)),
        end: endOfWeek(endOfMonth(cursor)),
      }),
    [cursor],
  );

  const todayKey = format(new Date(), 'yyyy-MM-dd');
  const overdue = useMemo(
    () =>
      events
        .filter((e) => e.kind === 'followup' && format(e.date, 'yyyy-MM-dd') < todayKey)
        .sort((a, b) => a.date.getTime() - b.date.getTime()),
    [events, todayKey],
  );
  const todays = byDay.get(todayKey)?.filter((e) => e.kind === 'followup') ?? [];

  const selectedKey = format(selected, 'yyyy-MM-dd');
  const kindOrder = { followup: 0, motions: 1, court: 2 } as const;
  const selectedEvents = (byDay.get(selectedKey) ?? []).sort(
    (a, b) => kindOrder[a.kind] - kindOrder[b.kind],
  );

  // Marks every item currently shown in the Overdue panel done, via the same
  // completeFollowUp mutation as each row's individual "Done" button.
  const clearAllOverdue = async () => {
    if (clearing) return;
    setClearing(true);
    try {
      for (const e of overdue) {
        const lead = leads.find((l) => l.id === e.leadId);
        if (lead && e.followUpId) await completeFollowUp(lead, e.followUpId);
      }
    } finally {
      setClearing(false);
    }
  };

  return (
    <div>
      <header className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="font-hand text-4xl text-white">Follow-Up Calendar</h1>
          <p className="text-manila/70 text-sm">
            Who to follow up with today and what's ahead
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button className="btn-ghost text-manila" onClick={() => setCursor(addMonths(cursor, -1))}>
            ‹
          </button>
          <span className="min-w-[140px] text-center font-hand text-2xl text-white">
            {format(cursor, 'MMMM yyyy')}
          </span>
          <button className="btn-ghost text-manila" onClick={() => setCursor(addMonths(cursor, 1))}>
            ›
          </button>
          <button
            className="btn-ghost text-manila"
            onClick={() => {
              setCursor(new Date());
              setSelected(new Date());
            }}
          >
            Today
          </button>
        </div>
      </header>

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-[1fr_320px]">
        {/* Month grid */}
        <div className="overflow-hidden rounded-2xl bg-manila/95 p-3 shadow-card">
          <div className="grid grid-cols-7 text-center font-type text-[11px] uppercase tracking-wide text-pad-inkSoft/70">
            {['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((d) => (
              <div key={d} className="py-1">{d}</div>
            ))}
          </div>
          <div className="grid grid-cols-7 gap-1">
            {days.map((day) => {
              const k = format(day, 'yyyy-MM-dd');
              const evs = byDay.get(k) ?? [];
              const dim = !isSameMonth(day, cursor);
              const sel = isSameDay(day, selected);
              return (
                <div
                  key={k}
                  onClick={() => {
                    setSelected(day);
                    setDayCard(day);
                  }}
                  className={`flex min-h-[82px] cursor-pointer flex-col rounded-md border p-1 text-left transition ${
                    sel ? 'border-pad-ink ring-1 ring-pad-ink' : 'border-black/5'
                  } ${dim ? 'bg-black/[0.02] opacity-50' : 'bg-white/60 hover:bg-white'}`}
                >
                  <span
                    className={`mb-0.5 inline-flex h-5 w-5 items-center justify-center rounded-full font-type text-xs ${
                      isToday(day) ? 'bg-pad-red font-bold text-white' : 'text-pad-ink'
                    }`}
                  >
                    {format(day, 'd')}
                  </span>
                  <div className="space-y-0.5 overflow-hidden">
                    {evs.slice(0, 3).map((e, i) => (
                      <button
                        key={i}
                        onClick={(ev) => {
                          ev.stopPropagation();
                          selectLead(e.leadId);
                        }}
                        title={`Open ${e.leadName}`}
                        className={`block w-full truncate rounded px-1 py-0.5 text-left font-type text-[10px] transition hover:brightness-95 ${
                          e.kind === 'court'
                            ? 'bg-pad-red/15 text-pad-red'
                            : e.kind === 'motions'
                              ? 'bg-sky-700/10 italic text-sky-800'
                              : 'bg-amber-500/20 text-amber-800'
                        }`}
                      >
                        {e.kind === 'court'
                          ? `⚖ ${e.leadName.split(' ')[0]}`
                          : e.kind === 'motions'
                            ? `MOTIONS DDL — ${e.leadName.split(' ')[0]}`
                            : e.leadName.split(' ')[0]}
                      </button>
                    ))}
                    {evs.length > 3 && (
                      <button
                        onClick={(ev) => {
                          ev.stopPropagation();
                          setSelected(day);
                          setDayCard(day);
                        }}
                        className="font-type text-[10px] text-pad-inkSoft/60 hover:underline"
                      >
                        +{evs.length - 3} more
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
          <div className="mt-2 flex gap-4 px-1 font-type text-[11px] text-pad-inkSoft">
            <span className="flex items-center gap-1">
              <span className="h-2.5 w-2.5 rounded-sm bg-amber-500/40" /> Follow-up
            </span>
            <span className="flex items-center gap-1">
              <span className="h-2.5 w-2.5 rounded-sm bg-pad-red/40" /> Court date
            </span>
            <span className="flex items-center gap-1">
              <span className="h-2.5 w-2.5 rounded-sm bg-sky-700/40" /> Motions deadline
            </span>
          </div>
        </div>

        {/* Side panel: overdue/today + selected day */}
        <div className="space-y-4">
          {overdue.length > 0 && (
            <Panel
              title={`Overdue (${overdue.length})`}
              tone="red"
              action={
                <button
                  type="button"
                  disabled={clearing}
                  onClick={() => setConfirmClear(true)}
                  className="rounded-md border border-manila/25 px-3 py-1.5 font-type text-[10px] font-bold uppercase tracking-widest text-manila/60 transition hover:bg-black/15 hover:text-manila disabled:opacity-50"
                >
                  {clearing ? 'Clearing…' : 'Clear All'}
                </button>
              }
            >
              {overdue.map((e, i) => (
                <EventRow key={i} e={e} onOpen={() => selectLead(e.leadId)} leads={leads} />
              ))}
            </Panel>
          )}
          <Panel title="Today" tone="green">
            {todays.length === 0 ? (
              <Empty>No follow-ups due today.</Empty>
            ) : (
              todays.map((e, i) => (
                <EventRow key={i} e={e} onOpen={() => selectLead(e.leadId)} leads={leads} />
              ))
            )}
          </Panel>
          <Panel title={format(selected, 'EEEE, MMM d')}>
            {selectedEvents.length === 0 ? (
              <Empty>Nothing scheduled.</Empty>
            ) : (
              selectedEvents.map((e, i) => (
                <EventRow key={i} e={e} onOpen={() => selectLead(e.leadId)} leads={leads} />
              ))
            )}
          </Panel>
        </div>
      </div>

      <DayCardModal
        date={dayCard}
        leads={leads}
        onClose={() => setDayCard(null)}
        onOpenLead={(id) => {
          setDayCard(null);
          selectLead(id);
        }}
      />

      <ConfirmDialog
        open={confirmClear}
        title="Clear all overdue?"
        message={`Mark all ${overdue.length} overdue follow-up${overdue.length === 1 ? '' : 's'} as done. Each lead's cadence will schedule its next touch as usual.`}
        confirmLabel={`Clear ${overdue.length}`}
        cancelLabel="Cancel"
        tone="danger"
        onClose={() => setConfirmClear(false)}
        onConfirm={() => void clearAllOverdue()}
      />
    </div>
  );
}

function Panel({
  title,
  tone = 'neutral',
  action,
  children,
}: {
  title: string;
  tone?: 'neutral' | 'red' | 'green';
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  const ring =
    tone === 'red' ? 'ring-pad-red/40' : tone === 'green' ? 'ring-emerald-600/30' : 'ring-white/10';
  return (
    <div className={`rounded-2xl bg-black/20 p-3 ring-1 ${ring}`}>
      <div className="mb-2 flex items-center justify-between gap-2">
        <h2 className="font-hand text-xl text-white">{title}</h2>
        {action}
      </div>
      <div className="space-y-2">{children}</div>
    </div>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <p className="font-type text-xs text-manila/50">{children}</p>;
}

// The tear-off day card: clicking a day in the month grid rips that page off
// the desk calendar and drops it on the screen — court dates in red ink,
// follow-ups as handwritten lines, handled ones struck through at the bottom.
function DayCardModal({
  date,
  leads,
  onClose,
  onOpenLead,
}: {
  date: Date | null;
  leads: Lead[];
  onClose: () => void;
  onOpenLead: (leadId: string) => void;
}) {
  // While closed/exiting the Modal's AnimatePresence shows a frozen snapshot
  // of the last open render, so this fallback value is never actually seen.
  const shown = date ?? new Date();

  const key = format(shown, 'yyyy-MM-dd');
  const todayKey = format(new Date(), 'yyyy-MM-dd');
  const isPast = key < todayKey;

  // Same universe the month grid draws from (active court dates + open
  // follow-ups), plus the day's already-handled follow-ups so the page reads
  // like a real day sheet — done lines get struck through, not erased.
  const { courts, motions, open, handled } = useMemo(() => {
    const courts: Lead[] = [];
    const motions: { lead: Lead; rule: string }[] = [];
    const open: { lead: Lead; f: NonNullable<Lead['followUps']>[number] }[] = [];
    const handled: typeof open = [];
    for (const lead of leads) {
      const activeCase =
        !lead.caseDismissed &&
        lead.stage !== 'intake_complete' &&
        lead.stage !== 'lost';
      if (lead.nextCourtDate === key && activeCase) {
        courts.push(lead);
      }
      // Derived motions-filing deadlines land on their own line of the day
      // sheet — kept OUT of the docket count so they never read as a court
      // appearance. Unsold leads only (same scoping as the grid events).
      if (activeCase && showsMotionsDeadline(lead)) {
        const ddl = motionsDeadlineFor(lead);
        if (ddl?.date === key) motions.push({ lead, rule: ddl.rule });
      }
      for (const f of lead.followUps ?? []) {
        if (format(new Date(f.dueAt), 'yyyy-MM-dd') !== key) continue;
        (f.done ? handled : open).push({ lead, f });
      }
    }
    open.sort((a, b) => a.f.dueAt - b.f.dueAt);
    handled.sort((a, b) => a.f.dueAt - b.f.dueAt);
    return { courts, motions, open, handled };
  }, [leads, key]);

  const paper = 'linear-gradient(180deg, #fdf6cf 0%, #f7edb9 100%)';
  const docket = courts.length + open.length;

  return (
    <Modal open={date !== null} onClose={onClose} width="max-w-md">
      <div style={{ perspective: '1200px' }}>
        <motion.div
          role="dialog"
          aria-modal="true"
          aria-label={`Schedule for ${format(shown, 'EEEE, MMMM d, yyyy')}`}
          initial={{ rotateX: -75, opacity: 0 }}
          animate={{ rotateX: 0, opacity: 1 }}
          transition={{ type: 'spring', stiffness: 210, damping: 20 }}
          style={{ transformOrigin: 'top center' }}
          className="-rotate-1"
        >
          {/* torn top edge — this page was ripped off the desk calendar */}
          <div
            aria-hidden
            className="h-[12px] w-full"
            style={{
              background:
                'linear-gradient(-45deg, transparent 8px, #fdf6cf 0), linear-gradient(45deg, transparent 8px, #fdf6cf 0)',
              backgroundPosition: 'left top',
              backgroundRepeat: 'repeat-x',
              backgroundSize: '16px 16px',
            }}
          />
          <div
            className="rounded-b-md px-5 pb-5 shadow-card"
            style={{ background: paper }}
          >
            {/* date block, like the corner of a page-a-day calendar */}
            <div className="flex items-start justify-between gap-3 border-b-2 border-pad-ink/15 pb-3 pt-2">
              <div>
                <p className="font-type text-[10px] font-bold uppercase tracking-widest text-pad-inkSoft/70">
                  {format(shown, 'EEEE')}
                </p>
                <p className="font-type text-6xl leading-none text-pad-ink">
                  {format(shown, 'd')}
                </p>
                <p className="mt-1 font-type text-[10px] font-bold uppercase tracking-widest text-pad-inkSoft/70">
                  {format(shown, 'MMMM yyyy')}
                </p>
              </div>
              <div className="flex items-center gap-2 pt-1">
                <span className="font-type text-[10px] uppercase tracking-widest text-pad-inkSoft/60">
                  {docket === 0 ? 'clear' : `${docket} on the docket`}
                </span>
                <button
                  type="button"
                  autoFocus
                  aria-label="Close day view"
                  onClick={onClose}
                  className="flex h-8 w-8 items-center justify-center rounded-full bg-black/10 font-type text-sm font-bold text-pad-ink transition hover:bg-black/20"
                >
                  ✕
                </button>
              </div>
            </div>

            {docket === 0 && motions.length === 0 && handled.length === 0 ? (
              <p className="-rotate-2 py-8 text-center font-hand text-2xl text-pad-ink/50">
                Nothing on the docket — enjoy the quiet day.
              </p>
            ) : (
              <div className="divide-y divide-black/10">
                {courts.map((lead) => {
                  const prep = (lead.followUps ?? [])
                    .filter((f) => !f.done && (f.type === 'week_before' || f.type === 'day_before'))
                    .map((f) => FOLLOWUP_LABEL[f.type].toLowerCase());
                  const meta = [
                    lead.nextCourtTime,
                    lead.nextCourtType,
                    lead.courtName || (lead.county ? `${lead.county} County` : null),
                  ].filter(Boolean);
                  return (
                    <button
                      key={`court-${lead.id}`}
                      type="button"
                      onClick={() => onOpenLead(lead.id)}
                      className="block w-full py-2.5 text-left transition hover:bg-black/5"
                    >
                      <p className="font-hand text-2xl leading-tight text-pad-red">
                        ⚖ {lead.name} — court
                      </p>
                      {meta.length > 0 && (
                        <p className="font-type text-[11px] text-pad-inkSoft">
                          {meta.join(' · ')}
                        </p>
                      )}
                      {prep.length > 0 && (
                        <p className="font-type text-[10px] text-pad-inkSoft/60">
                          prep reminders pending: {prep.join(', ')}
                        </p>
                      )}
                    </button>
                  );
                })}

                {motions.length > 0 && (
                  <div className="py-2.5">
                    <p className="font-type text-[10px] font-bold uppercase tracking-widest text-sky-800/70">
                      Motions deadlines — last day to file
                    </p>
                    {motions.map(({ lead, rule }) => (
                      <button
                        key={`ddl-${lead.id}`}
                        type="button"
                        onClick={() => onOpenLead(lead.id)}
                        className="block w-full py-1 text-left transition hover:bg-black/5"
                      >
                        <p className="truncate font-hand text-xl leading-tight text-sky-800">
                          ✎ {lead.name} — motions ddl
                        </p>
                        <p className="font-type text-[10px] text-pad-inkSoft/60">
                          court {fmtShort(lead.nextCourtDate)}
                          {rule === 'MO-5biz' ? ' · MO 5-business-day rule' : ''}
                        </p>
                      </button>
                    ))}
                  </div>
                )}

                {open.map(({ lead, f }) => (
                  <div key={`fu-${lead.id}-${f.id}`} className="flex items-center gap-2 py-2.5">
                    <button
                      type="button"
                      onClick={() => onOpenLead(lead.id)}
                      className="min-w-0 flex-1 rounded text-left transition hover:bg-black/5"
                    >
                      <p
                        className={`truncate font-hand text-2xl leading-tight ${
                          isPast ? 'text-pad-red' : 'text-pad-ink'
                        }`}
                      >
                        {lead.name}
                      </p>
                      <p className="truncate font-type text-[11px] text-pad-inkSoft">
                        {FOLLOWUP_LABEL[f.type]}
                        {f.note ? ' · ' + f.note : ''}
                      </p>
                    </button>
                    {isPast && (
                      <span className="stamp shrink-0 -rotate-6 text-[9px] text-pad-red">
                        Overdue
                      </span>
                    )}
                    <button
                      type="button"
                      className="shrink-0 rounded bg-emerald-600 px-2 py-1 font-type text-xs font-semibold text-white transition hover:bg-emerald-500"
                      onClick={() => completeFollowUp(lead, f.id)}
                    >
                      Done
                    </button>
                  </div>
                ))}

                {handled.length > 0 && (
                  <div className="pt-2.5">
                    <p className="font-type text-[10px] font-bold uppercase tracking-widest text-pad-inkSoft/50">
                      Handled
                    </p>
                    {handled.map(({ lead, f }) => (
                      <button
                        key={`done-${lead.id}-${f.id}`}
                        type="button"
                        onClick={() => onOpenLead(lead.id)}
                        className="block w-full truncate text-left font-hand text-lg leading-snug text-pad-ink/40 line-through transition hover:text-pad-ink/60"
                      >
                        ✓ {lead.name} — {FOLLOWUP_LABEL[f.type]}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        </motion.div>
      </div>
    </Modal>
  );
}

function EventRow({
  e,
  onOpen,
  leads,
}: {
  e: CalEvent;
  onOpen: () => void;
  leads: Lead[];
}) {
  const lead = leads.find((l) => l.id === e.leadId);
  return (
    <div className="flex items-center justify-between gap-2 rounded-lg bg-manila/95 px-3 py-2">
      <button className="min-w-0 flex-1 text-left" onClick={onOpen}>
        <p className="truncate font-type text-sm font-semibold text-pad-ink">
          {e.leadName}
        </p>
        <p className="truncate font-type text-xs text-pad-inkSoft">
          {e.kind === 'court'
            ? `Court date${lead?.nextCourtType ? ' · ' + lead.nextCourtType : ''}`
            : e.kind === 'motions'
              ? `Motions filing deadline${e.note ? ' · ' + e.note : ''}`
              : `${FOLLOWUP_LABEL[e.type!]}${e.note ? ' · ' + e.note : ''}`}
        </p>
      </button>
      {e.kind === 'followup' && lead && e.followUpId && (
        <button
          className="shrink-0 rounded bg-emerald-600 px-2 py-1 text-xs font-semibold text-white"
          onClick={() => completeFollowUp(lead, e.followUpId!)}
        >
          Done
        </button>
      )}
    </div>
  );
}
