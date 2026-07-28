import { useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { httpsCallable } from 'firebase/functions';
import { functions } from '../firebase';
import { useMessages } from '../store/useMessages';

// "Ask Question" slide-out for a system post-it: a big post-it note that
// slides in from the right and holds a grounded Q&A chat about whatever was
// behind the note (the askPostIt callable assembles the full context server-
// side). The conversation renders from the live message doc — the board's
// existing Firestore subscription streams each answered turn straight in, so
// there is no second listener here.

function fmtWhen(ms: number): string {
  const d = new Date(ms);
  const time = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }).toLowerCase();
  return `${d.toLocaleDateString('en-US', { weekday: 'short', month: 'numeric', day: 'numeric' })} · ${time}`;
}

export function AskPostItDrawer({
  msgId,
  open,
  onClose,
}: {
  msgId: string;
  open: boolean;
  onClose: () => void;
}) {
  // Live doc via the board's existing subscription.
  const msg = useMessages().find((m) => m.id === msgId);
  const [draft, setDraft] = useState('');
  // The just-sent question, echoed locally until the server writes both turns
  // onto the doc (the subscription then takes over rendering them).
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const qa = msg?.qa ?? [];

  // Esc closes (matching the Drawer/Modal shells).
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  // Newest messages anchor at the bottom: jump there on open, glide on updates.
  useEffect(() => {
    if (!open) return;
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [open]);
  useEffect(() => {
    if (!open) return;
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [open, qa.length, pending]);

  const send = async () => {
    const question = draft.trim();
    if (!question || pending !== null || !msg) return;
    setDraft('');
    setError(null);
    setPending(question);
    try {
      const fn = httpsCallable(functions, 'askPostIt');
      await fn({ messageId: msg.id, question });
      // The answered turns arrive via the live subscription; drop the echo.
      setPending(null);
    } catch (e) {
      setPending(null);
      setDraft(question); // don't lose what they typed
      setError(e instanceof Error ? e.message : 'Something went wrong — try again.');
    }
    inputRef.current?.focus();
  };

  return (
    <AnimatePresence>
      {open && msg && (
        <motion.div
          className="fixed inset-0 z-50 flex justify-end bg-black/50"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          onMouseDown={onClose}
        >
          <motion.aside
            className="flex h-full w-full max-w-md flex-col shadow-2xl"
            style={{ background: 'linear-gradient(180deg, #fff9a8 0%, #fdf07e 100%)' }}
            initial={{ x: '100%' }}
            animate={{ x: 0 }}
            exit={{ x: '100%' }}
            transition={{ type: 'spring', stiffness: 320, damping: 34 }}
            onMouseDown={(e) => e.stopPropagation()}
          >
            {/* Header: what note this conversation is about. */}
            <header className="relative border-b border-yellow-950/15 px-5 pb-4 pt-5">
              {/* tape strip, like the small notes on the desk */}
              <span className="absolute -top-0.5 left-1/2 h-4 w-20 -translate-x-1/2 rotate-1 bg-white/40 shadow-sm" />
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="font-type text-[10px] font-bold uppercase tracking-widest text-yellow-950/60">
                    Ask about this note
                  </p>
                  <h2 className="mt-1 font-hand text-2xl leading-tight text-yellow-950">
                    {msg.subject || msg.message.slice(0, 80)}
                  </h2>
                  <p className="mt-1 font-type text-[11px] text-yellow-950/60">
                    {msg.fromName || 'TVC'} · {fmtWhen(msg.receivedAt)}
                  </p>
                </div>
                <button
                  type="button"
                  aria-label="Close"
                  onClick={onClose}
                  className="rounded-md px-2 py-1 font-type text-lg font-bold text-yellow-950/50 hover:bg-black/10 hover:text-yellow-950"
                >
                  ✕
                </button>
              </div>
            </header>

            {/* Conversation: its own scroll frame, newest at the bottom. */}
            <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto px-5 py-4 scrollbar-thin">
              {qa.length === 0 && pending === null && (
                <p className="mt-6 text-center font-type text-xs leading-relaxed text-yellow-950/50">
                  Ask anything about this note — the answer is grounded in the
                  lead's full file, call history, and the records behind it.
                </p>
              )}
              <div className="flex flex-col gap-3">
                {qa.map((t, i) => (
                  <Bubble key={i} role={t.role} text={t.text} ts={t.ts} />
                ))}
                {pending !== null && (
                  <>
                    <Bubble role="user" text={pending} />
                    <div className="mr-auto max-w-[85%]">
                      <p className="animate-pulse px-1 font-hand text-lg text-blue-950/60">
                        thinking…
                      </p>
                    </div>
                  </>
                )}
              </div>
              {error && (
                <p className="mt-3 font-type text-xs font-semibold text-red-700">⚠ {error}</p>
              )}
            </div>

            {/* Input: Enter sends, Shift+Enter for a newline. */}
            <div className="border-t border-yellow-950/15 px-5 py-4">
              <div className="flex items-end gap-2">
                <textarea
                  ref={inputRef}
                  rows={2}
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.shiftKey) {
                      e.preventDefault();
                      void send();
                    }
                  }}
                  disabled={pending !== null}
                  placeholder="Ask a follow-up question…"
                  className="min-h-0 flex-1 resize-none rounded-md border border-yellow-950/20 bg-white/40 px-3 py-2 font-type text-sm text-yellow-950 placeholder:text-yellow-950/40 focus:border-yellow-950/40 focus:outline-none disabled:opacity-50"
                />
                <button
                  type="button"
                  onClick={() => void send()}
                  disabled={pending !== null || !draft.trim()}
                  className="rounded-md bg-yellow-950 px-4 py-2 font-type text-sm font-semibold text-yellow-100 transition enabled:hover:bg-yellow-900 disabled:opacity-40"
                >
                  {pending !== null ? '…' : 'Send'}
                </button>
              </div>
            </div>
          </motion.aside>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

// User turns read as pencil ink, the assistant's as blue pen — both in the
// post-it's handwriting. A turn without a timestamp is still in flight.
function Bubble({ role, text, ts }: { role: 'user' | 'assistant'; text: string; ts?: number }) {
  const user = role === 'user';
  return (
    <div className={`max-w-[85%] ${user ? 'ml-auto' : 'mr-auto'}`}>
      <div
        className={`rounded-lg px-3 py-2 shadow-sm ${
          user ? 'bg-black/10' : 'bg-white/45 ring-1 ring-blue-900/10'
        }`}
      >
        <p
          className={`whitespace-pre-wrap font-hand text-lg leading-snug ${
            user ? 'text-yellow-950' : 'text-blue-950'
          }`}
        >
          {text}
        </p>
      </div>
      <p
        className={`mt-0.5 px-1 font-type text-[9px] uppercase tracking-wide text-yellow-950/40 ${
          user ? 'text-right' : ''
        }`}
      >
        {user ? 'you' : 'assistant'} · {ts ? fmtWhen(ts) : 'sending…'}
      </p>
    </div>
  );
}
