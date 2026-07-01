import { useState } from 'react';
import { checkInboxNow, inboxCheckConfigured } from '../lib/inbox';
import {
  alertsEnabled,
  notificationPermission,
  requestNotificationPermission,
  setAlertsEnabled,
} from '../lib/leadAlerts';
import { useLeads } from '../store/useLeads';
import { notify } from '../store/useToast';
import { balanceOf, totalFeeOf } from '../lib/leadFlow';
import type { Lead } from '../types';

export function SettingsView() {
  return (
    <div className="mx-auto max-w-2xl space-y-5">
      <header className="mb-6">
        <h1 className="font-hand text-4xl text-white">Settings</h1>
        <p className="text-manila/70 text-sm">Manage intake and app preferences.</p>
      </header>

      <section className="rounded-xl border border-white/10 bg-black/20 p-5">
        <h2 className="font-type text-xs font-semibold uppercase tracking-widest text-manila/60">
          Lead intake
        </h2>
        <p className="mt-2 font-type text-sm text-manila/70">
          New TVC leads arrive automatically and appear on the desk on their own.
          Use this to pull the inbox right now instead of waiting for the next
          scan.
        </p>
        <div className="mt-4">
          <CheckInboxButton />
        </div>
      </section>

      <section className="rounded-xl border border-white/10 bg-black/20 p-5">
        <h2 className="font-type text-xs font-semibold uppercase tracking-widest text-manila/60">
          New-lead notifications
        </h2>
        <p className="mt-2 font-type text-sm text-manila/70">
          Get a pop-up in the app — and a desktop notification — the moment a new
          lead lands, so first calls go out fast.
        </p>
        <div className="mt-4">
          <NotificationSettings />
        </div>
      </section>

      <section className="rounded-xl border border-white/10 bg-black/20 p-5">
        <h2 className="font-type text-xs font-semibold uppercase tracking-widest text-manila/60">
          Data export
        </h2>
        <p className="mt-2 font-type text-sm text-manila/70">
          Download every lead currently loaded (including retained, completed,
          and lost) as a spreadsheet-ready CSV.
        </p>
        <div className="mt-4">
          <ExportCsvButton />
        </div>
      </section>
    </div>
  );
}

function NotificationSettings() {
  const [enabled, setEnabled] = useState(alertsEnabled);
  const [perm, setPerm] = useState(notificationPermission);

  const toggle = async () => {
    const next = !enabled;
    setAlertsEnabled(next);
    setEnabled(next);
    if (next) {
      const granted = await requestNotificationPermission();
      setPerm(notificationPermission());
      if (!granted && notificationPermission() !== 'unsupported') {
        notify.info(
          'In-app alerts are on. Allow notifications in your browser to also get desktop pop-ups.',
        );
      }
    }
  };

  return (
    <div className="space-y-2">
      <button
        onClick={toggle}
        className={`inline-flex items-center gap-2 rounded-lg px-4 py-2 font-type text-sm font-semibold text-white transition ${
          enabled ? 'bg-emerald-600 hover:bg-emerald-700' : 'bg-white/10 hover:bg-white/20'
        }`}
      >
        <span
          className={`inline-block h-2.5 w-2.5 rounded-full ${enabled ? 'bg-white' : 'bg-manila/40'}`}
        />
        {enabled ? 'Alerts on' : 'Alerts off'}
      </button>
      <p className="font-type text-xs text-manila/50">
        {perm === 'unsupported'
          ? 'This browser does not support desktop notifications; in-app alerts still work.'
          : perm === 'granted'
            ? 'Desktop notifications are allowed in this browser.'
            : perm === 'denied'
              ? 'Desktop notifications are blocked in the browser settings; in-app alerts still work.'
              : 'Desktop permission will be requested when alerts are on.'}
      </p>
    </div>
  );
}

function csvEscape(v: unknown): string {
  const s = String(v ?? '');
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function leadsToCsv(leads: Lead[]): string {
  const header = [
    'name', 'stage', 'tvcCaseNumber', 'phone', 'email', 'charge', 'courtName',
    'county', 'state', 'nextCourtDate', 'owner', 'source', 'receivedAt',
    'retainedAt', 'totalFee', 'paid', 'balance', 'contactAttempts',
    'lastContactAt', 'openFollowUps', 'lostReason', 'createdAt',
  ];
  const rows = leads.map((l) => {
    const attempts = l.contactAttempts ?? [];
    const last = attempts.length ? attempts[attempts.length - 1].ts : null;
    const paid = (l.financing?.payments ?? []).reduce((s, p) => s + p.amount, 0);
    const iso = (ms?: number | null) => (ms ? new Date(ms).toISOString() : '');
    return [
      l.name, l.stage, l.tvcCaseNumber, l.phone, l.email, l.charge, l.courtName,
      l.county, l.state, l.nextCourtDate, l.owner, l.source, iso(l.receivedAt),
      iso(l.retainedAt), totalFeeOf(l), paid, balanceOf(l), attempts.length,
      iso(last), (l.followUps ?? []).filter((f) => !f.done).length,
      l.lostReason, iso(l.createdAt),
    ]
      .map(csvEscape)
      .join(',');
  });
  return [header.join(','), ...rows].join('\n');
}

function ExportCsvButton() {
  const leads = useLeads();

  const download = () => {
    const csv = leadsToCsv(leads);
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `tvchub-leads-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
    notify.success(`Exported ${leads.length} leads.`);
  };

  return (
    <button
      onClick={download}
      className="inline-flex items-center justify-center gap-2 rounded-lg bg-white/10 px-4 py-2 font-type text-sm font-semibold text-white transition hover:bg-white/20"
    >
      Download CSV ({leads.length} leads)
    </button>
  );
}

// On-demand "pull new TVC leads now" — kicks the Apps Script inbox scan. New
// leads then arrive on their own through the realtime Firestore listener.
function CheckInboxButton() {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  if (!inboxCheckConfigured) {
    return (
      <p className="font-type text-sm text-amber-200/80">
        Not configured. Set <code className="text-amber-100">VITE_INBOX_CHECK_URL</code>{' '}
        and <code className="text-amber-100">VITE_INBOX_CHECK_TOKEN</code> to enable
        the on-demand inbox check.
      </p>
    );
  }

  const run = async () => {
    if (busy) return;
    setBusy(true);
    setMsg(null);
    const res = await checkInboxNow();
    setBusy(false);
    if (!res.ok) {
      setMsg('Check failed');
    } else if (res.unknown) {
      setMsg('Checked ✓');
    } else if ((res.ran ?? 0) > 0) {
      setMsg(`${res.ran} new ✓`);
    } else {
      setMsg('Up to date ✓');
    }
    setTimeout(() => setMsg(null), 5000);
  };

  return (
    <button
      onClick={run}
      disabled={busy}
      className="inline-flex items-center justify-center gap-2 rounded-lg bg-emerald-600 px-4 py-2 font-type text-sm font-semibold text-white transition hover:bg-emerald-700 disabled:opacity-60"
    >
      <RefreshIcon spinning={busy} />
      {busy ? 'Checking…' : msg ?? 'Check for new leads'}
    </button>
  );
}

function RefreshIcon({ spinning }: { spinning?: boolean }) {
  const url = 'https://api.iconify.design/lucide/refresh-cw.svg';
  return (
    <span
      aria-hidden
      className={`h-4 w-4 shrink-0 bg-current ${spinning ? 'animate-spin' : ''}`}
      style={{
        maskImage: `url(${url})`,
        WebkitMaskImage: `url(${url})`,
        maskSize: 'contain',
        WebkitMaskSize: 'contain',
        maskRepeat: 'no-repeat',
        WebkitMaskRepeat: 'no-repeat',
        maskPosition: 'center',
        WebkitMaskPosition: 'center',
      }}
    />
  );
}
