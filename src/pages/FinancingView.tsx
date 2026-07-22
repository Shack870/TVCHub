import { useMemo, useState } from 'react';
import { formatDistanceToNow } from 'date-fns';
import { useLeads } from '../store/useLeads';
import { useUI } from '../store/useUI';
import type { Lead } from '../types';
import {
  balanceOf,
  daysSinceLastSquarePayment,
  isFinancingClient,
  isPlanStalled,
  lastSquarePaymentTs,
  looksPaidOff,
  paidOf,
  squareCollectedOf,
  totalFeeOf,
} from '../lib/leadFlow';
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
        .sort((a, b) => {
          // Stalled plans float to the top — they're why this board exists.
          const stall = Number(isPlanStalled(b)) - Number(isPlanStalled(a));
          if (stall !== 0) return stall;
          return outstandingOf(b) - outstandingOf(a);
        }),
    [leads],
  );

  // Receivables HUD over the financed book (Square-tracked payment plans).
  const hud = useMemo(() => {
    let book = 0;
    let collected = 0;
    let outstanding = 0;
    let stalled = 0;
    for (const l of financed) {
      if (l.stage !== 'financed') continue;
      book += l.saleAmount ?? 0;
      collected += squareCollectedOf(l);
      outstanding += outstandingOf(l);
      if (isPlanStalled(l)) stalled += 1;
    }
    return { book, collected, outstanding, stalled };
  }, [financed]);

  return (
    <div>
      <header className="mb-6">
        <h1 className="font-hand text-4xl text-white">Financing</h1>
        <p className="text-manila/70 text-sm">
          {financed.length} clients on payment plans
        </p>
      </header>

      <ReceivablesHud {...hud} />

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

// Outstanding receivable on a plan: what's still owed of the quoted fee. When
// no fee was ever recorded there's nothing to compute against.
function outstandingOf(lead: Lead): number {
  if (typeof lead.saleAmount !== 'number' || lead.saleAmount <= 0) return 0;
  return Math.max(0, lead.saleAmount - squareCollectedOf(lead));
}

// Summary HUD in the Money-on-the-Table treatment: the financed book is
// exactly that — money already sold, waiting to finish arriving.
function ReceivablesHud({
  book,
  collected,
  outstanding,
  stalled,
}: {
  book: number;
  collected: number;
  outstanding: number;
  stalled: number;
}) {
  return (
    <section className="mb-6 rounded-2xl bg-gradient-to-r from-amber-500/15 via-amber-400/10 to-amber-500/15 p-4 ring-2 ring-amber-400/50">
      <div className="mb-3 flex items-center justify-between">
        <div>
          <h2 className="font-hand text-2xl text-amber-300">Receivables</h2>
          <p className="text-manila/60 text-xs">
            The financed book — sold money still arriving in installments
          </p>
        </div>
        {stalled > 0 && (
          <Badge tone="red" pulse>
            {stalled} stalled
          </Badge>
        )}
      </div>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <HudStat label="Financed Book" value={fmtMoney(book)} className="text-amber-300" />
        <HudStat label="Collected" value={fmtMoney(collected)} className="text-emerald-400" />
        <HudStat label="Outstanding" value={fmtMoney(outstanding)} className="text-pad-red" />
        <HudStat
          label="Stalled Plans"
          value={String(stalled)}
          className={stalled > 0 ? 'text-pad-red' : 'text-manila/80'}
        />
      </div>
    </section>
  );
}

function HudStat({
  label,
  value,
  className,
}: {
  label: string;
  value: string;
  className: string;
}) {
  return (
    <div className="rounded-xl bg-black/25 p-3 ring-1 ring-white/10">
      <p className="text-[11px] uppercase tracking-wide text-manila/60">{label}</p>
      <p className={`font-type text-2xl font-bold ${className}`}>{value}</p>
    </div>
  );
}

// Payment progress off the Square trail: collected vs the quoted fee, with the
// newest reconciled charge as the "last payment" stamp.
function PaymentProgress({ lead }: { lead: Lead }) {
  const collected = squareCollectedOf(lead);
  const fee = typeof lead.saleAmount === 'number' && lead.saleAmount > 0 ? lead.saleAmount : null;
  const lastTs = lastSquarePaymentTs(lead);
  const pct = fee ? Math.min(100, (collected / fee) * 100) : null;

  const lastLabel = lastTs
    ? `last payment ${formatDistanceToNow(lastTs, { addSuffix: true })}`
    : 'no payment recorded yet';

  return (
    <div className="mt-3">
      <div className="flex items-baseline justify-between font-type text-xs text-pad-inkSoft">
        <span className="font-semibold text-pad-ink">
          {fee
            ? `${fmtMoney(collected)} of ${fmtMoney(fee)}`
            : `${fmtMoney(collected)} collected (no fee on file)`}
        </span>
        <span>{lastLabel}</span>
      </div>
      {pct !== null && (
        <div className="mt-1 h-2.5 overflow-hidden rounded-full bg-black/15 shadow-inner ring-1 ring-black/10">
          <div
            className={`h-full rounded-full ${pct >= 100 ? 'bg-emerald-500' : 'bg-gradient-to-r from-amber-400 to-emerald-500'}`}
            style={{ width: `${pct}%` }}
          />
        </div>
      )}
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
  const stalled = isPlanStalled(lead);
  const stallDays = daysSinceLastSquarePayment(lead);
  const paidOffHint = looksPaidOff(lead);
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
    <div
      className={`legal-pad rounded-lg p-4 pl-14 shadow-card ring-1 ${
        stalled ? 'ring-2 ring-pad-red/60' : 'ring-black/10'
      }`}
    >
      <div className="flex items-start justify-between">
        <button className="min-w-0 text-left" onClick={onOpenDetail}>
          <h3 className="font-hand text-2xl ink hover:underline">{lead.name}</h3>
          <p className="font-type text-xs text-pad-inkSoft">
            {lead.stage === 'financed'
              ? 'Financed — paying'
              : lead.intakeComplete
                ? 'Intake complete'
                : 'Owes balance'}{' '}
            · TVC #{lead.tvcCaseNumber || '—'}
          </p>
        </button>
        <div className="flex shrink-0 flex-col items-end gap-1">
          {stalled && (
            <Badge tone="red" pulse>
              STALLED — no payment in {stallDays}d
            </Badge>
          )}
          {courtFlag && <Badge tone="red">Court date passed</Badge>}
          {pastDue && <Badge tone="red">Past due</Badge>}
          {paidOffHint && <Badge tone="green">Paid off?</Badge>}
        </div>
      </div>

      <PaymentProgress lead={lead} />

      {paidOffHint && (
        <p className="mt-2 rounded-md bg-emerald-600/10 px-2 py-1 font-type text-xs text-emerald-800">
          Square shows {fmtMoney(squareCollectedOf(lead))} collected against a{' '}
          {fmtMoney(lead.saleAmount ?? 0)} fee — this plan looks paid off but still sits in
          Financed. Double-check and move it along.
        </p>
      )}

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
