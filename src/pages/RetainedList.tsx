import { useMemo, useState } from 'react';
import { useLeads } from '../store/useLeads';
import { useUI } from '../store/useUI';
import type { Lead } from '../types';
import { balanceOf, totalFeeOf } from '../lib/leadFlow';
import { fmtDate, fmtMoney, paymentPastDue } from '../lib/dates';
import { Badge } from '../components/ui/Badge';
import { ConfirmDialog } from '../components/ui/ConfirmDialog';
import {
  markIntakeComplete,
  toggleRetainerSent,
  toggleRetainerSigned,
  unretain,
} from '../lib/actions';

export function RetainedList() {
  const leads = useLeads();
  const selectLead = useUI((s) => s.selectLead);
  const openFinancing = useUI((s) => s.openFinancing);

  const retained = useMemo(
    () => leads.filter((l) => l.stage === 'retained'),
    [leads],
  );

  return (
    <div>
      <header className="mb-6">
        <h1 className="font-hand text-4xl text-white">Retained Clients</h1>
        <p className="text-manila/70 text-sm">
          {retained.length} retained — finish intake to hand off to the next
          department
        </p>
      </header>

      {retained.length === 0 ? (
        <p className="rounded-xl bg-black/20 p-10 text-center font-type text-sm text-manila/50">
          No retained clients yet.
        </p>
      ) : (
        <div className="overflow-hidden rounded-2xl bg-manila/95 shadow-card">
          <table className="w-full text-left font-type text-sm">
            <thead className="bg-black/5 text-xs uppercase tracking-wide text-pad-inkSoft">
              <tr>
                <th className="px-4 py-3">Client</th>
                <th className="px-4 py-3">Next Court</th>
                <th className="px-4 py-3">Fee / Balance</th>
                <th className="px-4 py-3">Retainer</th>
                <th className="px-4 py-3">Checks</th>
                <th className="px-4 py-3"></th>
              </tr>
            </thead>
            <tbody>
              {retained.map((l) => (
                <RetainedRow
                  key={l.id}
                  lead={l}
                  onOpen={() => selectLead(l.id)}
                  onOpenChecks={() => selectLead(l.id, 'checks')}
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

function RetainedRow({
  lead,
  onOpen,
  onOpenChecks,
  onFinancing,
}: {
  lead: Lead;
  onOpen: () => void;
  onOpenChecks: () => void;
  onFinancing: () => void;
}) {
  const balance = balanceOf(lead);
  const pastDue = paymentPastDue(lead);
  const checksClear = lead.conflictCheck.status === 'clear';
  const [confirmComplete, setConfirmComplete] = useState(false);
  const [confirmBack, setConfirmBack] = useState(false);

  const warnings: string[] = [];
  if (lead.conflictCheck.status !== 'clear') warnings.push('conflict check not cleared');
  if (!lead.retainerSignedConfirmed) warnings.push('retainer not confirmed signed');
  if (balance > 0) warnings.push(`${fmtMoney(balance)} balance still owed`);
  const completeMessage =
    warnings.length > 0
      ? `Heads up — ${warnings.join(', ')}. Hand ${lead.name} to the next department anyway?`
      : `Mark ${lead.name} as intake complete and hand the file to the next department.`;

  return (
    <tr className="border-t border-black/5 text-pad-ink">
      <td className="px-4 py-3">
        <button className="font-semibold hover:underline" onClick={onOpen}>
          {lead.name}
        </button>
        <p className="text-xs text-pad-inkSoft">TVC #{lead.tvcCaseNumber || '—'}</p>
      </td>
      <td className="px-4 py-3">{fmtDate(lead.nextCourtDate)}</td>
      <td className="px-4 py-3">
        <div>{fmtMoney(totalFeeOf(lead))}</div>
        <div className={`text-xs ${pastDue ? 'font-bold text-pad-red' : 'text-pad-inkSoft'}`}>
          {balance > 0 ? `${fmtMoney(balance)} left${pastDue ? ' · PAST DUE' : ''}` : 'Paid in full'}
        </div>
      </td>
      <td className="px-4 py-3">
        <div className="flex flex-col gap-1">
          <label className="inline-flex cursor-pointer items-center gap-2">
            <input
              type="checkbox"
              checked={Boolean(lead.retainerSentForSignature)}
              onChange={(e) => toggleRetainerSent(lead, e.target.checked)}
            />
            <span className="text-xs">
              {lead.retainerSentForSignature ? 'Sent for signature' : 'Not sent'}
            </span>
          </label>
          <label className="inline-flex cursor-pointer items-center gap-2">
            <input
              type="checkbox"
              checked={Boolean(lead.retainerSignedConfirmed)}
              onChange={(e) => toggleRetainerSigned(lead, e.target.checked)}
            />
            <span className="text-xs">
              {lead.retainerSignedConfirmed ? 'Signed ✓' : 'Not signed'}
            </span>
          </label>
        </div>
      </td>
      <td className="px-4 py-3">
        <button onClick={onOpenChecks} title="Open the Checks tab" className="hover:opacity-80">
          {checksClear ? (
            <Badge tone="green">Clear</Badge>
          ) : (
            <Badge tone="amber">Pending ›</Badge>
          )}
        </button>
      </td>
      <td className="px-4 py-3">
        <div className="flex justify-end gap-2">
          <button
            className="btn-ghost px-2 py-1 text-xs text-pad-ink"
            onClick={() => setConfirmBack(true)}
            title="Send back to the active leads board"
          >
            ← Back to Leads
          </button>
          <button className="btn-ghost px-2 py-1 text-xs text-pad-ink" onClick={onFinancing}>
            Payments
          </button>
          <button
            className="btn bg-pad-ink px-2 py-1 text-xs text-pad-paper hover:bg-pad-inkSoft"
            onClick={() => setConfirmComplete(true)}
          >
            Intake Complete →
          </button>
        </div>
        <ConfirmDialog
          open={confirmComplete}
          title="Client Intake Complete?"
          message={completeMessage}
          confirmLabel="Mark Complete"
          tone={warnings.length > 0 ? 'danger' : 'default'}
          onClose={() => setConfirmComplete(false)}
          onConfirm={() => markIntakeComplete(lead)}
        />
        <ConfirmDialog
          open={confirmBack}
          title="Send back to leads?"
          message={`Move ${lead.name} out of Retained and back to the active leads board (Follow-Up Pipeline). Payment-plan tracking will pause until they're retained again.`}
          confirmLabel="Send Back"
          onClose={() => setConfirmBack(false)}
          onConfirm={() => unretain(lead)}
        />
      </td>
    </tr>
  );
}
