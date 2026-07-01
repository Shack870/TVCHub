import { useMemo } from 'react';
import { formatDistanceToNow } from 'date-fns';
import { useLeads } from '../store/useLeads';
import { useUI } from '../store/useUI';
import type { Lead } from '../types';
import { OUTCOME_LABELS } from '../lib/leadFlow';
import { fmtDate } from '../lib/dates';
import { reviveLost } from '../lib/actions';
import { Badge } from '../components/ui/Badge';

export function NoSaleList() {
  const leads = useLeads();
  const selectLead = useUI((s) => s.selectLead);

  const noSale = useMemo(
    () =>
      leads
        .filter((l) => l.stage === 'lost')
        .sort((a, b) => (b.lostAt ?? 0) - (a.lostAt ?? 0)),
    [leads],
  );

  return (
    <div>
      <header className="mb-6">
        <h1 className="font-hand text-4xl text-white">No Sale</h1>
        <p className="text-manila/70 text-sm">
          {noSale.length} {noSale.length === 1 ? 'lead' : 'leads'} that came in but
          didn't retain — with the full contact history.
        </p>
      </header>

      {noSale.length === 0 ? (
        <p className="rounded-xl bg-black/20 p-10 text-center font-type text-sm text-manila/50">
          No "no sale" leads yet. Marking a lead No Sale moves it here with its log.
        </p>
      ) : (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          {noSale.map((l) => (
            <NoSaleCard
              key={l.id}
              lead={l}
              onOpen={() => selectLead(l.id)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function NoSaleCard({ lead, onOpen }: { lead: Lead; onOpen: () => void }) {
  const attempts = [...(lead.contactAttempts ?? [])].sort((a, b) => b.ts - a.ts);
  return (
    <div className="rounded-2xl bg-manila/95 p-4 shadow-card ring-1 ring-black/10">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <button className="text-left" onClick={onOpen}>
            <h3 className="font-hand text-2xl text-pad-ink hover:underline">{lead.name}</h3>
          </button>
          <p className="data text-xs text-pad-inkSoft">
            TVC #{lead.tvcCaseNumber || '—'}
            {lead.phone ? ` · ${lead.phone}` : ''}
          </p>
        </div>
        <div className="flex flex-col items-end gap-1">
          <Badge tone="neutral">No Sale</Badge>
          <span className="data text-[11px] text-pad-inkSoft/70">
            {lead.lostAt ? fmtDate(new Date(lead.lostAt).toISOString().slice(0, 10)) : '—'}
          </span>
        </div>
      </div>

      {lead.lostReason && (
        <p className="mt-2 font-type text-sm text-pad-ink">
          <span className="field-label mr-1">Reason</span>
          {lead.lostReason}
        </p>
      )}

      <div className="mt-3">
        <span className="field-label">Contact history</span>
        {attempts.length === 0 ? (
          <p className="mt-1 font-type text-xs text-pad-inkSoft/60">
            No attempts were logged.
          </p>
        ) : (
          <ul className="mt-1.5 space-y-1.5 border-l-2 border-pad-line/50 pl-4">
            {attempts.map((a, i) => (
              <li key={i} className="relative">
                <span className="absolute -left-[21px] top-1.5 h-2 w-2 rounded-full bg-pad-inkSoft/50" />
                <div className="font-type text-sm text-pad-ink">
                  <span className="font-bold">{OUTCOME_LABELS[a.outcome]}</span>
                  <span className="text-pad-inkSoft/60">
                    {' '}· {formatDistanceToNow(a.ts, { addSuffix: true })}
                  </span>
                </div>
                {a.notes && <p className="font-type text-xs text-pad-ink">{a.notes}</p>}
                {a.by && (
                  <p className="font-type text-[11px] text-pad-inkSoft/50">— {a.by}</p>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="mt-3 flex justify-end gap-2">
        <button className="btn-ghost px-3 py-1 text-xs text-pad-ink" onClick={onOpen}>
          Open file
        </button>
        <button
          className="btn-ghost px-3 py-1 text-xs text-pad-ink"
          onClick={() => reviveLost(lead)}
          title="Bring this lead back into the working pipeline"
        >
          Reopen
        </button>
      </div>
    </div>
  );
}
