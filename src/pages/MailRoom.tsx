import { useMemo, useState } from 'react';
import { httpsCallable } from 'firebase/functions';
import { formatDistanceToNow } from 'date-fns';
import { functions } from '../firebase';
import { useLetters } from '../store/useLetters';
import { useUI } from '../store/useUI';
import { notify } from '../store/useToast';
import type { Letter } from '../types';

// The Mail Room — the review queue for the PostGrid letter program.
//
// The daily mailSweep proposes letters (it can only suggest); every physical
// letter requires a human clicking "Approve & Mail" here. Approval re-checks
// the lead's live state server-side, so a letter whose moment has passed
// (retained an hour ago, court date moved) bounces with the reason instead
// of mailing.

type Tab = 'proposed' | 'sent' | 'history';

const TYPE_TONE: Record<Letter['type'], string> = {
  court_passed: 'bg-red-600/15 text-red-800',
  motions_late: 'bg-orange-600/15 text-orange-800',
  motions: 'bg-sky-600/15 text-sky-800',
  court_week: 'bg-emerald-600/15 text-emerald-800',
  thinking: 'bg-violet-600/15 text-violet-800',
  second_chase: 'bg-amber-600/15 text-amber-800',
  intro: 'bg-amber-600/15 text-amber-800',
};

export function MailRoom() {
  const letters = useLetters();
  const selectLead = useUI((s) => s.selectLead);
  const [tab, setTab] = useState<Tab>('proposed');
  const [busy, setBusy] = useState<string | null>(null);

  const { proposed, sent, history } = useMemo(() => {
    const proposed = letters.filter((l) => l.status === 'proposed');
    const sent = letters.filter(
      (l) => l.status === 'sent' || l.status === 'delivered' || l.status === 'returned',
    );
    const history = letters.filter((l) => l.status === 'skipped' || l.status === 'blocked');
    return { proposed, sent, history };
  }, [letters]);

  const decide = async (letter: Letter, action: 'approve' | 'skip') => {
    if (busy) return;
    setBusy(letter.id);
    try {
      const fn = httpsCallable(functions, 'decideLetter');
      const res = await fn({ letterId: letter.id, action });
      const data = res.data as { ok: boolean; status: string; testMode?: boolean };
      if (action === 'approve') {
        notify.success(
          data.testMode
            ? `Letter created in PostGrid TEST mode (nothing physically mails).`
            : `Letter to ${letter.leadName} is on its way to the printer.`,
        );
      }
    } catch (e) {
      notify.error(e instanceof Error ? e.message : 'Could not update the letter.');
    } finally {
      setBusy(null);
    }
  };

  const list = tab === 'proposed' ? proposed : tab === 'sent' ? sent : history;

  return (
    <div>
      <header className="mb-6">
        <h1 className="font-hand text-4xl text-white">Mail Room</h1>
        <p className="text-manila/70 text-sm">
          Physical letters proposed by the system — nothing mails without your approval
        </p>
      </header>

      <div className="mb-4 flex gap-2">
        {(
          [
            ['proposed', `To Approve (${proposed.length})`],
            ['sent', `Mailed (${sent.length})`],
            ['history', `Skipped / Blocked (${history.length})`],
          ] as [Tab, string][]
        ).map(([t, label]) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`rounded-full px-4 py-1.5 font-type text-sm font-semibold transition ${
              tab === t ? 'bg-manila text-pad-ink' : 'bg-white/10 text-manila/70 hover:bg-white/20'
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {list.length === 0 ? (
        <p className="rounded-2xl bg-black/20 p-8 text-center font-hand text-2xl text-manila/50">
          {tab === 'proposed'
            ? 'No letters waiting — the morning sweep proposes them as leads hit their milestones.'
            : 'Nothing here yet.'}
        </p>
      ) : (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          {list.map((l) => (
            <div key={l.id} className="rounded-2xl bg-manila/95 p-4 shadow-card">
              <div className="flex items-start justify-between gap-2">
                <button
                  className="text-left font-type text-base font-bold text-pad-ink hover:underline"
                  title="Open the lead's file"
                  onClick={() => selectLead(l.leadId)}
                >
                  {l.leadName}
                </button>
                <span
                  className={`shrink-0 rounded-full px-2 py-0.5 font-type text-[10px] font-bold uppercase tracking-wide ${TYPE_TONE[l.type]}`}
                >
                  {l.label}
                </span>
              </div>
              <p className="mt-0.5 font-type text-[11px] text-pad-inkSoft">
                {l.to.line1}, {l.to.city}, {l.to.provinceOrState} {l.to.postalOrZip}
              </p>

              <p className="mt-2 rounded-md bg-black/5 px-2 py-1.5 font-type text-[11px] italic text-pad-inkSoft">
                Why: {l.reason}
              </p>

              <LetterBody preview={l.preview} />

              <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
                <span className="font-type text-[11px] text-pad-inkSoft/60">
                  {l.status === 'proposed' && `proposed ${formatDistanceToNow(l.proposedAt, { addSuffix: true })}`}
                  {(l.status === 'sent' || l.status === 'delivered') &&
                    `mailed ${l.sentAt ? formatDistanceToNow(l.sentAt, { addSuffix: true }) : ''} by ${l.decidedBy ?? '—'}`}
                  {l.status === 'returned' && '↩ returned undeliverable — fix the address'}
                  {l.status === 'skipped' && `skipped by ${l.decidedBy ?? '—'}`}
                  {l.status === 'blocked' && `blocked — ${l.blockedReason ?? 'no longer eligible'}`}
                </span>
                <span className="flex items-center gap-2">
                  {l.testMode && (
                    <span className="rounded-full bg-sky-600/15 px-2 py-0.5 font-type text-[10px] font-bold uppercase text-sky-800">
                      test mode
                    </span>
                  )}
                  {l.status === 'delivered' && (
                    <span className="rounded-full bg-emerald-600/15 px-2 py-0.5 font-type text-[10px] font-bold uppercase text-emerald-800">
                      delivered
                    </span>
                  )}
                  {l.status === 'proposed' && (
                    <>
                      <button
                        disabled={busy === l.id}
                        onClick={() => void decide(l, 'skip')}
                        className="rounded-md border border-pad-ink/20 px-3 py-1.5 font-type text-xs font-semibold text-pad-inkSoft transition hover:bg-black/10 disabled:opacity-50"
                      >
                        Skip
                      </button>
                      <button
                        disabled={busy === l.id}
                        onClick={() => void decide(l, 'approve')}
                        className="rounded-md bg-emerald-700 px-3 py-1.5 font-type text-xs font-bold text-white transition hover:bg-emerald-600 disabled:opacity-50"
                      >
                        {busy === l.id ? 'Mailing…' : 'Approve & Mail'}
                      </button>
                    </>
                  )}
                </span>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// The letter text, collapsed to a few lines until expanded — the reviewer
// sees exactly the words that will print.
function LetterBody({ preview }: { preview: string }) {
  const [open, setOpen] = useState(false);
  return (
    <button
      type="button"
      onClick={() => setOpen((v) => !v)}
      title={open ? 'Collapse' : 'Read the full letter'}
      className="mt-2 block w-full text-left"
    >
      <p
        className={`whitespace-pre-line font-type text-xs leading-relaxed text-pad-ink ${
          open ? '' : 'line-clamp-4'
        }`}
      >
        {preview}
      </p>
      <span className="font-type text-[10px] font-bold uppercase tracking-wide text-pad-inkSoft/60">
        {open ? '▲ collapse' : '▼ full letter'}
      </span>
    </button>
  );
}
