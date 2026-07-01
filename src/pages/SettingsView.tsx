import { useState } from 'react';
import { checkInboxNow, inboxCheckConfigured } from '../lib/inbox';

export function SettingsView() {
  return (
    <div className="mx-auto max-w-2xl">
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
    </div>
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
