import { useEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { useLeads } from '../store/useLeads';
import { useUI } from '../store/useUI';
import { isInitialLead, isPipelineLead } from '../lib/leadFlow';
import { isBillingNote, isSystemNote } from '../lib/notes';
import { sendToInitialLeads } from '../lib/actions';
import { daysUntilCourt } from '../lib/dates';
import type { Lead } from '../types';
import { NotepadCard } from '../components/NotepadCard';
import { MessagePostIt } from '../components/MessagePostIt';
import { useMessages } from '../store/useMessages';
import { Badge } from '../components/ui/Badge';
import { ConfirmDialog } from '../components/ui/ConfirmDialog';

type View = 'grid' | 'focus';
type Sort = 'court' | 'newest';
type Scope = 'initial' | 'pipeline';

// Court urgency: overdue (negative) and soonest first; no-date leads sink last.
function courtRank(l: Lead): number {
  const d = daysUntilCourt(l);
  return d === null ? Number.POSITIVE_INFINITY : d;
}

// When the lead last demanded attention — a TVC re-send bumps it back to the
// top of "Newest" even though the card keeps its original arrival stamp.
function appearedAt(l: Lead): number {
  return Math.max(l.lastReferralAt ?? 0, l.receivedAt ?? l.createdAt);
}

function matches(l: Lead, q: string): boolean {
  if (!q) return true;
  const hay = [l.name, l.phone, l.tvcCaseNumber, l.courtName, l.county, l.charge]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
  return hay.includes(q.toLowerCase());
}

// A folder-style tab for the post-it stacks. The unhandled count rides in a
// pill; a gold pill means an uncollected-money escalation is waiting inside.
function NoteTab({
  label,
  open,
  active,
  onClick,
  gold = false,
}: {
  label: string;
  open: number;
  active: boolean;
  onClick: () => void;
  gold?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded-t-lg px-4 py-2 font-type text-[11px] font-bold uppercase tracking-widest transition-colors ${
        active
          ? 'bg-black/25 text-manila shadow-inner ring-1 ring-white/10'
          : 'text-manila/45 hover:bg-black/10 hover:text-manila/70'
      }`}
    >
      {label}
      {open > 0 && (
        <span
          className={`ml-2 rounded-full px-2 py-0.5 text-[10px] font-black ${
            gold
              ? 'animate-pulse bg-gradient-to-b from-amber-300 to-amber-500 text-amber-950'
              : 'bg-yellow-400 text-yellow-950'
          }`}
        >
          {open}
        </span>
      )}
    </button>
  );
}

export function NotepadBoard({ embedded = false }: { embedded?: boolean }) {
  const leads = useLeads();
  const selectLead = useUI((s) => s.selectLead);
  const openNewLead = useUI((s) => s.openNewLead);
  const [scope, setScope] = useState<Scope>('initial');
  const [view, setView] = useState<View>('grid');
  const [sort, setSort] = useState<Sort>('newest');
  const [query, setQuery] = useState('');
  const [sel, setSel] = useState(0);
  const [dir, setDir] = useState(1);
  const [backLead, setBackLead] = useState<Lead | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  // Notes stuck to the top of the desk, in two tabbed stacks: human messages
  // from TVC staff, and system-generated action items (billing escalations,
  // cadence decisions, missed calls). Unhandled ones stay until dealt with;
  // handled ones linger a week so you can see what was resolved.
  const allMessages = useMessages();
  const [noteTab, setNoteTab] = useState<'tvc' | 'action' | null>(null);
  const noteTabs = useMemo(() => {
    const weekAgo = Date.now() - 7 * 86400000;
    const visible = allMessages
      .filter((m) => !m.deletedAt)
      .filter((m) => !m.handled || (m.handledAt ?? m.updatedAt) > weekAgo)
      .sort((a, b) => {
        if (a.handled !== b.handled) return a.handled ? 1 : -1;
        // Within unhandled: no-pursuit alarms first, then billing, then newest.
        if (!a.handled) {
          const rank = (m: typeof a) =>
            isBillingNote(m) && m.noPursuit ? 2 : isBillingNote(m) ? 1 : 0;
          const urgent = rank(b) - rank(a);
          if (urgent !== 0) return urgent;
        }
        return b.receivedAt - a.receivedAt;
      });
    const action = visible.filter(isSystemNote);
    const tvc = visible.filter((m) => !isSystemNote(m));
    return {
      action,
      tvc,
      actionOpen: action.filter((m) => !m.handled).length,
      tvcOpen: tvc.filter((m) => !m.handled).length,
    };
  }, [allMessages]);
  // Until the user picks a tab, default to wherever the unhandled work is —
  // Action Items win when both tabs have open notes.
  const activeNoteTab =
    noteTab ??
    (noteTabs.actionOpen > 0
      ? 'action'
      : noteTabs.tvcOpen > 0
        ? 'tvc'
        : noteTabs.action.length > 0
          ? 'action'
          : 'tvc');
  const notes = activeNoteTab === 'action' ? noteTabs.action : noteTabs.tvc;

  const counts = useMemo(
    () => ({
      initial: leads.filter(isInitialLead).length,
      pipeline: leads.filter(isPipelineLead).length,
    }),
    [leads],
  );

  const board = useMemo(() => {
    const inScope = scope === 'initial' ? isInitialLead : isPipelineLead;
    const list = leads.filter(inScope).filter((l) => matches(l, query));
    return sort === 'court'
      ? [...list].sort((a, b) => courtRank(a) - courtRank(b))
      : [...list].sort((a, b) => appearedAt(b) - appearedAt(a));
  }, [leads, query, sort, scope]);

  const safeSel = Math.min(sel, Math.max(0, board.length - 1));
  const current = board[safeSel];

  const move = (delta: number) => {
    setDir(delta);
    setSel((i) => {
      const next = i + delta;
      if (next < 0) return board.length - 1;
      if (next >= board.length) return 0;
      return next;
    });
  };

  // Keyboard: works the stack like a real desk. Ignored while typing (except / and esc).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement;
      const typing = el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable;
      if (e.key === '/' && !typing) {
        e.preventDefault();
        searchRef.current?.focus();
        return;
      }
      if (e.key === 'Escape') {
        if (typing) (el as HTMLInputElement).blur();
        else if (view === 'focus') setView('grid');
        return;
      }
      if (typing) return;
      if (e.key === 'n') {
        e.preventDefault();
        openNewLead();
      } else if (e.key === 'f') {
        setView((v) => (v === 'grid' ? 'focus' : 'grid'));
      } else if (e.key === 'j' || e.key === 'ArrowDown') {
        e.preventDefault();
        move(1);
      } else if (e.key === 'k' || e.key === 'ArrowUp') {
        e.preventDefault();
        move(-1);
      } else if (e.key === 'Enter' && current) {
        selectLead(current.id, 'contact');
      } else if (e.key === 'c' && current?.phone) {
        window.location.href = `tel:${current.phone.replace(/[^\d+]/g, '')}`;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [board, current, view]);

  // Keep the selected grid card in view as you j/k through it.
  useEffect(() => {
    if (view === 'grid' && current) {
      document.getElementById(`card-${current.id}`)?.scrollIntoView({
        block: 'nearest',
        behavior: 'smooth',
      });
    }
  }, [safeSel, view, current]);

  const summary = (
    <p className="text-manila/70 text-sm">
      {board.length}
      {scope === 'initial'
        ? board.length === 1
          ? ' initial lead'
          : ' initial leads'
        : board.length === 1
          ? ' lead in the pipeline'
          : ' leads in the pipeline'}
      {query ? ' match' : scope === 'initial' ? ' · uncontacted' : ' · contacted, not retained'}
    </p>
  );
  const scopeToggle = (
    <Toggle
      options={[
        { id: 'initial', label: `Initial Leads${counts.initial ? ` (${counts.initial})` : ''}` },
        { id: 'pipeline', label: `Follow-Up Pipeline${counts.pipeline ? ` (${counts.pipeline})` : ''}` },
      ]}
      value={scope}
      onChange={(v) => {
        setScope(v as Scope);
        setSel(0);
      }}
    />
  );
  const controls = (
    <div className="flex flex-wrap items-center gap-2">
      <div className="relative">
        <input
          ref={searchRef}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search name, phone, court…  ( / )"
          className="data w-60 rounded-lg border border-white/10 bg-black/25 px-3 py-2 text-sm text-white placeholder:text-manila/40 focus:border-white/30 focus:outline-none"
        />
        {query && (
          <button
            onClick={() => setQuery('')}
            className="absolute right-2 top-1/2 -translate-y-1/2 text-manila/50 hover:text-white"
          >
            ✕
          </button>
        )}
      </div>
      <Toggle
        options={[
          { id: 'court', label: 'By Court' },
          { id: 'newest', label: 'Newest' },
        ]}
        value={sort}
        onChange={(v) => setSort(v as Sort)}
      />
      <Toggle
        options={[
          { id: 'grid', label: 'Grid' },
          { id: 'focus', label: 'Focus' },
        ]}
        value={view}
        onChange={(v) => setView(v as View)}
      />
      {!embedded && (
        <button className="btn-primary" onClick={openNewLead}>
          + New Lead
        </button>
      )}
    </div>
  );

  return (
    <div>
      {embedded ? (
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          {summary}
          {controls}
        </div>
      ) : (
        <header className="mb-5 flex flex-wrap items-end justify-between gap-4">
          <div>
            <h1 className="font-hand text-4xl text-white">The Desk</h1>
            {summary}
          </div>
          {controls}
        </header>
      )}

      <div className="mb-5">{scopeToggle}</div>

      {(noteTabs.tvc.length > 0 || noteTabs.action.length > 0) && (
        <section className="mb-7">
          <div className="mb-3 flex items-center gap-1">
            <NoteTab
              label="TVC Messages"
              open={noteTabs.tvcOpen}
              active={activeNoteTab === 'tvc'}
              onClick={() => setNoteTab('tvc')}
            />
            <NoteTab
              label="Action Items"
              open={noteTabs.actionOpen}
              active={activeNoteTab === 'action'}
              onClick={() => setNoteTab('action')}
              gold={noteTabs.action.some((m) => !m.handled && isBillingNote(m))}
            />
          </div>
          {notes.length === 0 ? (
            <p className="rounded-lg bg-black/15 px-4 py-6 font-type text-xs text-manila/50">
              {activeNoteTab === 'action'
                ? 'No action items on the desk.'
                : 'No messages from TVC on the desk.'}
            </p>
          ) : (
            // overflow stays visible so a flipped-up note can overlay the UI
            // above it instead of being clipped by a scroll container
            <div className="flex flex-wrap gap-5 pb-3 pt-2">
              {notes.map((m, i) => (
                <MessagePostIt key={m.id} msg={m} index={i} />
              ))}
            </div>
          )}
        </section>
      )}

      <ConfirmDialog
        open={backLead !== null}
        title="Send back to Initial Leads?"
        message={`Move ${backLead?.name ?? 'this lead'} back to Initial Leads (uncontacted). Warning: the Contact Log will be reset — all logged attempts and scheduled follow-ups for this lead will be cleared.`}
        confirmLabel="Yes, send back"
        cancelLabel="Cancel"
        tone="danger"
        onClose={() => setBackLead(null)}
        onConfirm={() => {
          if (backLead) sendToInitialLeads(backLead);
        }}
      />

      {board.length === 0 ? (
        query ? (
          <NoMatches onClear={() => setQuery('')} />
        ) : (
          <EmptyDesk onNew={openNewLead} scope={scope} />
        )
      ) : view === 'grid' ? (
        <>
          <div className="grid grid-cols-1 gap-6 sm:grid-cols-2 xl:grid-cols-3">
            {board.map((lead, i) => (
              <div
                key={lead.id}
                id={`card-${lead.id}`}
                className={`desk rounded-[20px] transition ${
                  i === safeSel ? 'ring-2 ring-amber-300/80' : ''
                }`}
              >
                <NotepadCard lead={lead} onOpen={() => selectLead(lead.id, 'contact')} />
                {scope === 'pipeline' && (
                  <div className="mt-2 flex justify-end">
                    <button
                      className="rounded-md bg-black/30 px-3 py-1.5 font-type text-xs font-semibold text-manila hover:bg-black/40 hover:text-white"
                      onClick={() => setBackLead(lead)}
                    >
                      → Send to Initial Leads
                    </button>
                  </div>
                )}
              </div>
            ))}
          </div>
          <KeyHints />
        </>
      ) : (
        <div className="mx-auto max-w-3xl">
          <div className="desk relative" style={{ perspective: 1400 }}>
            <AnimatePresence mode="popLayout" custom={dir}>
              <motion.div
                key={current?.id}
                custom={dir}
                initial={{ rotateY: dir > 0 ? 60 : -60, opacity: 0, x: dir * 80 }}
                animate={{ rotateY: 0, opacity: 1, x: 0 }}
                exit={{ rotateY: dir > 0 ? -60 : 60, opacity: 0, x: dir * -80 }}
                transition={{ type: 'spring', stiffness: 260, damping: 26 }}
                style={{ transformStyle: 'preserve-3d' }}
              >
                {current && (
                  <NotepadCard lead={current} big onOpen={() => selectLead(current.id, 'contact')} />
                )}
              </motion.div>
            </AnimatePresence>
          </div>

          {scope === 'pipeline' && current && (
            <div className="mt-3 flex justify-center">
              <button
                className="rounded-md bg-black/30 px-3 py-1.5 font-type text-xs font-semibold text-manila hover:bg-black/40 hover:text-white"
                onClick={() => setBackLead(current)}
              >
                → Send to Initial Leads
              </button>
            </div>
          )}

          <div className="mt-5 flex items-center justify-between">
            <button className="btn-ghost text-manila" onClick={() => move(-1)}>
              ‹ Prev
            </button>
            <Badge tone="neutral">
              File {safeSel + 1} of {board.length}
            </Badge>
            <button className="btn-ghost text-manila" onClick={() => move(1)}>
              Next ›
            </button>
          </div>
          <KeyHints />
        </div>
      )}
    </div>
  );
}

function Toggle({
  options,
  value,
  onChange,
}: {
  options: { id: string; label: string }[];
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <div className="flex rounded-lg bg-black/20 p-1">
      {options.map((o) => (
        <button
          key={o.id}
          onClick={() => onChange(o.id)}
          className={`rounded-md px-3 py-1.5 text-sm font-medium transition ${
            value === o.id ? 'bg-white/15 text-white' : 'text-manila/70'
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

function KeyHints() {
  return (
    <div className="mt-5 flex flex-wrap items-center gap-x-4 gap-y-1 text-manila/50">
      <span className="text-[11px] uppercase tracking-widest">Keys</span>
      <Hint k="j / k" label="move" />
      <Hint k="c" label="call" />
      <Hint k="enter" label="open file" />
      <Hint k="/" label="search" />
      <Hint k="f" label="focus mode" />
      <Hint k="n" label="new lead" />
    </div>
  );
}

function Hint({ k, label }: { k: string; label: string }) {
  return (
    <span className="flex items-center gap-1.5 text-[11px]">
      <span className="kbd">{k}</span>
      <span>{label}</span>
    </span>
  );
}

function NoMatches({ onClear }: { onClear: () => void }) {
  return (
    <div className="desk mx-auto max-w-xl">
      <div className="legal-pad rounded-lg p-10 pl-16 text-center shadow-card">
        <p className="font-hand text-3xl ink">Nothing matches that.</p>
        <p className="mt-2 font-type text-sm text-pad-inkSoft">
          No active files match your search.
        </p>
        <button className="btn-primary mt-5" onClick={onClear}>
          Clear search
        </button>
      </div>
    </div>
  );
}

function EmptyDesk({ onNew, scope }: { onNew: () => void; scope: Scope }) {
  return (
    <div className="desk mx-auto max-w-xl">
      <div className="legal-pad rounded-lg p-10 pl-16 text-center shadow-card">
        {scope === 'initial' ? (
          <>
            <p className="font-hand text-3xl ink">No new initial leads.</p>
            <p className="mt-2 font-type text-sm text-pad-inkSoft">
              Uncontacted TVC referrals land here automatically. Once you log a
              first attempt, they move to the Follow-Up Pipeline.
            </p>
            <button className="btn-primary mt-5" onClick={onNew}>
              + New Lead
            </button>
          </>
        ) : (
          <>
            <p className="font-hand text-3xl ink">Pipeline is empty.</p>
            <p className="mt-2 font-type text-sm text-pad-inkSoft">
              Leads appear here after you log a first contact attempt — these are
              contacted clients you haven't retained yet.
            </p>
          </>
        )}
      </div>
    </div>
  );
}
