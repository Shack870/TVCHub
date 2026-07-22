import { useState } from 'react';
import { httpsCallable } from 'firebase/functions';
import { formatDistanceToNow } from 'date-fns';
import { functions } from '../firebase';
import { notify } from '../store/useToast';
import type { Lead } from '../types';

// "Send to PDF App" handoff control for intake-complete leads. Three states:
//   not sent -> actionable button (calls the sendToPdfApp callable)
//   sending  -> disabled with spinner
//   sent     -> green check + relative date, with a small resend affordance
// `tone` matches the surface it sits on: 'light' for the manila table rows,
// 'dark' for the drawer's felt action bar.
export function SendToPdfAppButton({
  lead,
  tone = 'light',
}: {
  lead: Lead;
  tone?: 'light' | 'dark';
}) {
  const [sending, setSending] = useState(false);
  const sent = Boolean(lead.pdfAppSentAt);

  const send = async () => {
    if (sending) return;
    setSending(true);
    try {
      const fn = httpsCallable(functions, 'sendToPdfApp');
      const res = await fn({ leadId: lead.id });
      const data = res.data as { ok: boolean; caseId: string; duplicate: boolean };
      notify.success(
        data.duplicate
          ? `${lead.name} is already in the PDF app — linked to the existing case.`
          : `${lead.name} sent to the PDF app.`,
      );
    } catch (e) {
      notify.error(
        e instanceof Error && e.message
          ? `Send to PDF app failed: ${e.message}`
          : 'Send to PDF app failed.',
      );
    } finally {
      setSending(false);
    }
  };

  if (sent) {
    return (
      <span
        className={`inline-flex items-center gap-1.5 px-2 py-1 font-type text-xs ${
          tone === 'dark' ? 'text-emerald-300' : 'text-emerald-700'
        }`}
        title={`In PDF App${lead.pdfAppCaseId ? ` · case ${lead.pdfAppCaseId}` : ''}${
          lead.pdfAppSentBy === 'auto' ? ' · sent automatically' : ''
        }`}
      >
        <span className="font-bold">✓ In PDF App</span>
        <span className={tone === 'dark' ? 'text-emerald-300/70' : 'text-emerald-700/70'}>
          {lead.pdfAppSentAt
            ? formatDistanceToNow(lead.pdfAppSentAt, { addSuffix: true })
            : ''}
        </span>
        <button
          className={`ml-1 underline decoration-dotted opacity-60 hover:opacity-100 ${
            sending ? 'cursor-wait' : ''
          }`}
          onClick={send}
          disabled={sending}
          title="Send again (overwrites nothing — dedup keeps the existing case)"
        >
          {sending ? 'resending…' : 'resend'}
        </button>
      </span>
    );
  }

  return (
    <button
      className={`btn-ghost px-2 py-1 text-xs disabled:cursor-wait disabled:opacity-50 ${
        tone === 'dark' ? 'text-manila' : 'text-pad-ink'
      }`}
      onClick={send}
      disabled={sending}
      title="Create this case in the Iron Rock PDF app"
    >
      {sending ? (
        <span className="inline-flex items-center gap-1.5">
          <span className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-current border-t-transparent" />
          Sending…
        </span>
      ) : (
        'Send to PDF App →'
      )}
    </button>
  );
}
