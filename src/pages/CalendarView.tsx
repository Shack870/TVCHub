import { useMemo, useState } from 'react';
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
import { useUI } from '../store/useUI';
import type { FollowUpType, Lead } from '../types';
import { completeFollowUp } from '../lib/actions';

interface CalEvent {
  leadId: string;
  leadName: string;
  date: Date;
  kind: 'followup' | 'court';
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
    }
  }
  return out;
}

export function CalendarView() {
  const leads = useLeads();
  const selectLead = useUI((s) => s.selectLead);
  const [cursor, setCursor] = useState(new Date());
  const [selected, setSelected] = useState(new Date());

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
  const selectedEvents = (byDay.get(selectedKey) ?? []).sort(
    (a, b) => (a.kind === b.kind ? 0 : a.kind === 'court' ? 1 : -1),
  );

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
                  onClick={() => setSelected(day)}
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
                            : 'bg-amber-500/20 text-amber-800'
                        }`}
                      >
                        {e.kind === 'court' ? '⚖ ' : ''}
                        {e.leadName.split(' ')[0]}
                      </button>
                    ))}
                    {evs.length > 3 && (
                      <button
                        onClick={(ev) => {
                          ev.stopPropagation();
                          setSelected(day);
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
          </div>
        </div>

        {/* Side panel: overdue/today + selected day */}
        <div className="space-y-4">
          {overdue.length > 0 && (
            <Panel title={`Overdue (${overdue.length})`} tone="red">
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
    </div>
  );
}

function Panel({
  title,
  tone = 'neutral',
  children,
}: {
  title: string;
  tone?: 'neutral' | 'red' | 'green';
  children: React.ReactNode;
}) {
  const ring =
    tone === 'red' ? 'ring-pad-red/40' : tone === 'green' ? 'ring-emerald-600/30' : 'ring-white/10';
  return (
    <div className={`rounded-2xl bg-black/20 p-3 ring-1 ${ring}`}>
      <h2 className="mb-2 font-hand text-xl text-white">{title}</h2>
      <div className="space-y-2">{children}</div>
    </div>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <p className="font-type text-xs text-manila/50">{children}</p>;
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
