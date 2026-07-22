import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import { useLeads } from '../store/useLeads';
import { useUI } from '../store/useUI';
import type { Lead } from '../types';
import { balanceOf, isPaidInFull, totalFeeOf } from '../lib/leadFlow';
import { fmtDate, fmtMoney, paymentPastDue } from '../lib/dates';
import { Badge } from '../components/ui/Badge';
import { SendToPdfAppButton } from '../components/SendToPdfAppButton';
import { reopenIntake } from '../lib/actions';

export function CompletedList() {
  const leads = useLeads();
  const selectLead = useUI((s) => s.selectLead);
  const openFinancing = useUI((s) => s.openFinancing);

  const completed = useMemo(
    () => leads.filter((l) => l.stage === 'intake_complete'),
    [leads],
  );

  const noSaleCount = useMemo(
    () => leads.filter((l) => l.stage === 'lost').length,
    [leads],
  );

  return (
    <div>
      <header className="mb-6 flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="font-hand text-4xl text-white">Intake Complete</h1>
          <p className="text-manila/70 text-sm">
            {completed.length} handed off to the next department — financed cases
            still appear in Financing
          </p>
        </div>
        <Link to="/no-sale" className="btn-ghost text-manila">
          View No Sale list{noSaleCount > 0 ? ` (${noSaleCount})` : ''} →
        </Link>
      </header>

      {completed.length === 0 ? (
        <p className="rounded-xl bg-black/20 p-10 text-center font-type text-sm text-manila/50">
          No completed intakes yet.
        </p>
      ) : (
        <div className="overflow-hidden rounded-2xl bg-manila/95 shadow-card">
          <table className="w-full text-left font-type text-sm">
            <thead className="bg-black/5 text-xs uppercase tracking-wide text-pad-inkSoft">
              <tr>
                <th className="px-4 py-3">Client</th>
                <th className="px-4 py-3">Completed</th>
                <th className="px-4 py-3">Next Court</th>
                <th className="px-4 py-3">Fee / Balance</th>
                <th className="px-4 py-3"></th>
              </tr>
            </thead>
            <tbody>
              {completed.map((l) => (
                <Row
                  key={l.id}
                  lead={l}
                  onOpen={() => selectLead(l.id)}
                  onFinancing={() => openFinancing(l.id)}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function Row({
  lead,
  onOpen,
  onFinancing,
}: {
  lead: Lead;
  onOpen: () => void;
  onFinancing: () => void;
}) {
  const balance = balanceOf(lead);
  const pastDue = paymentPastDue(lead);
  return (
    <tr className="border-t border-black/5 text-pad-ink">
      <td className="px-4 py-3">
        <button className="font-semibold hover:underline" onClick={onOpen}>
          {lead.name}
        </button>
        <p className="text-xs text-pad-inkSoft">TVC #{lead.tvcCaseNumber || '—'}</p>
      </td>
      <td className="px-4 py-3 text-xs">
        {lead.intakeCompleteAt ? new Date(lead.intakeCompleteAt).toLocaleDateString() : '—'}
        {isPaidInFull(lead) ? (
          <div className="mt-1">
            <Badge tone="green">Paid in full</Badge>
          </div>
        ) : (
          lead.isFinanced && (
            <div className="mt-1">
              <Badge tone="blue">Financed</Badge>
            </div>
          )
        )}
      </td>
      <td className="px-4 py-3">{fmtDate(lead.nextCourtDate)}</td>
      <td className="px-4 py-3">
        <div>{fmtMoney(totalFeeOf(lead))}</div>
        <div className={`text-xs ${pastDue ? 'font-bold text-pad-red' : 'text-pad-inkSoft'}`}>
          {balance > 0 ? `${fmtMoney(balance)} left${pastDue ? ' · PAST DUE' : ''}` : 'Paid in full'}
        </div>
      </td>
      <td className="px-4 py-3">
        <div className="flex items-center justify-end gap-2">
          <SendToPdfAppButton lead={lead} />
          <button className="btn-ghost px-2 py-1 text-xs text-pad-ink" onClick={onFinancing}>
            Payments
          </button>
          <button
            className="btn-ghost px-2 py-1 text-xs text-pad-ink"
            onClick={() => reopenIntake(lead)}
            title="Move back to Financed"
          >
            Reopen
          </button>
        </div>
      </td>
    </tr>
  );
}
