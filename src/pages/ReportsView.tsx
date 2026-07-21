import { useMemo, useState } from 'react';
import { addWeeks, format } from 'date-fns';
import { useLeads } from '../store/useLeads';
import { fmtMoney } from '../lib/dates';
import { buildReport, reportToText, weeklyLeadTrend, weekRangeFor } from '../lib/metrics';

export function ReportsView() {
  const leads = useLeads();
  const [ref, setRef] = useState(() => new Date());
  const [copied, setCopied] = useState(false);

  const report = useMemo(() => buildReport(leads, ref), [leads, ref]);
  const trend = useMemo(() => weeklyLeadTrend(leads, ref, 8), [leads, ref]);

  const isThisWeek = weekRangeFor(ref).start === weekRangeFor(new Date()).start;

  const copy = async () => {
    await navigator.clipboard.writeText(reportToText(report));
    setCopied(true);
    setTimeout(() => setCopied(false), 1800);
  };

  return (
    <div>
      <header className="mb-6 flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="font-hand text-4xl text-white">Weekly Sales Report</h1>
          <p className="text-manila/70 text-sm">
            {report.range.label} · as of{' '}
            {format(report.generatedAt, 'EEE MMM d, h:mm a')}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button className="btn-ghost text-manila" onClick={() => setRef(addWeeks(ref, -1))}>
            ‹ Prev
          </button>
          <button
            className="btn-ghost text-manila"
            onClick={() => setRef(new Date())}
            disabled={isThisWeek}
          >
            This Week
          </button>
          <button
            className="btn-ghost text-manila"
            onClick={() => setRef(addWeeks(ref, 1))}
            disabled={isThisWeek}
          >
            Next ›
          </button>
          <button className="btn-ghost text-manila" onClick={copy}>
            {copied ? 'Copied ✓' : 'Copy summary'}
          </button>
          <button className="btn-primary" onClick={() => window.print()}>
            Print
          </button>
        </div>
      </header>

      {/* This week's flow */}
      <h2 className="mb-2 font-hand text-2xl text-white/90">This Week</h2>
      <div className="mb-6 grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        <KPI label="New Leads" value={String(report.leadsIn)} tone="blue" />
        <KPI label="Calls Logged" value={String(report.callsLogged)} />
        <KPI label="Retained" value={String(report.retainedThisWeek)} tone="green" />
        <KPI label="Declined" value={String(report.declinedThisWeek)} tone="red" />
        <KPI label="No Sale" value={String(report.lostThisWeek)} tone="red" />
        <KPI label="Collected" value={fmtMoney(report.revenueCollected)} tone="green" />
      </div>

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
        {/* Leads per day */}
        <Panel title="Leads In — by day">
          <VBars
            bars={report.daily}
            color="#e0a52f"
            empty="No leads received this week yet."
          />
        </Panel>

        {/* Weekly trend */}
        <Panel title="Leads per week — last 8 weeks">
          <VBars bars={trend} color="#6fa8dc" empty="No history yet." />
        </Panel>
      </div>

      {/* Rates */}
      <h2 className="mb-2 mt-7 font-hand text-2xl text-white/90">Rates</h2>
      <div className="grid grid-cols-1 gap-5 lg:grid-cols-3">
        <Panel title="Close Rate">
          <BigStat value={`${report.closeRate}%`} sub={`${report.clients} of ${report.totalLeads} leads retained`} />
          <RateBar pct={report.closeRate} color="#2f8f4e" />
          <Mini label="Decision close rate" value={`${report.decisionCloseRate}% (decided)`} />
          <Mini label="Decline rate" value={`${report.declineRate}%`} />
          <Mini label="No Sale (written off)" value={String(report.lost)} />
          <Mini label="Contacted rate" value={`${report.contactedRate}%`} />
          <Mini
            label="Avg speed to 1st contact"
            value={report.avgSpeedToContactHours == null ? '—' : `${report.avgSpeedToContactHours.toFixed(1)} hrs`}
          />
          <Mini label="This week's cohort" value={`${report.cohortCloseRate}% (${report.cohortRetained}/${report.leadsIn})`} />
        </Panel>

        <Panel title="Finance Rate">
          <BigStat
            value={`${report.financeRate}%`}
            sub={`${report.financed} financed · ${report.paidInFull} paid in full`}
          />
          <SplitBar
            left={{ value: report.paidInFull, label: 'Paid in full', color: '#2f8f4e' }}
            right={{ value: report.financed, label: 'Financed', color: '#e0a52f' }}
          />
          <Mini label="Avg fee" value={fmtMoney(report.avgFee)} />
          <Mini label="Avg attempts to close" value={report.avgAttemptsToClose.toFixed(1)} />
        </Panel>

        <Panel title="Money">
          <BigStat value={fmtMoney(report.collectedAllTime)} sub="Collected all-time" />
          <Mini label="Outstanding balance" value={fmtMoney(report.outstanding)} />
          <Mini label="Past-due accounts" value={String(report.pastDueAccounts)} />
          <Mini label="Collected this week" value={fmtMoney(report.revenueCollected)} />
        </Panel>
      </div>

      {/* Pipeline snapshot */}
      <h2 className="mb-2 mt-7 font-hand text-2xl text-white/90">Pipeline (live)</h2>
      <Panel title="Where every lead stands right now">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
          {report.funnel.map((f) => (
            <div key={f.label} className="rounded-xl bg-white/5 p-4 text-center">
              <p className="text-3xl font-bold text-white">{f.value}</p>
              <p className="mt-1 text-xs uppercase tracking-wide text-manila/60">{f.label}</p>
            </div>
          ))}
        </div>
      </Panel>
    </div>
  );
}

function KPI({
  label,
  value,
  tone = 'neutral',
}: {
  label: string;
  value: string;
  tone?: 'neutral' | 'green' | 'red' | 'blue';
}) {
  const color =
    tone === 'green'
      ? 'text-emerald-400'
      : tone === 'red'
        ? 'text-pad-red'
        : tone === 'blue'
          ? 'text-sky-300'
          : 'text-white';
  return (
    <div className="rounded-2xl bg-black/25 p-4 ring-1 ring-white/10">
      <p className="text-[11px] uppercase tracking-wide text-manila/60">{label}</p>
      <p className={`data mt-1 text-2xl font-bold ${color}`}>{value}</p>
    </div>
  );
}

function Panel({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-2xl bg-black/20 p-5 ring-1 ring-white/10">
      <h3 className="mb-3 font-type text-xs uppercase tracking-widest text-manila/60">{title}</h3>
      {children}
    </section>
  );
}

function BigStat({ value, sub }: { value: string; sub: string }) {
  return (
    <div className="mb-3">
      <p className="data text-4xl font-bold text-white">{value}</p>
      <p className="text-xs text-manila/60">{sub}</p>
    </div>
  );
}

function Mini({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between border-t border-white/5 py-1.5 text-sm">
      <span className="text-manila/70">{label}</span>
      <span className="data font-semibold text-white">{value}</span>
    </div>
  );
}

function RateBar({ pct, color }: { pct: number; color: string }) {
  return (
    <div className="mb-3 h-2.5 w-full overflow-hidden rounded-full bg-white/10">
      <div className="h-full rounded-full" style={{ width: `${pct}%`, backgroundColor: color }} />
    </div>
  );
}

function SplitBar({
  left,
  right,
}: {
  left: { value: number; label: string; color: string };
  right: { value: number; label: string; color: string };
}) {
  const total = left.value + right.value;
  const lp = total > 0 ? (left.value / total) * 100 : 0;
  const rp = total > 0 ? (right.value / total) * 100 : 0;
  return (
    <div className="mb-3">
      <div className="flex h-3 w-full overflow-hidden rounded-full bg-white/10">
        <div style={{ width: `${lp}%`, backgroundColor: left.color }} />
        <div style={{ width: `${rp}%`, backgroundColor: right.color }} />
      </div>
      <div className="mt-1.5 flex justify-between text-[11px] text-manila/70">
        <span className="flex items-center gap-1">
          <span className="h-2 w-2 rounded-sm" style={{ backgroundColor: left.color }} />
          {left.label} ({left.value})
        </span>
        <span className="flex items-center gap-1">
          <span className="h-2 w-2 rounded-sm" style={{ backgroundColor: right.color }} />
          {right.label} ({right.value})
        </span>
      </div>
    </div>
  );
}

function VBars({
  bars,
  color,
  empty,
}: {
  bars: { label: string; value: number }[];
  color: string;
  empty: string;
}) {
  const max = Math.max(1, ...bars.map((b) => b.value));
  const hasData = bars.some((b) => b.value > 0);
  if (!hasData) {
    return <p className="py-10 text-center font-type text-sm text-manila/40">{empty}</p>;
  }
  // Pixel heights, not percentages: a % height can't resolve against the
  // auto-height flex column, which collapsed every bar to its minimum.
  const MAX_BAR_PX = 128;
  return (
    <div className="flex h-44 items-end justify-between gap-2">
      {bars.map((b, i) => (
        <div key={i} className="flex flex-1 flex-col items-center justify-end gap-1">
          <span className="data text-xs font-semibold text-white">{b.value || ''}</span>
          <div
            className="w-full rounded-t-md transition-all"
            style={{
              height: Math.max(b.value > 0 ? 4 : 0, Math.round((b.value / max) * MAX_BAR_PX)),
              backgroundColor: color,
            }}
          />
          <span className="text-[10px] text-manila/60">{b.label}</span>
        </div>
      ))}
    </div>
  );
}
