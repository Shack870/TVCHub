import { useMemo, useRef, useState } from 'react';
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
//
// Each card can also PREVIEW the final rendered page (the server renders it
// with the exact same code approval uses) and EDIT the letter's text —
// saved edits are what physically mails.

type Tab = 'proposed' | 'sent' | 'history';

// Urgency order for Approve All's duplicate-lead handling. Mirrors the
// priority map in proposeLetter (functions/src/mailEngine.ts) — that map is
// the source of truth. Lower number = more urgent.
const LETTER_PRIORITY: Record<Letter['type'], number> = {
  court_passed: 0,
  motions_late: 1,
  motions: 2,
  court_week: 3,
  thinking: 4,
  second_chase: 5,
  intro: 6,
};

const TYPE_TONE: Record<Letter['type'], string> = {
  court_passed: 'bg-red-600/15 text-red-800',
  motions_late: 'bg-orange-600/15 text-orange-800',
  motions: 'bg-sky-600/15 text-sky-800',
  court_week: 'bg-emerald-600/15 text-emerald-800',
  thinking: 'bg-violet-600/15 text-violet-800',
  second_chase: 'bg-amber-600/15 text-amber-800',
  intro: 'bg-amber-600/15 text-amber-800',
};

interface PreviewState {
  letter: Letter;
  html: string;
}

export function MailRoom() {
  const letters = useLetters();
  const selectLead = useUI((s) => s.selectLead);
  const [tab, setTab] = useState<Tab>('proposed');
  const [busy, setBusy] = useState<string | null>(null);
  const [preview, setPreview] = useState<PreviewState | null>(null);
  const [previewing, setPreviewing] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);
  // Approve All: null = idle; otherwise a live progress counter.
  const [batch, setBatch] = useState<{ done: number; total: number } | null>(null);
  // Real letters cost real money — the button must be clicked twice.
  const [armed, setArmed] = useState(false);
  const armTimer = useRef<number | null>(null);

  const { proposed, sent, history } = useMemo(() => {
    const proposed = letters.filter((l) => l.status === 'proposed');
    const sent = letters.filter(
      (l) => l.status === 'sent' || l.status === 'delivered' || l.status === 'returned',
    );
    const history = letters.filter((l) => l.status === 'skipped' || l.status === 'blocked');
    return { proposed, sent, history };
  }, [letters]);

  const decide = async (letter: Letter, action: 'approve' | 'skip') => {
    if (busy || batch) return;
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

  // Arms the Approve All confirm step; disarms itself if not confirmed.
  const armApproveAll = () => {
    setArmed(true);
    if (armTimer.current) window.clearTimeout(armTimer.current);
    armTimer.current = window.setTimeout(() => setArmed(false), 8000);
  };

  // Mails the whole To Approve queue, one decideLetter call at a time
  // (sequential on purpose: PostGrid rate limits, Firestore contention).
  // A lead with multiple proposed letters gets only its most urgent one;
  // the rest are skipped so nobody receives two letters the same day.
  // Individual failures (blocked at re-check, bad address) never stop the
  // run — they're collected and summarized at the end.
  const approveAll = async () => {
    if (batch) return;
    setArmed(false);
    if (armTimer.current) window.clearTimeout(armTimer.current);
    const queue = proposed;
    if (!queue.length) return;
    setBatch({ done: 0, total: queue.length });

    const byLead = new Map<string, Letter[]>();
    for (const l of queue) {
      byLead.set(l.leadId, [...(byLead.get(l.leadId) ?? []), l]);
    }
    const tasks: { letter: Letter; action: 'approve' | 'skip' }[] = [];
    for (const group of byLead.values()) {
      group.sort((a, b) => LETTER_PRIORITY[a.type] - LETTER_PRIORITY[b.type]);
      group.forEach((letter, i) => tasks.push({ letter, action: i === 0 ? 'approve' : 'skip' }));
    }

    const fn = httpsCallable(functions, 'decideLetter');
    let mailed = 0;
    let dupSkipped = 0;
    const failures: string[] = [];
    let done = 0;
    for (const t of tasks) {
      try {
        await fn({ letterId: t.letter.id, action: t.action });
        if (t.action === 'approve') mailed++;
        else dupSkipped++;
      } catch (e) {
        failures.push(e instanceof Error ? e.message : 'unknown error');
      }
      done++;
      setBatch({ done, total: tasks.length });
    }
    setBatch(null);

    const parts = [`${mailed} mailed`];
    if (dupSkipped) {
      parts.push(`${dupSkipped} duplicate${dupSkipped === 1 ? '' : 's'} for the same lead auto-skipped`);
    }
    if (failures.length) {
      const counts = new Map<string, number>();
      for (const f of failures) counts.set(f, (counts.get(f) ?? 0) + 1);
      const top = [...counts.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 2)
        .map(([msg, n]) => `${msg.length > 110 ? `${msg.slice(0, 110)}…` : msg}${n > 1 ? ` (×${n})` : ''}`);
      parts.push(`${failures.length} not mailed — ${top.join('; ')}`);
      notify.error(`Approve All finished: ${parts.join(' · ')}`);
    } else {
      notify.success(`Approve All finished: ${parts.join(' · ')}.`);
    }
  };

  // Renders the final page server-side (same renderer approval uses).
  // Pass bodyText to preview unsaved edits.
  const openPreview = async (letter: Letter, bodyText?: string) => {
    if (previewing) return;
    setPreviewing(letter.id);
    try {
      const fn = httpsCallable(functions, 'previewLetter');
      const res = await fn({ letterId: letter.id, ...(bodyText != null ? { bodyText } : {}) });
      const data = res.data as { ok: boolean; html: string; bodyText: string };
      setPreview({ letter, html: data.html });
    } catch (e) {
      notify.error(e instanceof Error ? e.message : 'Could not build the preview.');
    } finally {
      setPreviewing(null);
    }
  };

  const startEdit = async (letter: Letter) => {
    if (letter.bodyText) {
      setEditingId(letter.id);
      setDraft(letter.bodyText);
      return;
    }
    // Letters proposed before the edit feature lack bodyText — the preview
    // callable returns the server-generated editable text.
    setPreviewing(letter.id);
    try {
      const fn = httpsCallable(functions, 'previewLetter');
      const res = await fn({ letterId: letter.id });
      const data = res.data as { ok: boolean; html: string; bodyText: string };
      setEditingId(letter.id);
      setDraft(data.bodyText);
    } catch (e) {
      notify.error(e instanceof Error ? e.message : 'Could not load the letter text.');
    } finally {
      setPreviewing(null);
    }
  };

  const saveAndPreview = async (letter: Letter) => {
    if (saving) return;
    setSaving(true);
    try {
      const fn = httpsCallable(functions, 'saveLetterText');
      await fn({ letterId: letter.id, bodyText: draft });
      notify.success('Letter text saved — this is what will mail.');
      setEditingId(null);
      await openPreview(letter, draft);
    } catch (e) {
      notify.error(e instanceof Error ? e.message : 'Could not save the letter text.');
    } finally {
      setSaving(false);
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

      <div className="mb-4 flex flex-wrap items-center gap-2">
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
        {tab === 'proposed' && proposed.length > 0 && (
          <span className="ml-auto flex items-center gap-2">
            {armed && !batch && (
              <button
                onClick={() => setArmed(false)}
                className="rounded-full px-3 py-1.5 font-type text-sm font-semibold text-manila/70 transition hover:bg-white/10"
              >
                Cancel
              </button>
            )}
            <button
              disabled={!!batch}
              onClick={() => (armed ? void approveAll() : armApproveAll())}
              title="Mail every letter in the queue — each one still gets the live eligibility re-check"
              className={`rounded-full px-4 py-1.5 font-type text-sm font-bold text-white transition disabled:opacity-60 ${
                armed && !batch
                  ? 'bg-red-700 hover:bg-red-600'
                  : 'bg-emerald-700 hover:bg-emerald-600'
              }`}
            >
              {batch
                ? `Mailing ${batch.done}/${batch.total}…`
                : armed
                  ? `Mail all ${proposed.length} letters — click again to confirm`
                  : `Approve All (${proposed.length})`}
            </button>
          </span>
        )}
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

              {editingId === l.id ? (
                <div className="mt-2">
                  <textarea
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    rows={14}
                    className="w-full rounded-md border border-pad-ink/20 bg-white/70 p-2 font-type text-xs leading-relaxed text-pad-ink focus:outline-none focus:ring-1 focus:ring-emerald-700"
                  />
                  <p className="mt-1 font-type text-[10px] text-pad-inkSoft/70">
                    Blank line = new paragraph · **text** prints bold · a paragraph starting with
                    "P.S." prints below the signature · keep the [[COURT DATE BOX]] line where the
                    boxed court date should sit. Date, greeting, signature, and the legal footer are
                    automatic.
                  </p>
                  <div className="mt-2 flex justify-end gap-2">
                    <button
                      disabled={saving}
                      onClick={() => setEditingId(null)}
                      className="rounded-md border border-pad-ink/20 px-3 py-1.5 font-type text-xs font-semibold text-pad-inkSoft transition hover:bg-black/10 disabled:opacity-50"
                    >
                      Cancel
                    </button>
                    <button
                      disabled={saving}
                      onClick={() => void saveAndPreview(l)}
                      className="rounded-md bg-pad-ink px-3 py-1.5 font-type text-xs font-bold text-manila transition hover:bg-pad-ink/80 disabled:opacity-50"
                    >
                      {saving ? 'Saving…' : 'Save & Preview'}
                    </button>
                  </div>
                </div>
              ) : (
                <LetterBody preview={l.preview} />
              )}

              <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
                <span className="font-type text-[11px] text-pad-inkSoft/60">
                  {l.status === 'proposed' && `proposed ${formatDistanceToNow(l.proposedAt, { addSuffix: true })}`}
                  {(l.status === 'sent' || l.status === 'delivered') &&
                    `mailed ${l.sentAt ? formatDistanceToNow(l.sentAt, { addSuffix: true }) : ''} by ${l.decidedBy ?? '—'}`}
                  {l.status === 'returned' && '↩ returned undeliverable — fix the address'}
                  {l.status === 'skipped' && `skipped by ${l.decidedBy ?? '—'}`}
                  {l.status === 'blocked' && `blocked — ${l.blockedReason ?? 'no longer eligible'}`}
                </span>
                <span className="flex flex-wrap items-center justify-end gap-2">
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
                  {l.status !== 'proposed' && l.previewUrl && (
                    <a
                      href={l.previewUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="rounded-md border border-pad-ink/20 px-3 py-1.5 font-type text-xs font-semibold text-pad-inkSoft transition hover:bg-black/10"
                      title="The PDF PostGrid printed and mailed"
                    >
                      View PDF
                    </a>
                  )}
                  {l.status === 'proposed' && (
                    <>
                      <button
                        disabled={previewing === l.id}
                        onClick={() => void openPreview(l, editingId === l.id ? draft : undefined)}
                        title="See the final printed page, exactly as it will mail"
                        className="rounded-md border border-pad-ink/20 px-3 py-1.5 font-type text-xs font-semibold text-pad-inkSoft transition hover:bg-black/10 disabled:opacity-50"
                      >
                        {previewing === l.id ? 'Rendering…' : 'Preview Letter'}
                      </button>
                      {editingId !== l.id && (
                        <button
                          disabled={previewing === l.id}
                          onClick={() => void startEdit(l)}
                          title="Change the letter's wording before it mails"
                          className="rounded-md border border-pad-ink/20 px-3 py-1.5 font-type text-xs font-semibold text-pad-inkSoft transition hover:bg-black/10 disabled:opacity-50"
                        >
                          Edit Text
                        </button>
                      )}
                      <button
                        disabled={busy === l.id || !!batch}
                        onClick={() => void decide(l, 'skip')}
                        className="rounded-md border border-pad-ink/20 px-3 py-1.5 font-type text-xs font-semibold text-pad-inkSoft transition hover:bg-black/10 disabled:opacity-50"
                      >
                        Skip
                      </button>
                      <button
                        disabled={busy === l.id || !!batch}
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

      {preview && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4"
          onClick={() => setPreview(null)}
        >
          <div
            className="flex max-h-full flex-col overflow-hidden rounded-lg bg-white shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between gap-4 border-b border-black/10 px-4 py-2">
              <p className="font-type text-sm font-bold text-pad-ink">
                {preview.letter.label} — {preview.letter.leadName}
              </p>
              <button
                onClick={() => setPreview(null)}
                className="rounded-md px-2 py-1 font-type text-xs font-semibold text-pad-inkSoft hover:bg-black/10"
              >
                ✕ Close
              </button>
            </div>
            {/* The white frame stands in for the printer's 0.5in page margin;
                the letter HTML carries its own inner padding. */}
            <div className="overflow-auto bg-neutral-300 p-4">
              <div className="mx-auto bg-white p-[0.5in] shadow-lg" style={{ width: 'min(88vw, 816px)' }}>
                <iframe
                  srcDoc={preview.html}
                  title="Letter preview"
                  sandbox=""
                  className="h-[75vh] w-full border-0 bg-white"
                />
              </div>
            </div>
          </div>
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
