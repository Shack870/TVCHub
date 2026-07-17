import { useState } from 'react';
import { motion } from 'framer-motion';
import type { TvcMessage } from '../types';
import { setMessageHandled } from '../lib/db';
import { useAuth } from '../context/AuthContext';
import { Modal } from './ui/Modal';

function fmtWhen(ms: number): string {
  const d = new Date(ms);
  const time = `${d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }).toLowerCase()}`;
  return `${d.toLocaleDateString('en-US', { weekday: 'short', month: 'numeric', day: 'numeric' })} · ${time}`;
}

// A human note from TVC staff, rendered as a sticky note on the Desk. Clicking
// it opens a popup to mark it Handled / Unhandled.
export function MessagePostIt({ msg, index = 0 }: { msg: TvcMessage; index?: number }) {
  const [open, setOpen] = useState(false);
  const { user } = useAuth();

  // Alternate a slight tilt so a row of notes looks hand-stuck, not printed.
  const tilt = index % 2 === 0 ? '-rotate-1' : 'rotate-1';

  const statusChip = msg.handled ? (
    <span className="rounded-full bg-emerald-600 px-2.5 py-0.5 font-type text-[10px] font-bold uppercase tracking-wide text-white shadow-sm">
      Handled
    </span>
  ) : (
    <span className="rounded-full bg-yellow-400 px-2.5 py-0.5 font-type text-[10px] font-bold uppercase tracking-wide text-yellow-950 shadow-sm">
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
        className={`relative block w-64 shrink-0 cursor-pointer text-left ${tilt}`}
        style={{
          background: 'linear-gradient(180deg, #fff9a8 0%, #fdf07e 100%)',
          boxShadow: '2px 4px 10px rgba(0,0,0,0.35)',
        }}
      >
        {/* tape strip */}
        <span className="absolute -top-2 left-1/2 h-4 w-16 -translate-x-1/2 rotate-2 bg-white/40 shadow-sm" />
        <div className="p-4 pb-3">
          <div className="flex items-start justify-between gap-2">
            <p className="font-type text-[11px] font-bold uppercase tracking-wide text-yellow-950/80">
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
        <div
          className="rounded-sm p-6 shadow-card"
          style={{ background: 'linear-gradient(180deg, #fff9a8 0%, #fdf07e 100%)' }}
        >
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
            {msg.message}
          </p>
          <div className="mt-6 flex justify-end gap-2">
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
      </Modal>
    </>
  );
}
