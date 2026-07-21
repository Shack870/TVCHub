import { useState } from 'react';
import { motion } from 'framer-motion';
import type { TvcMessage } from '../types';
import { isBillingNote } from '../lib/notes';
import { archiveMessage, setMessageHandled } from '../lib/db';
import { useAuth } from '../context/AuthContext';
import { Modal } from './ui/Modal';

function fmtWhen(ms: number): string {
  const d = new Date(ms);
  const time = `${d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }).toLowerCase()}`;
  return `${d.toLocaleDateString('en-US', { weekday: 'short', month: 'numeric', day: 'numeric' })} · ${time}`;
}

// A ringing-phone glyph that wiggles while the missed call is unhandled.
function RingingPhone({ still = false }: { still?: boolean }) {
  return (
    <motion.span
      className="inline-block text-yellow-950"
      animate={still ? undefined : { rotate: [-12, 12, -12] }}
      transition={still ? undefined : { duration: 0.5, repeat: Infinity, repeatDelay: 1.6 }}
      aria-hidden
    >
      <svg viewBox="0 0 24 24" fill="currentColor" className="h-4 w-4">
        <path d="M6.6 10.8c1.4 2.8 3.8 5.1 6.6 6.6l2.2-2.2c.3-.3.7-.4 1-.2 1.2.4 2.4.6 3.7.6.6 0 1 .4 1 1V20c0 .6-.4 1-1 1C10.6 21 3 13.4 3 4c0-.6.4-1 1-1h3.5c.6 0 1 .4 1 1 0 1.2.2 2.5.6 3.7.1.3 0 .7-.2 1l-2.3 2.1z" />
      </svg>
    </motion.span>
  );
}

// A note stuck to the Desk: either a human message from TVC staff or a
// CallRail-detected missed call. Clicking opens a popup to mark it Handled.
export function MessagePostIt({ msg, index = 0 }: { msg: TvcMessage; index?: number }) {
  const [open, setOpen] = useState(false);
  const { user } = useAuth();

  const missedCall = msg.kind === 'missed_call';
  // Uncollected-money escalation — gold, matching the SAID YES ribbon on cards.
  const billing = isBillingNote(msg);
  const paper = billing
    ? 'linear-gradient(180deg, #ffe08a 0%, #f2b13c 100%)'
    : 'linear-gradient(180deg, #fff9a8 0%, #fdf07e 100%)';

  // Alternate a slight tilt so a row of notes looks hand-stuck, not printed.
  const tilt = index % 2 === 0 ? '-rotate-1' : 'rotate-1';

  const statusChip = msg.handled ? (
    <span className="rounded-full bg-emerald-600 px-2.5 py-0.5 font-type text-[10px] font-bold uppercase tracking-wide text-white shadow-sm">
      Handled
    </span>
  ) : (
    <span
      className={`rounded-full px-2.5 py-0.5 font-type text-[10px] font-bold uppercase tracking-wide shadow-sm ${
        billing ? 'bg-amber-900 text-amber-100' : 'bg-yellow-400 text-yellow-950'
      } ${missedCall || billing ? 'animate-pulseRing' : ''}`}
    >
      Unhandled
    </span>
  );

  return (
    <>
      <motion.button
        type="button"
        onClick={() => setOpen(true)}
        whileHover={{ y: -3, rotate: 0 }}
        transition={{ duration: 0.12 }}
        className={`relative block w-64 shrink-0 cursor-pointer text-left ${tilt} ${
          billing && !msg.handled ? 'ring-2 ring-amber-500/80' : ''
        }`}
        style={{
          background: paper,
          boxShadow: '2px 4px 10px rgba(0,0,0,0.35)',
        }}
      >
        {/* tape strip — red for a missed call, gold for money on the table */}
        <span
          className={`absolute -top-2 left-1/2 h-4 w-16 -translate-x-1/2 rotate-2 shadow-sm ${
            missedCall ? 'bg-red-400/50' : billing ? 'bg-amber-500/60' : 'bg-white/40'
          }`}
        />
        {/* diagonal rubber stamp, like the card "Contact Overdue" oversight stamp */}
        {missedCall && !msg.handled && (
          <span className="stamp pointer-events-none absolute right-2 top-9 -rotate-12 text-[11px] text-pad-red">
            Missed Call
          </span>
        )}
        {billing && !msg.handled && (
          <span className="stamp pointer-events-none absolute right-2 top-9 -rotate-12 text-[11px] text-amber-900">
            $ Collect
          </span>
        )}
        <div className="p-4 pb-3">
          <div className="flex items-start justify-between gap-2">
            <p className="flex items-center gap-1.5 font-type text-[11px] font-bold uppercase tracking-wide text-yellow-950/80">
              {missedCall && <RingingPhone still={msg.handled} />}
              {msg.fromName || 'TVC'}
            </p>
            {statusChip}
          </div>
          <p className="font-type text-[10px] text-yellow-950/60">{fmtWhen(msg.receivedAt)}</p>
          {(msg.memberName || msg.tvcCaseNumber) && (
            <p className="mt-1 font-type text-[11px] font-semibold text-yellow-950/80">
              Re: {[msg.memberName, msg.tvcCaseNumber ? `#${msg.tvcCaseNumber}` : null]
                .filter(Boolean)
                .join(' · ')}
            </p>
          )}
          <p className="mt-2 line-clamp-5 font-hand text-xl leading-snug text-yellow-950">
            {msg.message}
          </p>
        </div>
      </motion.button>

      <Modal open={open} onClose={() => setOpen(false)} width="max-w-md">
        <div className="rounded-sm p-6 shadow-card" style={{ background: paper }}>
          <div className="flex items-start justify-between gap-3">
            <div>
              <p className="font-type text-xs font-bold uppercase tracking-wide text-yellow-950/80">
                {msg.fromName || 'TVC'}
              </p>
              <p className="font-type text-[11px] text-yellow-950/60">
                {fmtWhen(msg.receivedAt)}
              </p>
              {msg.subject && (
                <p className="mt-1 font-type text-[11px] text-yellow-950/70">{msg.subject}</p>
              )}
            </div>
            {statusChip}
          </div>
          <p className="mt-4 whitespace-pre-wrap font-hand text-2xl leading-snug text-yellow-950">
            {msg.message.split(/(https?:\/\/\S+)/g).map((part, i) =>
              /^https?:\/\//.test(part) ? (
                <a
                  key={i}
                  href={part}
                  target="_blank"
                  rel="noreferrer"
                  className="underline decoration-2 underline-offset-2"
                >
                  {part.includes('callrail') ? '▶ Listen to the call' : part}
                </a>
              ) : (
                part
              ),
            )}
          </p>
          <div className="mt-6 flex items-center justify-between gap-2">
            {/* Archiving takes the note off the desk for good; only offered
                once it's handled so nothing open gets buried by accident. */}
            {msg.handled ? (
              <button
                className="rounded-md px-3 py-2 font-type text-sm font-semibold text-yellow-950/60 hover:bg-black/10 hover:text-yellow-950"
                onClick={() => {
                  archiveMessage(msg.id);
                  setOpen(false);
                }}
              >
                Archive
              </button>
            ) : (
              <span />
            )}
            <div className="flex gap-2">
              <button
                className={`rounded-md px-4 py-2 font-type text-sm font-semibold ${
                  msg.handled
                    ? 'bg-yellow-400 text-yellow-950 hover:bg-yellow-300'
                    : 'bg-black/10 text-yellow-950/70 hover:bg-black/15'
                }`}
                onClick={() => {
                  setMessageHandled(msg.id, false);
                  setOpen(false);
                }}
              >
                Unhandled
              </button>
              <button
                className={`rounded-md px-4 py-2 font-type text-sm font-semibold ${
                  msg.handled
                    ? 'bg-black/10 text-yellow-950/70 hover:bg-black/15'
                    : 'bg-emerald-600 text-white hover:bg-emerald-500'
                }`}
                onClick={() => {
                  setMessageHandled(msg.id, true, user?.email ?? null);
                  setOpen(false);
                }}
              >
                Handled
              </button>
            </div>
          </div>
        </div>
      </Modal>
    </>
  );
}
