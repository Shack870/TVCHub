import { useState } from 'react';
import { Modal } from './ui/Modal';
import { Badge } from './ui/Badge';
import { useUI } from '../store/useUI';
import { useLead } from '../store/useLeads';
import type { Lead, Payment } from '../types';
import { balanceOf, isPaidInFull, paidOf, totalFeeOf } from '../lib/leadFlow';
import { courtDatePassed, fmtDate, fmtMoney, needsCourtDateUpdate, paymentPastDue } from '../lib/dates';
import {
  markCaseDismissed,
  recordPayment,
  setFinancingTerms,
  updateCourtDate,
} from '../lib/actions';
import { PAYMENT_METHODS } from '../lib/payments';

export function FinancingModal() {
  const id = useUI((s) => s.financingLeadId);
  const close = useUI((s) => s.closeFinancing);
  const lead = useLead(id ?? undefined);
  return (
    <Modal open={Boolean(id && lead)} onClose={close} width="max-w-xl">
      {lead && <Body lead={lead} onClose={close} />}
    </Modal>
  );
}

function Body({ lead, onClose }: { lead: Lead; onClose: () => void }) {
  const balance = balanceOf(lead);
  const paid = isPaidInFull(lead);
  const onPlan = Boolean(lead.isFinanced) && !paid;
  const needsCourtUpdate = needsCourtDateUpdate(lead);
  const pastDue = paymentPastDue(lead);

  return (
    <div className="legal-pad rounded-lg p-6 pl-14 shadow-card">
      <div className="flex items-start justify-between">
        <div>
          <h2 className="font-hand text-4xl ink">{lead.name}</h2>
          <p className="font-type text-xs text-pad-inkSoft">
            TVC #{lead.tvcCaseNumber || '—'}
            {paid ? ' · Paid in full' : onPlan ? ' · Financed' : ''}
          </p>
        </div>
        <button className="btn-ghost text-pad-ink" onClick={onClose}>
          ✕
        </button>
      </div>

      {needsCourtUpdate && <CourtGate lead={lead} />}

      <div className="mt-4 grid grid-cols-3 gap-3 font-type">
        <Stat label="Total Fee" value={fmtMoney(totalFeeOf(lead))} />
        <Stat label="Paid" value={fmtMoney(paidOf(lead))} tone="green" />
        <Stat
          label="Balance"
          value={fmtMoney(balance)}
          tone={balance > 0 ? 'red' : 'green'}
        />
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-3 font-type text-sm text-pad-ink">
        <span className="field-label">Next Court</span>
        <Badge tone={courtDatePassed(lead) ? 'red' : 'neutral'}>
          {lead.caseDismissed ? 'Case Dismissed' : fmtDate(lead.nextCourtDate)}
        </Badge>
        {paid ? (
          <Badge tone="green">Paid in full</Badge>
        ) : (
          onPlan && (
            <>
              <span className="field-label ml-2">Payment Due</span>
              <Badge tone={pastDue ? 'red' : 'neutral'}>
                {fmtDate(lead.financing?.nextPaymentDue)}
                {pastDue ? ' · PAST DUE' : ''}
              </Badge>
              {lead.financing?.monthlyAmount ? (
                <>
                  <span className="field-label ml-2">Monthly</span>
                  <Badge tone="blue">{fmtMoney(lead.financing.monthlyAmount)}/mo</Badge>
                </>
              ) : null}
            </>
          )
        )}
      </div>

      <Terms lead={lead} paid={paid} />

      <PaymentList lead={lead} />

      {paid ? (
        <p className="mt-4 rounded-lg bg-emerald-600/10 px-3 py-2 font-type text-sm font-semibold text-emerald-800">
          Paid in full — $0 balance due. Nothing else to collect.
        </p>
      ) : (
        <AddPayment lead={lead} disabled={needsCourtUpdate} />
      )}
    </div>
  );
}

function Stat({
  label,
  value,
  tone = 'neutral',
}: {
  label: string;
  value: string;
  tone?: 'neutral' | 'green' | 'red';
}) {
  const color =
    tone === 'green' ? 'text-emerald-700' : tone === 'red' ? 'text-pad-red' : 'ink';
  return (
    <div className="rounded-lg bg-white/70 p-3 text-center">
      <p className="field-label">{label}</p>
      <p className={`text-xl font-bold ${color}`}>{value}</p>
    </div>
  );
}

function CourtGate({ lead }: { lead: Lead }) {
  const [date, setDate] = useState('');
  return (
    <div className="mt-4 rounded-lg border-2 border-pad-red bg-pad-red/10 p-4">
      <p className="font-type text-sm font-bold text-pad-red">
        Action required: the court date has passed.
      </p>
      <p className="mb-3 font-type text-xs text-pad-ink">
        No court date passes without a new one — enter the next date or mark the
        case dismissed.
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <input
          type="date"
          value={date}
          onChange={(e) => setDate(e.target.value)}
          className="rounded-md border border-black/10 bg-white/80 p-2 font-type text-sm"
        />
        <button
          className="btn-primary"
          disabled={!date}
          onClick={() => updateCourtDate(lead, date)}
        >
          Set New Court Date
        </button>
        <button
          className="btn-danger"
          onClick={() => markCaseDismissed(lead)}
        >
          Case Dismissed
        </button>
      </div>
    </div>
  );
}

function Terms({ lead, paid }: { lead: Lead; paid: boolean }) {
  const [fee, setFee] = useState(String(lead.financing?.totalFee ?? ''));
  const [due, setDue] = useState(lead.financing?.nextPaymentDue ?? '');
  const dirty =
    fee !== String(lead.financing?.totalFee ?? '') ||
    due !== (lead.financing?.nextPaymentDue ?? '');
  return (
    <div className="mt-4 rounded-lg bg-white/60 p-3">
      <p className="field-label mb-2">Billing</p>
      <div className="flex flex-wrap items-end gap-3 font-type text-sm">
        <label className="block">
          <span className="field-label">Total Fee</span>
          <input
            type="number"
            value={fee}
            onChange={(e) => setFee(e.target.value)}
            className="mt-1 w-28 rounded-md border border-black/10 bg-white p-2"
          />
        </label>
        {/* A payment plan only makes sense while a balance is owed. */}
        {!paid && (
          <label className="block">
            <span className="field-label">
              Next Payment Due {lead.isFinanced ? '' : '(starts a plan)'}
            </span>
            <input
              type="date"
              value={due}
              onChange={(e) => setDue(e.target.value)}
              className="mt-1 rounded-md border border-black/10 bg-white p-2"
            />
          </label>
        )}
        <button
          className="btn-primary"
          disabled={!dirty}
          onClick={() =>
            setFinancingTerms(lead, {
              totalFee: parseFloat(fee) || 0,
              nextPaymentDue: due || null,
              // Only become "financed" when a payment plan (due date) is set;
              // editing a paid-in-full client's fee shouldn't reclassify them.
              isFinanced: due ? true : lead.isFinanced,
            })
          }
        >
          Save
        </button>
      </div>
    </div>
  );
}

function PaymentList({ lead }: { lead: Lead }) {
  const payments = lead.financing?.payments ?? [];
  return (
    <div className="mt-4">
      <p className="field-label mb-2">Payment History</p>
      {payments.length === 0 ? (
        <p className="font-type text-xs text-pad-inkSoft">No payments yet.</p>
      ) : (
        <ul className="space-y-1 font-type text-sm">
          {[...payments].reverse().map((p) => (
            <li
              key={p.id}
              className="flex items-center justify-between rounded-md bg-white/70 px-3 py-2"
            >
              <span>
                {fmtMoney(p.amount)}{' '}
                <span className="text-xs text-pad-inkSoft">
                  · {p.method}
                </span>
              </span>
              <span className="text-xs text-pad-inkSoft">
                {new Date(p.date).toLocaleDateString()}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function AddPayment({ lead, disabled }: { lead: Lead; disabled?: boolean }) {
  const [amount, setAmount] = useState('');
  const [method, setMethod] = useState<Payment['method']>('card');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const submit = async () => {
    setBusy(true);
    setMsg(null);
    const res = await recordPayment(lead, {
      amount: parseFloat(amount) || 0,
      method,
    });
    setBusy(false);
    if (!res.ok) {
      setMsg(res.error || 'Payment failed');
      return;
    }
    setAmount('');
    setMsg('Payment recorded');
  };

  return (
    <div className="mt-4 rounded-lg bg-white/60 p-3">
      <p className="field-label mb-2">Record Payment</p>
      <div className="flex flex-wrap items-center gap-2 font-type text-sm">
        <input
          type="number"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          placeholder="Amount"
          className="w-28 rounded-md border border-black/10 bg-white p-2"
        />
        <select
          value={method}
          onChange={(e) => setMethod(e.target.value as Payment['method'])}
          className="rounded-md border border-black/10 bg-white p-2"
        >
          {PAYMENT_METHODS.map((m) => (
            <option key={m.value} value={m.value}>
              {m.label}
            </option>
          ))}
        </select>
        <button
          className="btn bg-emerald-600 text-white"
          disabled={busy || disabled}
          onClick={submit}
        >
          {busy ? 'Saving…' : 'Record'}
        </button>
      </div>
      {disabled && (
        <p className="mt-2 font-type text-xs text-pad-red">
          Resolve the court date above before recording payment.
        </p>
      )}
      {msg && <p className="mt-2 break-all font-type text-xs text-pad-inkSoft">{msg}</p>}
    </div>
  );
}
