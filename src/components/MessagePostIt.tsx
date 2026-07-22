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

// Tappable phone/email chips. stopPropagation so tapping a number doesn't
// open the note's modal (or trigger a flip).
function ContactChips({ msg, dark = false }: { msg: TvcMessage; dark?: boolean }) {
  if (!msg.phone && !msg.email) return null;
  const cls = dark
    ? 'rounded-full bg-white/20 px-2 py-0.5 font-type text-[10px] font-bold text-white hover:bg-white/30'
    : 'rounded-full bg-black/10 px-2 py-0.5 font-type text-[10px] font-bold text-yellow-950 hover:bg-black/20';
  return (
    <span className="mt-2 flex flex-wrap gap-1.5">
      {msg.phone && (
        <a
          href={`tel:${msg.phone.replace(/[^\d+]/g, '')}`}
          className={cls}
          onClick={(e) => e.stopPropagation()}
        >
          📞 {msg.phone}
        </a>
      )}
      {msg.email && (
        <a
          href={`mailto:${msg.email}`}
          className={`${cls} max-w-full truncate`}
          onClick={(e) => e.stopPropagation()}
        >
          ✉ {msg.email}
        </a>
      )}
    </span>
  );
}

// A note stuck to the Desk: a human message from TVC staff, a CallRail missed
// call, or a cadence/billing action item. Clicking opens the Handled popup.
// Billing notes with a "why no payment" analysis get a curled corner that
// flips the gold note UP, revealing a blue note underneath with the reason.
export function MessagePostIt({ msg, index = 0 }: { msg: TvcMessage; index?: number }) {
  const [open, setOpen] = useState(false);
  const [flipped, setFlipped] = useState(false);
  const { user } = useAuth();

  const missedCall = msg.kind === 'missed_call';
  // Uncollected-money escalation — gold, matching the SAID YES ribbon on cards.
  const billing = isBillingNote(msg);
  // Maximum urgency: money promised and not one call in either direction since.
  const noPursuit = billing && Boolean(msg.noPursuit) && !msg.handled;
  const flippable = billing && Boolean(msg.nonPaymentReason);
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
        noPursuit
          ? 'bg-red-700 text-red-50'
          : billing
            ? 'bg-amber-900 text-amber-100'
            : 'bg-yellow-400 text-yellow-950'
      } ${missedCall || billing ? 'animate-pulseRing' : ''}`}
    >
      Unhandled
    </span>
  );

  const front = (
    <div
      role="button"
      tabIndex={0}
      onClick={() => setOpen(true)}
      onKeyDown={(e) => e.key === 'Enter' && setOpen(true)}
      className="relative cursor-pointer"
      style={{
        background: paper,
        backfaceVisibility: 'hidden',
        // On flippable notes the bottom-right corner is genuinely cut away
        // (matching the folded flap), so the REAL blue note underneath shows
        // through the gap — not a painted stand-in.
        clipPath: flippable
          ? 'polygon(0 0, 100% 0, 100% calc(100% - 48px), calc(100% - 56px) 100%, 0 100%)'
          : undefined,
        // Shadow via filter so it hugs the clipped outline (a box-shadow
        // would trace the square and give the cut corner away).
        filter: flippable ? 'drop-shadow(2px 4px 6px rgba(0,0,0,0.35))' : undefined,
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
      {noPursuit ? (
        <span className="stamp pointer-events-none absolute left-1/2 top-1/2 z-10 -translate-x-1/2 -translate-y-1/2 -rotate-12 whitespace-nowrap text-[15px] text-pad-red opacity-90">
          No Callback Made
        </span>
      ) : (
        billing &&
        !msg.handled && (
          <span className="stamp pointer-events-none absolute right-2 top-9 -rotate-12 text-[11px] text-amber-900">
            $ Collect
          </span>
        )
      )}
      <div className="p-4 pb-3">
        <div className="flex items-start justify-between gap-2">
          <p className="flex items-center gap-1.5 font-type text-[11px] font-bold uppercase tracking-wide text-yellow-950/80">
            {missedCall && <RingingPhone still={msg.handled} />}
            {noPursuit && <span aria-hidden>🚨</span>}
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
          {noPursuit && msg.subject ? `${msg.subject}. ` : ''}
          {msg.message}
        </p>
        <ContactChips msg={msg} />
      </div>
    </div>
  );

  // Curled corner — the flip affordance. Lives OUTSIDE the clipped front face
  // (which has its bottom-right corner cut away) so the flap isn't clipped:
  // the folded gold flap (paper underside) points up-and-to-the-left, and the
  // cutaway beneath it reveals the REAL blue note underneath.
  const corner = flippable && (
    <button
      type="button"
      aria-label={flipped ? 'Flip the note back down' : 'Flip the note up to see why'}
      title="Why wasn't this collected?"
      onClick={(e) => {
        e.stopPropagation();
        setFlipped((v) => !v);
      }}
      className="absolute -bottom-px -right-px z-10 h-12 w-14 transition-transform hover:scale-110"
      style={{ transformOrigin: 'bottom right', backfaceVisibility: 'hidden' }}
    >
      {/* the folded-back gold corner: underside of the paper, tip up-left,
          darkest along the fold (the hypotenuse). The shadow lives on a
          wrapper so it follows the clipped triangle, not the box. */}
      <span
        aria-hidden
        className="absolute inset-0"
        style={{ filter: 'drop-shadow(2px 2px 2px rgba(0,0,0,0.35))' }}
      >
        <span
          className="absolute inset-0"
          style={{
            background:
              'linear-gradient(135deg, #fffbe2 0%, #ffedb0 45%, #dfb14a 80%, #a97f22 100%)',
            clipPath: 'polygon(0 0, 100% 0, 0 100%)',
          }}
        />
      </span>
      {/* written on the BLUE note showing through the gap — sits in the
          exposed triangle, nudged up off the edge, and carries the blue
          note's slight twist so it reads as ink on that lower layer */}
      <span
        className="absolute bottom-[9px] right-[5px] font-hand text-[12px] leading-none text-blue-950/90"
        style={{ transform: 'rotate(-2.5deg)' }}
      >
        why?
      </span>
    </button>
  );

  // The back of the gold note, shown while it's flipped up. Pre-rotated so the
  // parent's 180° flip lands it upright, not mirrored.
  const back = (
    <div
      role="button"
      tabIndex={0}
      onClick={() => setFlipped(false)}
      onKeyDown={(e) => e.key === 'Enter' && setFlipped(false)}
      className="absolute inset-0 flex cursor-pointer flex-col items-center justify-center p-4 text-center"
      style={{
        background: paper,
        transform: 'rotateX(180deg)',
        backfaceVisibility: 'hidden',
        boxShadow: '2px -4px 10px rgba(0,0,0,0.35)',
      }}
    >
      <p className="font-type text-[10px] font-bold uppercase tracking-widest text-yellow-950/50">
        (back of note)
      </p>
      <p className="mt-1 font-hand text-xl text-yellow-950/80">{msg.memberName || ''}</p>
      <p className="mt-2 font-type text-[10px] text-yellow-950/50">tap to flip back down ↓</p>
    </div>
  );

  return (
    <>
      <div
        className={`relative w-64 shrink-0 ${tilt} ${flipped ? 'z-40' : 'z-0'} ${
          noPursuit && !flipped ? 'animate-pulse rounded-sm ring-4 ring-red-600/90' : ''
        }`}
        style={{ perspective: '1200px' }}
      >
        {/* BLUE note underneath — the classifier's "why no payment" read. */}
        {flippable && (
          <div
            role="button"
            tabIndex={0}
            onClick={() => setFlipped(false)}
            onKeyDown={(e) => e.key === 'Enter' && setFlipped(false)}
            className={`absolute inset-0 cursor-pointer overflow-y-auto p-4 shadow-inner ${
              flipped ? '' : 'pointer-events-none'
            }`}
            style={{
              background: 'linear-gradient(180deg, #bfdcff 0%, #8fbef5 100%)',
              // Twisted a couple degrees off the gold note so its edges peek
              // out — you can tell there's a yellow note sitting on a blue one.
              transform: 'rotate(-2.5deg)',
              boxShadow: '0 2px 6px rgba(0,0,0,0.3)',
            }}
            aria-hidden={!flipped}
          >
            <p className="font-type text-[10px] font-bold uppercase tracking-widest text-blue-950/70">
              Why wasn't it collected?
            </p>
            <p className="mt-2 font-hand text-xl leading-snug text-blue-950">
              {msg.nonPaymentReason}
            </p>
            <ContactChips msg={msg} />
          </div>
        )}

        {/* The gold/yellow note — flips UP from its top edge, overlaying the
            UI above it (elevated z-index while flipped). */}
        <motion.div
          animate={{ rotateX: flipped ? 180 : 0 }}
          initial={false}
          transition={{ duration: 0.55, ease: [0.3, 0.9, 0.3, 1] }}
          whileHover={flipped ? undefined : { y: -3, rotate: 0 }}
          className="relative"
          style={{
            transformStyle: 'preserve-3d',
            transformOrigin: 'top center',
            // Flippable notes carry their shadow on the clipped front face
            // (drop-shadow) so the cut corner doesn't cast a square shadow.
            boxShadow: flipped || flippable ? 'none' : '2px 4px 10px rgba(0,0,0,0.35)',
          }}
        >
          {front}
          {corner}
          {flippable && back}
        </motion.div>
      </div>

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
          {msg.nonPaymentReason && (
            <div
              className="mt-4 rounded-sm p-3"
              style={{ background: 'linear-gradient(180deg, #bfdcff 0%, #9cc6f5 100%)' }}
            >
              <p className="font-type text-[10px] font-bold uppercase tracking-widest text-blue-950/70">
                Why wasn't it collected?
              </p>
              <p className="mt-1 font-hand text-xl leading-snug text-blue-950">
                {msg.nonPaymentReason}
              </p>
            </div>
          )}
          <ContactChips msg={msg} />
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
