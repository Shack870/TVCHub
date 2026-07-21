import { useMemo, useState } from 'react';
import { useLeads } from '../store/useLeads';
import { useUI } from '../store/useUI';
import type { FollowUp, Lead } from '../types';
import { balanceOf, isActiveLead, isFinancingClient, isSalePending } from '../lib/leadFlow';
import { DAY } from '../lib/followups';
import { courtDatePassed, fmtMoney, paymentPastDue } from '../lib/dates';
import { completeFollowUp } from '../lib/actions';
import { Badge } from '../components/ui/Badge';

const FOLLOWUP_LABELS: Record<FollowUp['type'], string> = {
  callback: 'Call back',
  nurture: 'Nurture check-in',
  week_before: 'Week-before-court call',
  day_before: 'Day-before-court call',
  warrant: 'Warrant follow-up',
  attorney: 'Attorney call',
  billing: 'Collect promised payment',
};

interface Task {
  lead: Lead;
  why: string;
  followUpId?: string;
}

function agingLabel(ms: number): string {
  const h = ms / 3600000;
  if (h < 1) return `${Math.max(1, Math.round(ms / 60000))}m`;
  if (h < 48) return `${Math.round(h)}h`;
  return `${Math.round(h / 24)}d`;
}

export function TodayView({ embedded = false }: { embedded?: boolean }) {
  const leads = useLeads();
  const selectLead = useUI((s) => s.selectLead);
  const openNewLead = useUI((s) => s.openNewLead);
  const [now] = useState(() => Date.now());

  const todayStart = useMemo(() => {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  }, []);
  const todayEnd = todayStart + DAY;

  // Each lead lands in exactly ONE bucket — its single most-urgent action —
  // so nobody is shown (or counted) more than once. Buckets are ordered by
  // urgency; the first match wins.
  const buckets = useMemo(() => {
    const moneyOnTable: Task[] = [];
    const courtPassed: Task[] = [];
    const collections: Task[] = [];
    const overdue: Task[] = [];
    const dueToday: Task[] = [];
    const uncontacted: Task[] = [];
    const stalled: Task[] = [];

    const labelFor = (f: FollowUp) =>
      `${FOLLOWUP_LABELS[f.type]}${f.note ? ` · ${f.note}` : ''}`;

    for (const l of leads) {
      const active = isActiveLead(l);

      // 0. Money on the table — said yes on a call, payment never collected.
      //    The pitch is already won; these calls come before everything else.
      if (isSalePending(l)) {
        const promisedAt = l.salePromisedAt ?? l.saleStatusAt ?? null;
        const since = promisedAt ? agingLabel(now - promisedAt) : null;
        const bits = [
          l.saleAmount ? `${fmtMoney(l.saleAmount)} promised` : 'Payment promised',
          since ? `${since} ago` : null,
          l.nextCourtDate ? `court ${l.nextCourtDate}` : null,
        ].filter(Boolean);
        moneyOnTable.push({ lead: l, why: `Said yes — ${bits.join(' · ')}` });
        continue;
      }
      // 1. Court date passed (live or retained/financed case) — must be resolved.
      if (
        (active || l.stage === 'retained' || l.stage === 'financed') &&
        !l.caseDismissed &&
        courtDatePassed(l)
      ) {
        courtPassed.push({ lead: l, why: 'Court date has passed — set a new date or mark dismissed' });
        continue;
      }
      // 2. Money owed and past due (clients / warrant cases).
      if (isFinancingClient(l) && paymentPastDue(l)) {
        collections.push({ lead: l, why: `Payment past due · ${fmtMoney(balanceOf(l))} balance` });
        continue;
      }
      // The rest only apply to leads still being worked.
      if (!active) continue;

      const pending = (l.followUps ?? []).filter((f) => !f.done).sort((a, b) => a.dueAt - b.dueAt);
      const od = pending.find((f) => f.dueAt < todayStart);
      const td = pending.find((f) => f.dueAt >= todayStart && f.dueAt < todayEnd);

      // 3. Overdue follow-up.
      if (od) {
        overdue.push({ lead: l, why: `Overdue ${agingLabel(now - od.dueAt)} — ${labelFor(od)}`, followUpId: od.id });
        continue;
      }
      // 4. Follow-up due today.
      if (td) {
        dueToday.push({ lead: l, why: `Due today — ${labelFor(td)}`, followUpId: td.id });
        continue;
      }
      // 5. New initial lead — never contacted.
      if ((l.contactAttempts?.length ?? 0) === 0) {
        uncontacted.push({ lead: l, why: `New initial lead — uncontacted ${agingLabel(now - (l.receivedAt ?? l.createdAt))}` });
        continue;
      }
      // 6. Contacted but nothing scheduled — slipped through the cracks.
      if (pending.length === 0) {
        stalled.push({ lead: l, why: 'No next step scheduled — decide or set a follow-up' });
        continue;
      }
      // Otherwise: contacted with a follow-up scheduled for a future day — nothing due now.
    }

    // Oldest promise first — that money has been waiting the longest.
    moneyOnTable.sort(
      (a, b) =>
        (a.lead.salePromisedAt ?? a.lead.saleStatusAt ?? 0) -
        (b.lead.salePromisedAt ?? b.lead.saleStatusAt ?? 0),
    );
    collections.sort((a, b) => balanceOf(b.lead) - balanceOf(a.lead));
    uncontacted.sort(
      (a, b) => (a.lead.receivedAt ?? a.lead.createdAt) - (b.lead.receivedAt ?? b.lead.createdAt),
    );

    return { moneyOnTable, courtPassed, collections, overdue, dueToday, uncontacted, stalled };
  }, [leads, now, todayStart, todayEnd]);

  const promisedTotal = buckets.moneyOnTable.reduce(
    (s, t) => s + (t.lead.saleAmount ?? 0),
    0,
  );

  const total =
    buckets.moneyOnTable.length +
    buckets.courtPassed.length +
    buckets.collections.length +
    buckets.overdue.length +
    buckets.dueToday.length +
    buckets.uncontacted.length +
    buckets.stalled.length;

  const summary =
    total === 0
      ? 'All clear — nothing needs you right now.'
      : `${total} thing${total === 1 ? '' : 's'} need you`;

  return (
    <div>
      {embedded ? (
        <p className="mb-4 text-manila/70 text-sm">{summary}</p>
      ) : (
        <header className="mb-6 flex flex-wrap items-end justify-between gap-4">
          <div>
            <h1 className="font-hand text-4xl text-white">Today</h1>
            <p className="text-manila/70 text-sm">{summary}</p>
          </div>
          <button className="btn-primary" onClick={openNewLead}>
            + New Lead
          </button>
        </header>
      )}

      {total === 0 ? (
        <div className="rounded-2xl bg-black/20 p-12 text-center ring-1 ring-white/10">
          <p className="font-hand text-3xl text-white">Desk's clean. 🎯</p>
          <p className="mt-2 font-type text-sm text-manila/50">
            No uncontacted leads, no follow-ups due, no past-due accounts.
          </p>
        </div>
      ) : (
        <div className="space-y-5">
          <MoneyOnTableSection
            tasks={buckets.moneyOnTable}
            promisedTotal={promisedTotal}
            onOpen={selectLead}
          />
          <Section title="Court date passed" subtitle="Set a new date or mark the case dismissed" tone="red" tasks={buckets.courtPassed} onOpen={selectLead} />
          <Section title="Payment past due" subtitle="Clients behind on a payment plan" tone="red" tasks={buckets.collections} onOpen={selectLead} />
          <Section title="Overdue follow-ups" subtitle="Past their date — do these first" tone="red" tasks={buckets.overdue} onOpen={selectLead} />
          <Section title="Due today" subtitle="Follow-ups scheduled for today" tone="amber" tasks={buckets.dueToday} onOpen={selectLead} />
          <Section title="New initial leads" subtitle="Uncontacted — speed to first call wins" tone="blue" tasks={buckets.uncontacted} onOpen={selectLead} />
          <Section title="Stalled" subtitle="Contacted but no next step scheduled" tone="neutral" tasks={buckets.stalled} onOpen={selectLead} />
        </div>
      )}
    </div>
  );
}

// The gold section: verbal yeses whose money was never collected. Rendered
// with its own treatment (not the generic Section) so the promised total and
// the "already sold" framing stand apart from ordinary follow-up work.
function MoneyOnTableSection({
  tasks,
  promisedTotal,
  onOpen,
}: {
  tasks: Task[];
  promisedTotal: number;
  onOpen: (id: string) => void;
}) {
  if (tasks.length === 0) return null;
  return (
    <section className="rounded-2xl bg-gradient-to-r from-amber-500/15 via-amber-400/10 to-amber-500/15 p-4 ring-2 ring-amber-400/50">
      <div className="mb-3 flex items-center justify-between">
        <div>
          <h2 className="font-hand text-2xl text-amber-300">Money on the Table</h2>
          <p className="text-manila/60 text-xs">
            They already said yes — collect before it cools off
          </p>
        </div>
        <div className="flex items-center gap-2">
          {promisedTotal > 0 && (
            <span className="rounded-full bg-gradient-to-b from-amber-300 to-amber-500 px-3 py-1 font-type text-sm font-black text-amber-950 shadow">
              {fmtMoney(promisedTotal)} promised
            </span>
          )}
          <Badge tone="amber" pulse>
            {tasks.length}
          </Badge>
        </div>
      </div>
      <ul className="space-y-2">
        {tasks.map((t) => (
          <Row key={t.lead.id} task={t} onOpen={onOpen} />
        ))}
      </ul>
    </section>
  );
}

function Section({
  title,
  subtitle,
  tone,
  tasks,
  onOpen,
}: {
  title: string;
  subtitle: string;
  tone: 'neutral' | 'red' | 'amber' | 'green' | 'blue';
  tasks: Task[];
  onOpen: (id: string) => void;
}) {
  if (tasks.length === 0) return null;
  return (
    <section className="rounded-2xl bg-black/20 p-4 ring-1 ring-white/10">
      <div className="mb-3 flex items-center justify-between">
        <div>
          <h2 className="font-hand text-2xl text-white">{title}</h2>
          <p className="text-manila/60 text-xs">{subtitle}</p>
        </div>
        <Badge tone={tone} pulse={tone === 'red'}>
          {tasks.length}
        </Badge>
      </div>
      <ul className="space-y-2">
        {tasks.map((t, i) => (
          <Row key={t.lead.id + ':' + (t.followUpId ?? i)} task={t} onOpen={onOpen} />
        ))}
      </ul>
    </section>
  );
}

function Row({
  task,
  onOpen,
}: {
  task: Task;
  onOpen: (id: string) => void;
}) {
  const { lead, why, followUpId } = task;
  const owned = Boolean(lead.owner);
  return (
    <li className="flex items-center justify-between gap-3 rounded-lg bg-manila/95 px-3 py-2">
      <button className="min-w-0 flex-1 text-left" onClick={() => onOpen(lead.id)}>
        <div className="flex items-center gap-2">
          <p className="truncate font-type text-sm font-semibold text-pad-ink">{lead.name}</p>
          {owned && (
            <span className="data shrink-0 rounded bg-pad-ink/10 px-1.5 text-[10px] text-pad-inkSoft">
              {lead.owner}
            </span>
          )}
        </div>
        <p className="truncate font-type text-xs text-pad-inkSoft">{why}</p>
      </button>
      <div className="flex shrink-0 items-center gap-2">
        {lead.phone && (
          <a
            href={`tel:${lead.phone.replace(/[^\d+]/g, '')}`}
            className="quick-chip"
            title={`Call ${lead.phone}`}
            onClick={(e) => e.stopPropagation()}
          >
            📞 Call
          </a>
        )}
        {followUpId && (
          <button
            className="rounded bg-emerald-600 px-2 py-1 text-xs font-semibold text-white"
            onClick={() => completeFollowUp(lead, followUpId)}
          >
            Done
          </button>
        )}
        <button className="btn-ghost px-2 py-1 text-xs text-pad-ink" onClick={() => onOpen(lead.id)}>
          Open
        </button>
      </div>
    </li>
  );
}
