import { useMemo, useState } from 'react';
import { useLeads } from '../store/useLeads';
import { useUI } from '../store/useUI';
import type { Lead } from '../types';
import { balanceOf, isFinancingClient, paidOf, totalFeeOf } from '../lib/leadFlow';
import { fmtDate, fmtMoney, needsCourtDateUpdate, paymentPastDue } from '../lib/dates';
import { recordPayment } from '../lib/actions';
import { Badge } from '../components/ui/Badge';

export function FinancingView() {
  const leads = useLeads();
  const selectLead = useUI((s) => s.selectLead);
  const openFinancing = useUI((s) => s.openFinancing);

  const financed = useMemo(
    () =>
      leads
        .filter(isFinancingClient)
        .sort((a, b) => balanceOf(b) - balanceOf(a)),
    [leads],
  );

  const totals = useMemo(() => {
    let outstanding = 0;
    let collected = 0;
    let pastDue = 0;
    for (const l of financed) {
      outstanding += balanceOf(l);
      collected += paidOf(l);
      if (paymentPastDue(l)) pastDue += 1;
    }
    return { outstanding, collected, pastDue };
  }, [financed]);

  return (
    <div>
      <header className="mb-6">
        <h1 className="font-hand text-4xl text-white">Financing</h1>
        <p className="text-manila/70 text-sm">
          {financed.length} clients on payment plans
        </p>
      </header>

      <div className="mb-6 grid grid-cols-1 gap-3 sm:grid-cols-3">
        <Summary label="Outstanding" value={fmtMoney(totals.outstanding)} tone="red" />
        <Summary label="Collected" value={fmtMoney(totals.collected)} tone="green" />
        <Summary label="Past Due Accounts" value={String(totals.pastDue)} tone="amber" />
      </div>

      {financed.length === 0 ? (
        <p className="rounded-xl bg-black/20 p-10 text-center font-type text-sm text-manila/50">
          No financed clients yet.
        </p>
      ) : (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          {financed.map((l) => (
            <FinanceCard
              key={l.id}
              lead={l}
              onOpenDetail={() => selectLead(l.id)}
              onManage={() => openFinancing(l.id)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function Summary({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone: 'red' | 'green' | 'amber';
}) {
  const color =
    tone === 'red' ? 'text-pad-red' : tone === 'green' ? 'text-emerald-400' : 'text-amber-400';
  return (
    <div className="rounded-2xl bg-black/25 p-4 ring-1 ring-white/10">
      <p className="text-xs uppercase tracking-wide text-manila/60">{label}</p>
      <p className={`text-2xl font-bold ${color}`}>{value}</p>
    </div>
  );
}

function FinanceCard({
  lead,
  onOpenDetail,
  onManage,
}: {
  lead: Lead;
  onOpenDetail: () => void;
  onManage: () => void;
}) {
  const balance = balanceOf(lead);
  const pastDue = paymentPastDue(lead);
  const courtFlag = needsCourtDateUpdate(lead);
  const monthly = lead.financing?.monthlyAmount ?? 0;
  const [custom, setCustom] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const record = async (amount: number, note: string) => {
    if (!(amount > 0)) return;
    setBusy(true);
    setMsg(null);
    const res = await recordPayment(lead, { amount, method: 'card', note });
    setBusy(false);
    if (res.ok) {
      setCustom('');
      setMsg(`Recorded ${fmtMoney(amount)} ✓`);
    } else {
      setMsg(res.error || 'Could not record payment.');
    }
  };

  return (
    <div className="legal-pad rounded-lg p-4 pl-14 shadow-card ring-1 ring-black/10">
      <div className="flex items-start justify-between">
        <button className="min-w-0 text-left" onClick={onOpenDetail}>
          <h3 className="font-hand text-2xl ink hover:underline">{lead.name}</h3>
          <p className="font-type text-xs text-pad-inkSoft">
            {lead.intakeComplete ? 'Intake complete' : 'Retained'} · TVC #
            {lead.tvcCaseNumber || '—'}
          </p>
        </button>
        <div className="flex shrink-0 flex-col items-end gap-1">
          {courtFlag && <Badge tone="red">Court date passed</Badge>}
          {pastDue && <Badge tone="red">Past due</Badge>}
        </div>
      </div>

      <div className="mt-3 grid grid-cols-4 gap-2 font-type text-sm">
        <Mini label="Fee" value={fmtMoney(totalFeeOf(lead))} />
        <Mini label="Paid" value={fmtMoney(paidOf(lead))} />
        <Mini label="Balance" value={fmtMoney(balance)} strong={balance > 0} />
        <Mini label="Monthly" value={monthly ? fmtMoney(monthly) : '—'} />
      </div>
      <p className="mt-2 font-type text-xs text-pad-inkSoft">
        Payment due {fmtDate(lead.financing?.nextPaymentDue)} · Next court:{' '}
        {lead.caseDismissed ? 'Dismissed' : fmtDate(lead.nextCourtDate)}
      </p>

      {balance > 0 && courtFlag ? (
        <div className="mt-3 border-t border-black/10 pt-3">
          <p className="font-type text-xs font-semibold text-pad-red">
            Court date passed — resolve it before recording payment.
          </p>
          <button
            className="mt-1 btn bg-pad-red px-3 py-1.5 text-xs text-white"
            onClick={onManage}
          >
            Resolve court date ▸
          </button>
        </div>
      ) : balance > 0 ? (
        <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-black/10 pt-3">
          {monthly > 0 && (
            <button
              disabled={busy}
              className="btn bg-emerald-600 px-3 py-1.5 text-xs text-white disabled:opacity-50"
              onClick={() => record(Math.min(monthly, balance), 'Monthly payment')}
            >
              Record {fmtMoney(monthly)} monthly
            </button>
          )}
          <input
            type="number"
            value={custom}
            onChange={(e) => setCustom(e.target.value)}
            placeholder="Custom $"
            className="w-24 rounded-md border border-black/10 bg-white/80 p-1.5 font-type text-xs"
          />
          <button
            disabled={busy || !(parseFloat(custom) > 0)}
            className="btn-ghost px-2 py-1 text-xs text-pad-ink disabled:opacity-40"
            onClick={() => record(parseFloat(custom), 'Payment')}
          >
            Record
          </button>
          <button className="btn-ghost px-2 py-1 text-xs text-pad-ink" onClick={onManage}>
            History ▸
          </button>
        </div>
      ) : (
        <div className="mt-3 border-t border-black/10 pt-3 font-type text-xs font-semibold text-emerald-700">
          Paid in full ✓
          <button className="ml-2 font-normal text-pad-inkSoft underline" onClick={onManage}>
            History
          </button>
        </div>
      )}
      {msg && <p className="mt-2 font-type text-xs text-pad-inkSoft">{msg}</p>}
    </div>
  );
}

function Mini({
  label,
  value,
  strong,
}: {
  label: string;
  value: string;
  strong?: boolean;
}) {
  return (
    <div>
      <span className="field-label block">{label}</span>
      <span className={strong ? 'font-bold text-pad-red' : 'text-pad-ink'}>{value}</span>
    </div>
  );
}
