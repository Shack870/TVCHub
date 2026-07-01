import { useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { Drawer } from './ui/Drawer';
import { Modal } from './ui/Modal';
import { Badge } from './ui/Badge';
import { ConfirmDialog } from './ui/ConfirmDialog';
import { useUI } from '../store/useUI';
import { useLead } from '../store/useLeads';
import { useAuth } from '../context/AuthContext';
import type { ContactOutcome, Lead, Ticket } from '../types';
import { formatDistanceToNow } from 'date-fns';
import { balanceOf, isActiveLead, isContactOverdue, OUTCOME_LABELS, STAGE_LABELS } from '../lib/leadFlow';
import { courtDatePassed, fmtDate, fmtMoney } from '../lib/dates';
import { updateLead, updateLeadGuarded } from '../lib/db';
import { notify } from '../store/useToast';
import {
  logCallOutcome,
  archiveLead,
  assignLead,
  completeFollowUp,
  declineLead,
  markCaseDismissed,
  markIntakeComplete,
  markLost,
  recordPayment,
  reopenIntake,
  restoreLead,
  retainLead,
  reviveLost,
  scheduleAttorneyCall,
  setConflictCheck,
  setCourtNotesCheck,
  updateCourtDate,
  snoozeFollowUp,
} from '../lib/actions';
import { PAYMENT_METHODS } from '../lib/payments';
import { DAY } from '../lib/followups';
import type { FollowUpType, Payment } from '../types';

export function LeadDetailDrawer() {
  const id = useUI((s) => s.selectedLeadId);
  const selectLead = useUI((s) => s.selectLead);
  const lead = useLead(id ?? undefined);
  const open = Boolean(id && lead);

  return (
    <Drawer open={open} onClose={() => selectLead(null)}>
      {lead && <DrawerBody lead={lead} onClose={() => selectLead(null)} />}
    </Drawer>
  );
}

type TabId =
  | 'member'
  | 'ticketInfo'
  | 'tickets'
  | 'court'
  | 'driver'
  | 'attorney'
  | 'notes'
  | 'checks';

const TABS: { id: TabId; label: string; color: string }[] = [
  { id: 'member', label: 'Member', color: '#2f74c0' },
  { id: 'ticketInfo', label: 'Ticket Info', color: '#e0792f' },
  { id: 'tickets', label: 'Tickets', color: '#b5302a' },
  { id: 'court', label: 'Court Info', color: '#2f8f4e' },
  { id: 'driver', label: 'Driver Info', color: '#7c4dbd' },
  { id: 'attorney', label: 'Attorney', color: '#c08a1e' },
  { id: 'notes', label: 'Notes', color: '#6b7280' },
  { id: 'checks', label: 'Checks', color: '#1c2541' },
];

type TopTab = 'file' | 'contact' | 'dates' | 'attachments';
const TOP_TABS: { id: TopTab; label: string }[] = [
  { id: 'file', label: 'Member Info' },
  { id: 'contact', label: 'Contact Attempt Log' },
  { id: 'dates', label: 'Court Dates' },
  { id: 'attachments', label: 'Attachments' },
];

function DrawerBody({ lead, onClose }: { lead: Lead; onClose: () => void }) {
  const { user } = useAuth();
  const by = user?.displayName || user?.email || undefined;
  const requestedTab = useUI((s) => s.selectedLeadTab);
  const [stamp, setStamp] = useState<string | null>(null);
  const [retainOpen, setRetainOpen] = useState(false);
  const [attorneyOpen, setAttorneyOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [completeOpen, setCompleteOpen] = useState(false);
  // Can't schedule an attorney call before you've actually reached the lead.
  const hasContact = (lead.contactAttempts?.length ?? 0) > 0;

  // The outcome bar is contextual to where the lead sits in its lifecycle, so
  // you can't (e.g.) decline a client who's already retained or handed off.
  const isActive = isActiveLead(lead);
  const isRetained = lead.stage === 'retained';
  const isCompleted = lead.stage === 'intake_complete';
  const isLost = lead.stage === 'lost';
  const courtOverdue =
    courtDatePassed(lead) && !lead.caseDismissed && !isCompleted && !isLost;

  const completeWarnings: string[] = [];
  if (lead.conflictCheck.status !== 'clear') completeWarnings.push('conflict check not cleared');
  if (!lead.retainerSignedConfirmed) completeWarnings.push('retainer not confirmed signed');
  if (balanceOf(lead) > 0) completeWarnings.push(`${fmtMoney(balanceOf(lead))} balance still owed`);
  // Honor a deep-linked tab. It can be a top tab (e.g. 'contact' when opening a
  // card from All Active) or a sub tab (e.g. 'checks' from the Retained list).
  const [topTab, setTopTab] = useState<TopTab>(
    TOP_TABS.some((t) => t.id === requestedTab) ? (requestedTab as TopTab) : 'file',
  );
  const [tab, setTab] = useState<TabId>(
    TABS.some((t) => t.id === requestedTab) ? (requestedTab as TabId) : 'member',
  );
  const active = TABS.find((t) => t.id === tab)!;

  const doStamp = (label: string, after: () => Promise<void>) => async () => {
    await after();
    setStamp(label);
    setTimeout(onClose, 650);
  };

  return (
    <div className="relative flex min-h-full flex-col">
      <AnimatePresence>
        {stamp && (
          <motion.div
            className="pointer-events-none absolute inset-0 z-30 flex items-center justify-center"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
          >
            <span
              className={`stamp animate-stampIn text-5xl ${
                stamp === 'RETAINED' ? 'text-emerald-600' : 'text-pad-red'
              }`}
            >
              {stamp}
            </span>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Header */}
      <div className="sticky top-0 z-20 flex items-start justify-between gap-3 bg-felt/95 px-6 py-4 backdrop-blur">
        <div>
          <p className="data text-xs text-manila/60">
            TVC #{lead.tvcCaseNumber || '—'}
          </p>
          <h2 className="font-hand text-4xl text-white">{lead.name}</h2>
          {isContactOverdue(lead) && (
            <span className="stamp mt-1 inline-block -rotate-2 text-lg text-pad-red">
              Contact Overdue
            </span>
          )}
          <div className="mt-1 flex flex-wrap items-center gap-2">
            <Badge tone="blue">{STAGE_LABELS[lead.stage]}</Badge>
            {lead.phone && (
              <a
                href={`tel:${lead.phone.replace(/[^\d+]/g, '')}`}
                className="quick-chip"
                title={`Call ${lead.phone}`}
              >
                📞 <span className="data">{lead.phone}</span>
              </a>
            )}
            {lead.altPhone && (
              <a
                href={`tel:${lead.altPhone.replace(/[^\d+]/g, '')}`}
                className="quick-chip"
                title={`Call alt ${lead.altPhone}`}
              >
                📞 <span className="data">{lead.altPhone}</span>
              </a>
            )}
            {lead.email && (
              <a href={`mailto:${lead.email}`} className="quick-chip" title={`Email ${lead.email}`}>
                ✉ Email
              </a>
            )}
          </div>
        </div>
        <div className="flex flex-col items-end gap-2">
          <button className="btn-ghost text-manila" onClick={onClose}>
            Close ✕
          </button>
          <ClaimLeadSelect lead={lead} />
          {lead.updatedAt && (
            <span className="data text-[10px] text-manila/50">
              edited {formatDistanceToNow(lead.updatedAt, { addSuffix: true })}
            </span>
          )}
        </div>
      </div>

      {/* Top tabs */}
      <div className="flex gap-1 px-4">
        {TOP_TABS.map((t) => (
          <button
            key={t.id}
            onClick={() => setTopTab(t.id)}
            className={`rounded-t-lg px-4 py-2 font-type text-sm font-semibold transition ${
              topTab === t.id
                ? 'bg-pad-paper text-pad-ink shadow'
                : 'bg-black/20 text-manila/70 hover:bg-black/30'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div className="flex-1 px-3 pb-28">
        {topTab === 'file' && (
          <div className="flex items-stretch gap-0">
            <div className="legal-pad relative min-h-[440px] flex-1 overflow-hidden rounded-bl-lg rounded-tr-lg shadow-card ring-1 ring-black/10">
              <AnimatePresence mode="wait">
                <motion.div
                  key={tab}
                  initial={{ opacity: 0, x: 14 }}
                  animate={{ opacity: 1, x: 0 }}
                  exit={{ opacity: 0, x: -14 }}
                  transition={{ duration: 0.18 }}
                  className="px-6 py-5 pl-16"
                >
                  <h3 className="mb-3 font-hand text-3xl" style={{ color: active.color }}>
                    {active.label}
                  </h3>
                  <TabContent tab={tab} lead={lead} />
                </motion.div>
              </AnimatePresence>
            </div>
            <div className="flex flex-col gap-1.5 pt-4">
              {TABS.map((t) => {
                const isActive = t.id === tab;
                return (
                  <button
                    key={t.id}
                    onClick={() => setTab(t.id)}
                    style={{
                      backgroundColor: t.color,
                      opacity: isActive ? 1 : 0.62,
                      marginLeft: isActive ? -8 : 0,
                    }}
                    className={`relative flex h-10 w-28 items-center rounded-r-md px-3 text-left font-type text-[11px] font-bold uppercase tracking-wide text-white shadow transition-all hover:opacity-100 ${
                      isActive ? 'z-10 shadow-lg' : ''
                    }`}
                  >
                    {t.label}
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {topTab === 'contact' && (
          <div className="legal-pad min-h-[440px] rounded-b-lg rounded-tr-lg p-6 pl-16 shadow-card ring-1 ring-black/10">
            <ContactLogTab lead={lead} by={by} onRetain={() => setRetainOpen(true)} />
          </div>
        )}

        {topTab === 'dates' && (
          <div className="legal-pad min-h-[440px] rounded-b-lg rounded-tr-lg p-6 pl-16 shadow-card ring-1 ring-black/10">
            <h3 className="mb-3 font-hand text-3xl text-pad-inkSoft">Court Dates</h3>
            <CourtDatesTab lead={lead} />
          </div>
        )}

        {topTab === 'attachments' && (
          <div className="legal-pad min-h-[440px] rounded-b-lg rounded-tr-lg p-6 pl-16 shadow-card ring-1 ring-black/10">
            <h3 className="mb-3 font-hand text-3xl text-pad-inkSoft">Attachments</h3>
            <AttachmentsTab lead={lead} />
          </div>
        )}
      </div>

      {/* Court-date-passed gate — surfaced for any working/retained lead, not
          just financing clients. Resolve it inline without leaving the drawer. */}
      {courtOverdue && <CourtPassedBanner lead={lead} />}

      {/* Sticky outcome bar — actions depend on the lead's current stage. */}
      <div className="sticky bottom-0 z-20 flex flex-wrap items-center gap-2 border-t border-white/10 bg-felt/95 px-6 py-4 backdrop-blur">
        {isActive && (
          <>
            <div className="w-full font-type text-xs leading-snug text-manila/70">
              <span className="font-bold uppercase tracking-wide text-manila">
                Did they call us?
              </span>{' '}
              Record a direct outcome here (e.g. the client called back after a
              voicemail). To log an outbound attempt, use the Contact Attempt Log
              tab.
            </div>
            <button
              className="btn bg-emerald-600 text-white hover:bg-emerald-500"
              onClick={() => setRetainOpen(true)}
            >
              ★ Retain Client
            </button>
            <button
              className="btn-ghost text-manila disabled:cursor-not-allowed disabled:opacity-40"
              onClick={() => setAttorneyOpen(true)}
              disabled={!hasContact}
              title={
                hasContact
                  ? 'Schedule a call with an attorney'
                  : 'Log the first contact attempt before scheduling an attorney call'
              }
            >
              Schedule Attorney Call
            </button>
            <button
              className="btn-danger"
              onClick={doStamp('DECLINED', () => declineLead(lead, by))}
            >
              Decline → Follow-Up
            </button>
            <button
              className="btn bg-amber-400 text-pad-ink hover:bg-amber-300"
              onClick={doStamp('NO SALE', () => markLost(lead, by))}
              title="No sale — didn't retain"
            >
              No Sale
            </button>
          </>
        )}

        {isRetained && (
          <button
            className="btn bg-pad-ink text-pad-paper hover:bg-pad-inkSoft"
            onClick={() => setCompleteOpen(true)}
          >
            Mark Intake Complete →
          </button>
        )}

        {isCompleted && (
          <button
            className="btn-ghost text-manila"
            onClick={doStamp('REOPENED', () => reopenIntake(lead))}
            title="Move back to Retained"
          >
            Reopen Intake
          </button>
        )}

        {isLost && (
          <button
            className="btn-ghost text-manila"
            onClick={doStamp('REOPENED', () => reviveLost(lead))}
            title="Bring this lead back into the working pipeline"
          >
            Reopen to Pipeline
          </button>
        )}

        <button
          className="ml-auto btn-ghost text-manila/60 hover:text-pad-red"
          onClick={() => setDeleteOpen(true)}
          title="Archive this file"
        >
          Archive file
        </button>
      </div>

      <RetainPanel
        lead={lead}
        open={retainOpen}
        onClose={() => setRetainOpen(false)}
        onRetained={doStamp('RETAINED', async () => {})}
      />

      <AttorneyCallPanel
        lead={lead}
        open={attorneyOpen}
        onClose={() => setAttorneyOpen(false)}
        onScheduled={doStamp('CALL SET', async () => {})}
      />

      <ConfirmDialog
        open={completeOpen}
        title="Client Intake Complete?"
        message={
          completeWarnings.length > 0
            ? `Heads up — ${completeWarnings.join(', ')}. Hand ${lead.name} to the next department anyway?`
            : `Mark ${lead.name} as intake complete and hand the file to the next department.`
        }
        confirmLabel="Mark Complete"
        tone={completeWarnings.length > 0 ? 'danger' : 'default'}
        onClose={() => setCompleteOpen(false)}
        onConfirm={() => {
          void doStamp('COMPLETE', () => markIntakeComplete(lead))();
        }}
      />

      <ConfirmDialog
        open={deleteOpen}
        title={`Archive ${lead.name}?`}
        message="This hides the file from every view. You can undo it right after, or restore it later."
        confirmLabel="Archive file"
        tone="danger"
        onClose={() => setDeleteOpen(false)}
        onConfirm={async () => {
          await archiveLead(lead);
          onClose();
          notify.success(`Archived ${lead.name}`, {
            label: 'Undo',
            run: () => {
              void restoreLead(lead);
            },
          });
        }}
      />
    </div>
  );
}

function AttorneyCallPanel({
  lead,
  open,
  onClose,
  onScheduled,
}: {
  lead: Lead;
  open: boolean;
  onClose: () => void;
  onScheduled: () => Promise<void>;
}) {
  const existing = lead.attorneyCallAt
    ? new Date(lead.attorneyCallAt - new Date().getTimezoneOffset() * 60000)
        .toISOString()
        .slice(0, 16)
    : '';
  const [when, setWhen] = useState(existing);
  // Can't schedule a call in the past.
  const minWhen = new Date(Date.now() - new Date().getTimezoneOffset() * 60000)
    .toISOString()
    .slice(0, 16);
  const inPast = Boolean(when) && new Date(when).getTime() < Date.now();

  return (
    <Modal open={open} onClose={onClose} width="max-w-sm">
      <div className="legal-pad rounded-lg p-6 pl-14 shadow-card">
        <h3 className="font-hand text-3xl ink">Schedule Attorney Call</h3>
        <p className="mb-4 font-type text-xs text-pad-inkSoft">
          When should {lead.name} speak with an attorney?
        </p>
        <input
          type="datetime-local"
          value={when}
          min={minWhen}
          onChange={(e) => setWhen(e.target.value)}
          className="w-full rounded-md border border-black/10 bg-white/80 p-2 font-type text-sm text-pad-ink"
        />
        {inPast && (
          <p className="mt-2 font-type text-xs font-semibold text-pad-red">
            Pick a time in the future.
          </p>
        )}
        <div className="mt-5 flex justify-end gap-2">
          <button className="btn-ghost text-pad-ink" onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn-primary"
            disabled={!when || inPast}
            onClick={async () => {
              await scheduleAttorneyCall(lead, new Date(when).getTime());
              onClose();
              await onScheduled();
            }}
          >
            Set Call
          </button>
        </div>
      </div>
    </Modal>
  );
}

const CLAIM_OPTIONS = ['Stephanie', 'Vince', 'Shannon', 'Other'];

// Persistent owner assignment. First pick saves immediately; changing an
// existing owner asks for confirmation before overwriting.
function ClaimLeadSelect({ lead }: { lead: Lead }) {
  const [pending, setPending] = useState<string | null>(null);
  const current = lead.owner ?? '';

  const handle = (value: string) => {
    if (!value || value === current) return;
    if (current) {
      setPending(value); // already owned -> confirm before reassigning
    } else {
      assignLead(lead, value); // first assignment -> save straight away
    }
  };

  return (
    <div className="flex items-center gap-2">
      <span className="data text-[11px] uppercase tracking-wide text-manila/60">
        Claim Lead
      </span>
      <select
        value={current}
        onChange={(e) => handle(e.target.value)}
        className="rounded-md border border-white/15 bg-black/30 px-2 py-1 font-type text-xs text-white outline-none focus:border-white/40"
      >
        <option value="">Unassigned</option>
        {CLAIM_OPTIONS.map((o) => (
          <option key={o} value={o}>
            {o}
          </option>
        ))}
      </select>
      <ConfirmDialog
        open={pending !== null}
        title="Reassign this lead?"
        message={`This lead is claimed by ${current}. Reassign it to ${pending}?`}
        confirmLabel="Yes"
        cancelLabel="Cancel"
        onClose={() => setPending(null)}
        onConfirm={() => {
          if (pending) assignLead(lead, pending);
        }}
      />
    </div>
  );
}

function TabContent({ tab, lead }: { tab: TabId; lead: Lead }) {
  switch (tab) {
    case 'member':
      return (
        <Ledger>
          <EditRow lead={lead} k="name" label="Name" required />
          <EditRow lead={lead} k="phone" label="Phone" action="tel" />
          <EditRow lead={lead} k="altPhone" label="Alt Phone" action="tel" />
          <EditRow lead={lead} k="email" label="Email" action="mailto" />
          <EditRow lead={lead} k="address" label="Address" />
          <EditRow lead={lead} k="birthdate" label="Birthdate" />
          <EditRow lead={lead} k="language" label="Preferred Language" />
          <EditRow lead={lead} k="driversLicense" label="Driver's License" />
          <EditRow lead={lead} k="driversLicenseState" label="DL State" />
          <EditRow lead={lead} k="driversLicenseType" label="DL Type" />
        </Ledger>
      );
    case 'ticketInfo':
      return (
        <Ledger>
          <EditRow lead={lead} k="familyMemberRelationship" label="Family Member" />
          <EditRow lead={lead} k="familyMemberName" label="Family Member Name" />
          <EditRow lead={lead} k="vehicleType" label="Vehicle Type" />
          <EditRow lead={lead} k="violationDate" label="Violation Date" />
          <EditRow lead={lead} k="caseOpenedOn" label="Case Opened On" />
        </Ledger>
      );
    case 'tickets':
      return <TicketsEditor lead={lead} />;
    case 'court':
      return (
        <Ledger>
          <EditRow lead={lead} k="courtName" label="Court Name" />
          <EditRow lead={lead} k="courtPhone" label="Phone" />
          <EditRow lead={lead} k="courtAddress" label="Address" />
          <EditRow lead={lead} k="courtCity" label="City" />
          <EditRow lead={lead} k="county" label="County" />
          <EditRow lead={lead} k="state" label="State" />
          <EditRow lead={lead} k="courtZip" label="Zip Code" />
        </Ledger>
      );
    case 'driver':
      return (
        <Ledger>
          <EditRow lead={lead} k="movingViolation" label="Moving Violation" />
          <EditRow lead={lead} k="preExisting" label="Pre-Existing" />
          <EditRow lead={lead} k="accidentInvolved" label="Accident Involved" />
          <EditRow lead={lead} k="examinationReport" label="Exam Report Received" />
        </Ledger>
      );
    case 'attorney':
      return (
        <Ledger>
          <EditRow lead={lead} k="attorneyNames" label="Attorney(s)" />
          <EditRow lead={lead} k="firmName" label="Firm" />
          <EditRow lead={lead} k="firmAddress" label="Address" />
          <EditRow lead={lead} k="firmPhone" label="Phone" />
          <EditRow lead={lead} k="firmFax" label="Fax" />
          <EditRow lead={lead} k="attorneyMobile" label="Mobile" />
          <EditRow lead={lead} k="attorneyEmail" label="Email" />
          <EditRow lead={lead} k="lawType" label="Law Type" />
        </Ledger>
      );
    case 'notes':
      return <NotesEditor lead={lead} />;
    case 'checks':
      return <IntakeChecklist lead={lead} />;
  }
}

function fmtBytes(n?: number): string {
  if (!n) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function AttachmentsTab({ lead }: { lead: Lead }) {
  const files = lead.attachments ?? [];
  if (files.length === 0) {
    return (
      <p className="py-8 text-center font-type text-sm text-pad-inkSoft/60">
        No attachments. Files from the referral email will appear here
        automatically.
      </p>
    );
  }
  return (
    <div className="space-y-4">
      {files.map((f, i) => {
        const isImage = (f.contentType || '').startsWith('image/');
        const isPdf = (f.contentType || '').includes('pdf') || /\.pdf$/i.test(f.name);
        return (
          <div key={i} className="rounded-lg border border-black/10 bg-white/60 p-3">
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <p className="truncate font-type text-sm font-semibold text-pad-ink">
                  {f.name}
                </p>
                <p className="font-type text-xs text-pad-inkSoft">
                  {f.contentType || 'file'} {f.size ? `· ${fmtBytes(f.size)}` : ''}
                </p>
              </div>
              {f.url && (
                <a
                  href={f.url}
                  target="_blank"
                  rel="noreferrer"
                  className="btn-primary shrink-0 px-3 py-1.5 text-xs"
                >
                  Open
                </a>
              )}
            </div>
            {f.url && isImage && (
              <img src={f.url} alt={f.name} className="mt-3 max-h-80 rounded border border-black/10" />
            )}
            {f.url && isPdf && (
              <iframe
                title={f.name}
                src={f.url}
                className="mt-3 h-96 w-full rounded border border-black/10 bg-white"
              />
            )}
          </div>
        );
      })}
    </div>
  );
}

function CourtDatesTab({ lead }: { lead: Lead }) {
  const current = lead.nextCourtDate ?? '';
  return (
    <Ledger>
      {/* Changing the date routes through updateCourtDate so the prior date is
          archived to history and a dismissal flag is cleared. */}
      <div className="flex gap-3 border-b border-pad-line/40 py-[2px]">
        <span className="field-label w-40 shrink-0 pt-2">Next Court Date</span>
        <input
          key={'nextCourtDate:' + current}
          type="date"
          defaultValue={current}
          onBlur={(e) => {
            const v = e.target.value;
            if (v && v !== current) updateCourtDate(lead, v);
          }}
          className="min-w-0 flex-1 rounded bg-transparent px-1 font-type text-sm leading-7 text-pad-ink outline-none transition hover:bg-white/40 focus:bg-white/70 focus:ring-1 focus:ring-pad-ink/20"
        />
      </div>
      <EditRow lead={lead} k="nextCourtTime" label="Time" />
      <EditRow lead={lead} k="nextCourtType" label="Type" />
      <EditRow lead={lead} k="courtName" label="Court" />
      {lead.courtDateHistory && lead.courtDateHistory.length > 0 && (
        <div className="pt-3">
          <span className="field-label">Prior Dates</span>
          <ul className="mt-1 space-y-1">
            {lead.courtDateHistory.map((c, i) => (
              <li key={i} className="font-type text-xs text-pad-inkSoft">
                {fmtDate(c.date)} {c.type ? `· ${c.type}` : ''}
              </li>
            ))}
          </ul>
        </div>
      )}
    </Ledger>
  );
}

function Ledger({ children }: { children: React.ReactNode }) {
  return <div>{children}</div>;
}

// Inline-editable field row. Uncontrolled with a key so it re-syncs when the
// underlying value changes (e.g. after the LLM populates it), but never clobbers
// what you're typing mid-edit. Saves to Firestore on blur.
function EditRow({
  lead,
  k,
  label,
  type = 'text',
  action,
  required,
}: {
  lead: Lead;
  k: keyof Lead;
  label: string;
  type?: string;
  action?: 'tel' | 'mailto';
  required?: boolean;
}) {
  const current = ((lead[k] as string | undefined) ?? '').toString();
  // Snapshot the lead's version when editing starts, so a guarded save can
  // detect another user changing this lead underneath us.
  const baseUpdatedAt = useRef<number | undefined>(lead.updatedAt);
  const href =
    action === 'tel'
      ? `tel:${current.replace(/[^\d+]/g, '')}`
      : action === 'mailto'
        ? `mailto:${current}`
        : undefined;
  return (
    <div className="flex items-center gap-3 border-b border-pad-line/40 py-[2px]">
      <span className="field-label w-40 shrink-0 pt-2">{label}</span>
      <input
        key={String(k) + ':' + current}
        type={type}
        defaultValue={current}
        placeholder="—"
        onFocus={() => {
          baseUpdatedAt.current = lead.updatedAt;
        }}
        onBlur={async (e) => {
          const v = e.target.value;
          // A required field (e.g. name) can't be blanked — revert instead.
          if (required && !v.trim()) {
            e.target.value = current;
            return;
          }
          if (v === current) return;
          const res = await updateLeadGuarded(
            lead.id,
            { [k]: v } as Partial<Lead>,
            baseUpdatedAt.current,
          );
          if (res.conflict) {
            // Another user saved first — keep their value, don't clobber it.
            e.target.value = current;
            notify.error(
              'Someone else updated this lead while you were editing — your change wasn’t saved. The latest version is shown.',
            );
          }
        }}
        className="min-w-0 flex-1 rounded bg-transparent px-1 font-type text-sm leading-7 text-pad-ink outline-none transition hover:bg-white/40 focus:bg-white/70 focus:ring-1 focus:ring-pad-ink/20"
      />
      {href && current && (
        <a
          href={href}
          className="quick-chip shrink-0"
          title={action === 'tel' ? `Call ${current}` : `Email ${current}`}
        >
          {action === 'tel' ? '📞 Call' : '✉ Email'}
        </a>
      )}
    </div>
  );
}

function TicketsEditor({ lead }: { lead: Lead }) {
  const tickets = lead.tickets ?? [];
  const save = (next: Ticket[]) =>
    updateLead(lead.id, {
      tickets: next,
      charge: next.map((t) => t.violation).filter(Boolean).join('; '),
    });
  const setField = (i: number, field: keyof Ticket, val: string) =>
    save(tickets.map((t, idx) => (idx === i ? { ...t, [field]: val } : t)));

  return (
    <div className="font-type text-sm text-pad-ink">
      <div className="mb-1 grid grid-cols-[1.2fr_2.4fr_1fr_auto] gap-2 text-[11px] uppercase tracking-wide text-pad-inkSoft/70">
        <span>Number</span>
        <span>Violation</span>
        <span>Code</span>
        <span />
      </div>
      {tickets.map((t, i) => (
        <div key={i} className="mb-1 grid grid-cols-[1.2fr_2.4fr_1fr_auto] items-center gap-2">
          <TInput val={t.number} onSave={(v) => setField(i, 'number', v)} />
          <TInput val={t.violation} onSave={(v) => setField(i, 'violation', v)} />
          <TInput val={t.code} onSave={(v) => setField(i, 'code', v)} />
          <button
            onClick={() => save(tickets.filter((_, idx) => idx !== i))}
            className="px-1 text-pad-red"
            title="Remove ticket"
          >
            ✕
          </button>
        </div>
      ))}
      <button
        onClick={() => save([...tickets, { number: '', violation: '', code: '' }])}
        className="btn-ghost mt-2 px-2 py-1 text-xs text-pad-ink"
      >
        + Add ticket
      </button>
    </div>
  );
}

function TInput({ val, onSave }: { val?: string; onSave: (v: string) => void }) {
  const current = val ?? '';
  return (
    <input
      key={current}
      defaultValue={current}
      onBlur={(e) => e.target.value !== current && onSave(e.target.value)}
      className="min-w-0 rounded border border-black/10 bg-white/70 px-1.5 py-1 outline-none focus:bg-white"
    />
  );
}

function NotesEditor({ lead }: { lead: Lead }) {
  const current = lead.tvcNotes ?? '';
  return (
    <textarea
      key={current.length}
      defaultValue={current}
      rows={16}
      placeholder="No notes recorded — type to add."
      onBlur={(e) => e.target.value !== current && updateLead(lead.id, { tvcNotes: e.target.value })}
      className="w-full rounded-md border border-black/10 bg-white/60 p-3 font-type text-xs leading-relaxed text-pad-ink outline-none focus:bg-white/80"
    />
  );
}

function IntakeChecklist({ lead }: { lead: Lead }) {
  const c = lead.conflictCheck;
  const cn = lead.courtNotesCheck;
  return (
    <div className="space-y-5 font-type text-sm text-pad-ink">
      <div>
        <span className="field-label mb-1 block">Conflict Check</span>
        <div className="flex gap-2">
          {(['clear', 'conflict'] as const).map((s) => {
            const status = c.status === 'conflict' ? 'conflict' : 'clear';
            return (
              <button
                key={s}
                onClick={() => setConflictCheck(lead, s, c.notes)}
                className={`rounded-md px-3 py-1 text-xs font-semibold capitalize transition ${
                  status === s
                    ? s === 'clear'
                      ? 'bg-emerald-600 text-white'
                      : 'bg-pad-red text-white'
                    : 'bg-black/10'
                }`}
              >
                {s}
              </button>
            );
          })}
        </div>
        <textarea
          key={'conflictNotes:' + (c.notes ?? '')}
          defaultValue={c.notes ?? ''}
          rows={2}
          placeholder="Conflict check notes…"
          onBlur={(e) =>
            e.target.value !== (c.notes ?? '') &&
            setConflictCheck(lead, c.status, e.target.value)
          }
          className="mt-2 w-full rounded-md border border-black/10 bg-white/60 p-2 text-xs outline-none focus:bg-white/80"
        />
      </div>

      <div className="border-t border-pad-line/40 pt-4">
        <span className="field-label mb-1 block">Court Notes Check</span>
        <p className="mb-2 font-type text-xs text-pad-inkSoft/70">
          Confirm what this court allows before pitching trial strategy.
        </p>
        <TriStateRow
          label="Allows trial in absentia"
          value={cn.allowsTrialInAbstentia}
          onChange={(v) => setCourtNotesCheck(lead, { allowsTrialInAbstentia: v })}
        />
        <TriStateRow
          label="Allows waiver of appearance"
          value={cn.allowsWaiver}
          onChange={(v) => setCourtNotesCheck(lead, { allowsWaiver: v })}
        />
        <textarea
          key={'courtNotes:' + (cn.notes ?? '')}
          defaultValue={cn.notes ?? ''}
          rows={2}
          placeholder="Court notes…"
          onBlur={(e) =>
            e.target.value !== (cn.notes ?? '') &&
            setCourtNotesCheck(lead, { notes: e.target.value })
          }
          className="mt-2 w-full rounded-md border border-black/10 bg-white/60 p-2 text-xs outline-none focus:bg-white/80"
        />
      </div>
    </div>
  );
}

function TriStateRow({
  label,
  value,
  onChange,
}: {
  label: string;
  value: boolean | null;
  onChange: (v: boolean | null) => void;
}) {
  const opts: { v: boolean | null; label: string; active: string }[] = [
    { v: true, label: 'Yes', active: 'bg-emerald-600 text-white' },
    { v: false, label: 'No', active: 'bg-pad-red text-white' },
    { v: null, label: 'Unknown', active: 'bg-pad-ink text-white' },
  ];
  return (
    <div className="flex items-center justify-between gap-3 py-1">
      <span>{label}</span>
      <div className="flex gap-1.5">
        {opts.map((o) => (
          <button
            key={String(o.v)}
            onClick={() => onChange(o.v)}
            className={`rounded-md px-2.5 py-1 text-xs font-semibold transition ${
              value === o.v ? o.active : 'bg-black/10'
            }`}
          >
            {o.label}
          </button>
        ))}
      </div>
    </div>
  );
}

const OUTCOME_META: Record<ContactOutcome, { color: string }> = {
  no_answer: { color: '#9aa0a6' },
  voicemail: { color: '#e0a52f' },
  spoke: { color: '#2f8f4e' },
  thinking: { color: '#2f74c0' },
  wants_attorney: { color: '#7c4dbd' },
  declined: { color: '#b5302a' },
  retained: { color: '#0d8f86' },
  lost: { color: '#6b7280' },
};

function ContactLogTab({
  lead,
  by,
  onRetain,
}: {
  lead: Lead;
  by?: string;
  onRetain: () => void;
}) {
  const [wizardOpen, setWizardOpen] = useState(false);
  const pending = (lead.followUps ?? [])
    .filter((f) => !f.done)
    .sort((a, b) => a.dueAt - b.dueAt);
  const attempts = [...(lead.contactAttempts ?? [])].sort((a, b) => b.ts - a.ts);

  return (
    <div className="space-y-5">
      <FirstAttemptCard lead={lead} onStart={() => setWizardOpen(true)} />
      <FirstAttemptModal
        lead={lead}
        by={by}
        open={wizardOpen}
        onClose={() => setWizardOpen(false)}
        onRetain={onRetain}
      />
      <FollowUpBanner lead={lead} pending={pending} onLog={() => setWizardOpen(true)} />
      <div>
        <div className="mb-2 flex items-center justify-between">
          <span className="field-label">Activity Timeline</span>
          <span className="font-type text-xs text-pad-inkSoft/70">
            {attempts.length} attempt{attempts.length === 1 ? '' : 's'}
          </span>
        </div>
        {attempts.length === 0 && pending.length === 0 ? (
          <p className="py-6 text-center font-type text-sm text-pad-inkSoft/60">
            No contact logged yet. Record the first attempt above.
          </p>
        ) : (
          <ul className="relative space-y-3 border-l-2 border-pad-line/50 pl-5">
            {pending.map((f) => (
              <li key={f.id} className="relative">
                <span
                  className="absolute -left-[26px] top-1 h-3 w-3 rounded-full border-2 border-pad-paper"
                  style={{ backgroundColor: '#e0792f' }}
                />
                <div className="flex items-center justify-between gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2">
                  <span className="font-type text-sm text-pad-ink">
                    Upcoming: <strong>{FOLLOWUP_LABELS[f.type]}</strong> ·{' '}
                    {fmtDate(new Date(f.dueAt).toISOString().slice(0, 10))}
                    {f.note ? ` — ${f.note}` : ''}
                  </span>
                  <button
                    className="shrink-0 rounded bg-emerald-600 px-2 py-0.5 text-xs font-semibold text-white"
                    onClick={() => completeFollowUp(lead, f.id)}
                  >
                    Done
                  </button>
                </div>
              </li>
            ))}
            {attempts.map((a, i) => {
              const meta = OUTCOME_META[a.outcome];
              return (
                <li key={i} className="relative">
                  <span
                    className="absolute -left-[26px] top-1 h-3 w-3 rounded-full border-2 border-pad-paper"
                    style={{ backgroundColor: meta.color }}
                  />
                  <div className="rounded-md bg-white/70 px-3 py-2">
                    <div className="flex items-center justify-between">
                      <span
                        className="font-type text-sm font-bold"
                        style={{ color: meta.color }}
                      >
                        {OUTCOME_LABELS[a.outcome]}
                      </span>
                      <span className="font-type text-xs text-pad-inkSoft/60">
                        {formatDistanceToNow(a.ts, { addSuffix: true })}
                      </span>
                    </div>
                    {a.notes && (
                      <p className="mt-1 font-type text-sm text-pad-ink">{a.notes}</p>
                    )}
                    {a.by && (
                      <p className="mt-0.5 font-type text-[11px] text-pad-inkSoft/50">
                        — {a.by}
                      </p>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}

function FirstAttemptCard({ lead, onStart }: { lead: Lead; onStart: () => void }) {
  const attempts = lead.contactAttempts ?? [];
  const made = attempts.length > 0;
  const first = made ? attempts[0] : null;
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border-2 border-pad-ink/15 bg-white/60 px-4 py-3">
      <div>
        <span className="field-label">First Contact Attempt</span>
        {made && first ? (
          <p className="font-type text-sm text-pad-ink">
            <span className="font-bold text-emerald-700">Yes</span> —{' '}
            {OUTCOME_LABELS[first.outcome]} ·{' '}
            {formatDistanceToNow(first.ts, { addSuffix: true })}
          </p>
        ) : (
          <p className="font-type text-sm text-pad-inkSoft">Not yet logged.</p>
        )}
      </div>
      <button className="btn-primary" onClick={onStart}>
        {made ? 'Log another attempt' : 'I made the first attempt →'}
      </button>
    </div>
  );
}

const ymd = (ms: number) => new Date(ms).toISOString().slice(0, 10);

// Snap a timestamp to a morning (9:00a) or afternoon (2:00p) slot.
function atTime(ms: number, period: 'morning' | 'afternoon'): number {
  const d = new Date(ms);
  d.setHours(period === 'morning' ? 9 : 14, 0, 0, 0);
  return d.getTime();
}

type WizStep = 'pick' | 'noContact' | 'spoke' | 'thinking' | 'attorney' | 'declined' | 'done';

function FirstAttemptModal({
  lead,
  by,
  open,
  onClose,
  onRetain,
}: {
  lead: Lead;
  by?: string;
  open: boolean;
  onClose: () => void;
  onRetain: () => void;
}) {
  const [step, setStep] = useState<WizStep>('pick');
  const [outcome, setOutcome] = useState<ContactOutcome | null>(null);
  const [period, setPeriod] = useState<'morning' | 'afternoon'>('morning');
  const [thinkDays, setThinkDays] = useState(3);
  const [attyDate, setAttyDate] = useState('');
  const [affirmed, setAffirmed] = useState(false);
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);
  const [nextMove, setNextMove] = useState('');

  useEffect(() => {
    if (open) {
      setStep('pick');
      setOutcome(null);
      setPeriod('morning');
      setThinkDays(3);
      setAttyDate('');
      setAffirmed(false);
      setNotes('');
      setNextMove('');
    }
  }, [open]);

  const finish = async (
    o: ContactOutcome,
    touches: { type: FollowUpType; dueAt: number; note: string }[],
    label: string,
    attorneyCallAt?: number,
  ) => {
    setBusy(true);
    await logCallOutcome(lead, o, { notes, by, touches, attorneyCallAt });
    setBusy(false);
    setOutcome(o);
    setNextMove(label);
    setStep('done');
    setTimeout(onClose, 1600);
  };

  // Court-relative re-marketing touches for a decline.
  const declinedTouches = (): { type: FollowUpType; dueAt: number; note: string }[] => {
    const out: { type: FollowUpType; dueAt: number; note: string }[] = [];
    const now = Date.now();
    if (lead.nextCourtDate) {
      const court = new Date(lead.nextCourtDate + 'T00:00:00').getTime();
      const t20 = atTime(court - 20 * DAY, period);
      const t7 = atTime(court - 7 * DAY, period);
      const after = atTime(court + DAY, period);
      if (t20 > now) out.push({ type: 'week_before', dueAt: t20, note: 'Motions deadline — continuance reminder + pitch (20 days out)' });
      if (t7 > now) out.push({ type: 'week_before', dueAt: t7, note: 'Week-before-court reminder + pitch' });
      if (after > now) out.push({ type: 'warrant', dueAt: after, note: 'Day-after-court warrant check' });
    }
    if (out.length === 0) out.push({ type: 'nurture', dueAt: atTime(now + 7 * DAY, period), note: 'Follow up' });
    return out;
  };

  const periodToggle = (
    <div className="mt-2 flex gap-2">
      {(['morning', 'afternoon'] as const).map((p) => (
        <button
          key={p}
          onClick={() => setPeriod(p)}
          className={`rounded-md px-3 py-1.5 font-type text-sm font-semibold capitalize transition ${
            period === p ? 'bg-pad-ink text-pad-paper' : 'bg-black/10 text-pad-ink hover:bg-black/20'
          }`}
        >
          {p} ({p === 'morning' ? '9:00a' : '2:00p'})
        </button>
      ))}
    </div>
  );

  return (
    <Modal open={open} onClose={onClose} width="max-w-lg">
      <div className="legal-pad rounded-lg p-6 pl-14 shadow-card">
        {/* STEP 1 — three big buttons */}
        {step === 'pick' && (
          <>
            <h3 className="font-hand text-3xl ink">
              {lead.contactAttempts?.length ? 'Log a Call' : 'First Contact Attempt'}
            </h3>
            <p className="mb-4 font-type text-xs text-pad-inkSoft">
              You just placed a call — what happened?
            </p>
            <div className="space-y-2.5">
              <BigChoice
                color="#9aa0a6"
                title="No Answer"
                desc="No one picked up — we'll set a callback for tomorrow."
                onClick={() => { setOutcome('no_answer'); setStep('noContact'); }}
              />
              <BigChoice
                color="#e0a52f"
                title="Left Voicemail"
                desc="Left a message — callback tomorrow."
                onClick={() => { setOutcome('voicemail'); setStep('noContact'); }}
              />
              <BigChoice
                color="#2f8f4e"
                title="Spoke to the Client"
                desc="You reached them — choose what happened next."
                onClick={() => setStep('spoke')}
                strong
              />
            </div>
          </>
        )}

        {/* STEP 2a — no contact: callback tomorrow */}
        {step === 'noContact' && outcome && (
          <>
            <BackBtn onClick={() => setStep('pick')} />
            <Stamp outcome={outcome} />
            <h3 className="font-hand text-2xl ink">Call back tomorrow</h3>
            <p className="font-type text-xs text-pad-inkSoft">
              Morning or afternoon? We'll log the {OUTCOME_LABELS[outcome].toLowerCase()} and put the callback on the calendar.
            </p>
            {periodToggle}
            <LogBar
              busy={busy}
              hint={`Callback ${fmtDate(ymd(Date.now() + DAY))} (${period})`}
              onClick={() => {
                const at = atTime(Date.now() + DAY, period);
                finish(outcome, [{ type: 'callback', dueAt: at, note: 'Call back' }], `Call back ${fmtDate(ymd(at))} (${period})`);
              }}
            />
          </>
        )}

        {/* STEP 2b — spoke: sub-outcomes */}
        {step === 'spoke' && (
          <>
            <BackBtn onClick={() => setStep('pick')} />
            <h3 className="font-hand text-2xl ink">You spoke with them — and?</h3>
            <button
              onClick={() => { onClose(); onRetain(); }}
              className="mt-3 flex w-full items-center justify-between gap-3 rounded-lg bg-emerald-600 px-4 py-3.5 text-left shadow-card transition hover:bg-emerald-700 active:scale-[0.98]"
            >
              <span>
                <span className="block font-type text-lg font-extrabold text-white">★ Retained the Client</span>
                <span className="block font-type text-sm text-emerald-50/90">They hired us — take payment &amp; retain.</span>
              </span>
              <span className="text-2xl text-white">›</span>
            </button>
            <div className="mt-3 space-y-2.5">
              <BigChoice color="#2f74c0" title="Thinking About It" desc="Interested but undecided — schedule a nurture call." onClick={() => { setOutcome('thinking'); setStep('thinking'); }} />
              <BigChoice color="#7c4dbd" title="Wants to Speak to the Attorney" desc="Book the consult and remind yourself to log the result." onClick={() => { setOutcome('wants_attorney'); setStep('attorney'); }} />
              <BigChoice color="#b5302a" title="Declined" desc="Not hiring now — set the court-date re-marketing reminders." onClick={() => { setOutcome('declined'); setStep('declined'); }} />
            </div>
          </>
        )}

        {/* STEP 3a — thinking */}
        {step === 'thinking' && outcome && (
          <>
            <BackBtn onClick={() => setStep('spoke')} />
            <Stamp outcome={outcome} />
            <h3 className="font-hand text-2xl ink">When should we follow up?</h3>
            <div className="mt-2 flex gap-2">
              {[3, 5, 7].map((d) => (
                <button key={d} onClick={() => setThinkDays(d)}
                  className={`rounded-md px-3 py-1.5 font-type text-sm font-semibold transition ${thinkDays === d ? 'bg-pad-ink text-pad-paper' : 'bg-black/10 text-pad-ink hover:bg-black/20'}`}>
                  {d === 7 ? '1 week' : `${d} days`}
                </button>
              ))}
            </div>
            {periodToggle}
            <textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} placeholder="What are they weighing? (optional)" className="mt-3 w-full rounded-md border border-black/10 bg-white/80 p-2 font-type text-sm text-pad-ink" />
            <LogBar busy={busy} hint={`Nurture ${fmtDate(ymd(Date.now() + thinkDays * DAY))} (${period})`}
              onClick={() => {
                const at = atTime(Date.now() + thinkDays * DAY, period);
                finish('thinking', [{ type: 'nurture', dueAt: at, note: `Nurture check-in (${thinkDays}-day)` }], `Nurture ${fmtDate(ymd(at))} (${period})`);
              }} />
          </>
        )}

        {/* STEP 3b — attorney */}
        {step === 'attorney' && outcome && (
          <>
            <BackBtn onClick={() => setStep('spoke')} />
            <Stamp outcome={outcome} />
            <h3 className="font-hand text-2xl ink">Schedule the attorney call</h3>
            <p className="font-type text-xs text-pad-inkSoft">Set when the consult is — we'll remind you to log the result afterward.</p>
            <label className="mt-3 block">
              <span className="field-label">Consult date</span>
              <input type="date" value={attyDate} min={ymd(Date.now())} onChange={(e) => setAttyDate(e.target.value)} className="mt-1 block rounded-md border border-black/10 bg-white/80 p-2 font-type text-sm" />
            </label>
            {periodToggle}
            <label className="mt-3 flex items-start gap-2 font-type text-sm text-pad-ink">
              <input type="checkbox" checked={affirmed} onChange={(e) => setAffirmed(e.target.checked)} className="mt-0.5" />
              <span>I've added this call to the firm's calendar (outside this app).</span>
            </label>
            <textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} placeholder="Notes for the attorney (optional)" className="mt-3 w-full rounded-md border border-black/10 bg-white/80 p-2 font-type text-sm text-pad-ink" />
            <LogBar busy={busy} disabled={!affirmed || !attyDate} hint={attyDate ? `Consult ${fmtDate(attyDate)} (${period})` : 'Pick a date & confirm calendar'}
              onClick={() => {
                const callAt = atTime(new Date(attyDate + 'T00:00:00').getTime(), period);
                const remindAt = callAt + 3 * 3600 * 1000;
                finish('wants_attorney', [{ type: 'attorney', dueAt: remindAt, note: 'Log the attorney call result' }], `Consult ${fmtDate(attyDate)} · log result after`, callAt);
              }} />
          </>
        )}

        {/* STEP 3c — declined */}
        {step === 'declined' && outcome && (
          <>
            <BackBtn onClick={() => setStep('spoke')} />
            <Stamp outcome={outcome} />
            <h3 className="font-hand text-2xl ink">Set the re-marketing reminders</h3>
            <p className="font-type text-xs text-pad-inkSoft">
              {lead.nextCourtDate
                ? 'We\u2019ll schedule value-add reminder calls around their court date:'
                : 'No court date on file — we\u2019ll set a one-week follow-up.'}
            </p>
            <ul className="mt-2 space-y-1">
              {declinedTouches().map((t, i) => (
                <li key={i} className="font-type text-xs text-pad-ink">
                  • {fmtDate(ymd(t.dueAt))} — {t.note}
                </li>
              ))}
            </ul>
            {periodToggle}
            <textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} placeholder="Why did they decline? (optional)" className="mt-3 w-full rounded-md border border-black/10 bg-white/80 p-2 font-type text-sm text-pad-ink" />
            <LogBar busy={busy} hint="Schedule reminders"
              onClick={() => {
                const t = declinedTouches();
                finish('declined', t, `${t.length} reminder${t.length > 1 ? 's' : ''} set`);
              }} />
          </>
        )}

        {/* STEP 4 — payoff */}
        {step === 'done' && outcome && (
          <motion.div className="flex flex-col items-center py-8 text-center" initial={{ opacity: 0, scale: 0.9 }} animate={{ opacity: 1, scale: 1 }}>
            <motion.span className="stamp text-4xl" style={{ color: OUTCOME_META[outcome].color }}
              initial={{ rotate: -12, scale: 1.6, opacity: 0 }} animate={{ rotate: -8, scale: 1, opacity: 1 }} transition={{ type: 'spring', stiffness: 260, damping: 14 }}>
              {OUTCOME_LABELS[outcome]}
            </motion.span>
            <p className="mt-4 font-type text-sm text-pad-ink">Logged ✓</p>
            <p className="mt-1 font-type text-sm font-semibold text-pad-inkSoft">Next move: {nextMove}</p>
          </motion.div>
        )}
      </div>
    </Modal>
  );
}

function BigChoice({
  color,
  title,
  desc,
  onClick,
  strong,
}: {
  color: string;
  title: string;
  desc: string;
  onClick: () => void;
  strong?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      className={`flex w-full items-center justify-between gap-3 rounded-lg border-2 bg-white/60 px-4 py-3 text-left transition hover:bg-white active:scale-[0.98] ${
        strong ? 'border-current' : 'border-black/10'
      }`}
      style={strong ? { color } : undefined}
    >
      <span>
        <span className="block font-type text-base font-bold" style={{ color }}>{title}</span>
        <span className="block font-type text-xs text-pad-inkSoft">{desc}</span>
      </span>
      <span className="font-type text-lg text-pad-inkSoft">›</span>
    </button>
  );
}

function BackBtn({ onClick }: { onClick: () => void }) {
  return (
    <button className="mb-2 font-type text-xs text-pad-inkSoft hover:underline" onClick={onClick}>
      ‹ Back
    </button>
  );
}

function Stamp({ outcome }: { outcome: ContactOutcome }) {
  return (
    <div className="mb-3">
      <span className="stamp text-lg" style={{ color: OUTCOME_META[outcome].color }}>
        {OUTCOME_LABELS[outcome]}
      </span>
    </div>
  );
}

function LogBar({
  busy,
  hint,
  onClick,
  disabled,
}: {
  busy: boolean;
  hint: string;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <div className="mt-5 flex items-center justify-between">
      <span className="font-type text-xs text-pad-inkSoft/70">{hint}</span>
      <button
        className="btn bg-emerald-600 text-white hover:bg-emerald-500 disabled:opacity-50"
        disabled={busy || disabled}
        onClick={onClick}
      >
        {busy ? 'Logging…' : 'Log it ✓'}
      </button>
    </div>
  );
}

const FOLLOWUP_LABELS: Record<FollowUpType, string> = {
  callback: 'Call back',
  nurture: 'Nurture check-in',
  week_before: 'Week-before-court call',
  day_before: 'Day-before-court call',
  warrant: 'Warrant follow-up',
  attorney: 'Attorney call',
};

// The designed hard rule, surfaced where the user actually works the client:
// a passed court date must be replaced or the case dismissed — resolve it inline.
function CourtPassedBanner({ lead }: { lead: Lead }) {
  const [date, setDate] = useState('');
  const [busy, setBusy] = useState(false);
  const today = new Date().toISOString().slice(0, 10);

  const setNewDate = async () => {
    if (!date) return;
    setBusy(true);
    await updateCourtDate(lead, date);
    setBusy(false);
    setDate('');
  };

  return (
    <div className="sticky bottom-[64px] z-20 flex flex-wrap items-center justify-between gap-2 border-t border-pad-red/40 bg-pad-red/15 px-6 py-2.5 backdrop-blur">
      <span className="font-type text-sm font-semibold text-white">
        ⚠ Court date passed{lead.nextCourtDate ? ` (${fmtDate(lead.nextCourtDate)})` : ''} — set the next date or mark the case dismissed.
      </span>
      <div className="flex flex-wrap items-center gap-2">
        <input
          type="date"
          value={date}
          min={today}
          onChange={(e) => setDate(e.target.value)}
          className="rounded bg-white/90 px-2 py-1 font-type text-xs text-pad-ink"
        />
        <button
          className="rounded bg-white px-2 py-1 font-type text-xs font-bold text-pad-red hover:bg-white/90 disabled:opacity-50"
          disabled={!date || busy}
          onClick={setNewDate}
        >
          Set new date
        </button>
        <button
          className="rounded bg-white/20 px-2 py-1 font-type text-xs font-semibold text-white hover:bg-white/30"
          onClick={() => markCaseDismissed(lead)}
        >
          Case dismissed
        </button>
      </div>
    </div>
  );
}

function FollowUpBanner({
  lead,
  pending,
  onLog,
}: {
  lead: Lead;
  pending: Lead['followUps'];
  onLog: () => void;
}) {
  const [now] = useState(() => Date.now());
  const next = pending[0];
  if (!next) {
    return (
      <div className="rounded-lg border border-pad-line/50 bg-white/50 px-4 py-3 font-type text-sm text-pad-inkSoft">
        No follow-up scheduled. Use the First Attempt card above to log a result
        and set one.
      </div>
    );
  }
  const overdue = next.dueAt < now;
  return (
    <div
      className={`rounded-lg border px-4 py-3 ${
        overdue ? 'border-pad-red bg-pad-red/10' : 'border-emerald-600/40 bg-emerald-600/10'
      }`}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="font-type text-sm text-pad-ink">
          <span className="field-label mr-2">Next Follow-Up</span>
          <strong>{FOLLOWUP_LABELS[next.type]}</strong> ·{' '}
          {fmtDate(new Date(next.dueAt).toISOString().slice(0, 10))}
          {overdue && <span className="ml-2 font-bold text-pad-red">OVERDUE</span>}
          {next.note ? ` — ${next.note}` : ''}
        </div>
        {/* Primary path: logging the call resolves this follow-up AND schedules
            the next one in a single step (no separate "mark done"). */}
        <button
          className="rounded-md bg-emerald-600 px-3 py-1.5 text-xs font-bold text-white hover:bg-emerald-700"
          onClick={onLog}
        >
          Log the call →
        </button>
      </div>
      {/* Secondary, lighter-weight options for when there was nothing to log. */}
      <div className="mt-2 flex items-center gap-3 border-t border-black/5 pt-2">
        <span className="font-type text-[11px] text-pad-inkSoft/70">Nothing to log?</span>
        <button
          className="rounded bg-black/10 px-2 py-0.5 text-[11px] font-semibold text-pad-ink hover:bg-black/20"
          onClick={() => snoozeFollowUp(lead, next.id, next.dueAt + DAY)}
        >
          Snooze 1 day
        </button>
        <button
          className="rounded bg-black/10 px-2 py-0.5 text-[11px] font-semibold text-pad-ink hover:bg-black/20"
          onClick={() => completeFollowUp(lead, next.id)}
        >
          Dismiss
        </button>
      </div>
    </div>
  );
}

function RetainPanel({
  lead,
  open,
  onClose,
  onRetained,
}: {
  lead: Lead;
  open: boolean;
  onClose: () => void;
  onRetained: () => Promise<void>;
}) {
  const [fee, setFee] = useState('');
  const [financed, setFinanced] = useState(false);
  const [nextDue, setNextDue] = useState('');
  const [monthly, setMonthly] = useState('');
  const [takeNow, setTakeNow] = useState('');
  const [method, setMethod] = useState<Payment['method']>('card');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!open) return null;

  const conflictBlocked = lead.conflictCheck.status === 'conflict';
  const noContact = (lead.contactAttempts?.length ?? 0) === 0;

  const confirm = async () => {
    if (conflictBlocked) {
      setError('Conflict check is flagged CONFLICT — resolve it in the Checks tab before retaining.');
      return;
    }
    const total = parseFloat(fee) || 0;
    if (!(total > 0)) {
      setError('Enter a total fee greater than $0 before retaining.');
      return;
    }
    const amt = parseFloat(takeNow);
    if (financed) {
      if (!(amt > 0)) {
        setError('Enter the down payment taken now.');
        return;
      }
      if (!(parseFloat(monthly) > 0)) {
        setError('Enter the monthly payment amount.');
        return;
      }
      if (!nextDue) {
        setError('Set the next payment due date.');
        return;
      }
    }
    setError(null);
    setBusy(true);
    const nextPaymentDue = financed && nextDue ? nextDue : null;
    await retainLead(lead, total, {
      isFinanced: financed,
      nextPaymentDue,
      monthlyAmount: financed ? parseFloat(monthly) : undefined,
    });
    if (amt > 0) {
      // Charge against the financing we just wrote so the initial payment keeps
      // the new total, the due date, and any existing warrant fee.
      const leadForCharge: Lead = {
        ...lead,
        financing: {
          ...lead.financing,
          totalFee: total,
          payments: [],
          nextPaymentDue,
        },
      };
      const res = await recordPayment(leadForCharge, {
        amount: amt,
        method,
        note: 'Initial payment at retention',
      });
      if (!res.ok) {
        setError(res.error || 'Could not record the payment.');
        setBusy(false);
        return;
      }
    }
    setBusy(false);
    onClose();
    await onRetained();
  };

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/60 p-4" onMouseDown={onClose}>
      <div
        className="legal-pad w-full max-w-md rounded-lg p-6 pl-14 shadow-card"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <h3 className="font-hand text-3xl ink">Retain {lead.name}</h3>
        <p className="mb-4 font-type text-xs text-pad-inkSoft">
          Record any payment taken, then mark retained. Court filings are handled
          by the next department.
        </p>

        {conflictBlocked && (
          <p className="mb-3 rounded-md bg-pad-red/10 p-2 font-type text-xs font-semibold text-pad-red">
            ⚠ Conflict check is flagged CONFLICT. Resolve it in the Checks tab
            before retaining this client.
          </p>
        )}
        {noContact && (
          <p className="mb-3 rounded-md bg-amber-500/15 p-2 font-type text-xs font-semibold text-amber-800">
            ⚠ No contact has been logged yet — make sure you've actually spoken
            with this client before retaining.
          </p>
        )}
        {error && (
          <p className="mb-3 rounded-md bg-pad-red/10 p-2 font-type text-xs font-semibold text-pad-red">
            {error}
          </p>
        )}

        <div className="space-y-3 font-type text-sm">
            <label className="block">
              <span className="field-label">Total Fee</span>
              <input
                type="number"
                value={fee}
                onChange={(e) => setFee(e.target.value)}
                className="mt-1 w-full rounded-md border border-black/10 bg-white/80 p-2"
                placeholder="e.g. 1500"
              />
            </label>
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={financed}
                onChange={(e) => setFinanced(e.target.checked)}
              />
              <span>Financed fee (payment plan)</span>
            </label>
            {financed && (
              <div className="grid grid-cols-2 gap-2">
                <label className="block">
                  <span className="field-label">Monthly Payment</span>
                  <input
                    type="number"
                    value={monthly}
                    onChange={(e) => setMonthly(e.target.value)}
                    className="mt-1 w-full rounded-md border border-black/10 bg-white/80 p-2"
                    placeholder="e.g. 250"
                  />
                </label>
                <label className="block">
                  <span className="field-label">Next Payment Due</span>
                  <input
                    type="date"
                    value={nextDue}
                    onChange={(e) => setNextDue(e.target.value)}
                    className="mt-1 w-full rounded-md border border-black/10 bg-white/80 p-2"
                  />
                </label>
              </div>
            )}
            <div className="border-t border-black/10 pt-3">
              <span className="field-label">
                {financed ? 'Down Payment (required)' : 'Take Payment Now (optional)'}
              </span>
              <div className="mt-1 flex gap-2">
                <input
                  type="number"
                  value={takeNow}
                  onChange={(e) => setTakeNow(e.target.value)}
                  className="w-1/2 rounded-md border border-black/10 bg-white/80 p-2"
                  placeholder={financed ? 'Down payment' : 'Amount'}
                />
                <select
                  value={method}
                  onChange={(e) => setMethod(e.target.value as Payment['method'])}
                  className="w-1/2 rounded-md border border-black/10 bg-white/80 p-2"
                >
                  {PAYMENT_METHODS.map((m) => (
                    <option key={m.value} value={m.value}>
                      {m.label}
                    </option>
                  ))}
                </select>
              </div>
            </div>
            <div className="flex justify-end gap-2 pt-2">
              <button className="btn-ghost text-pad-ink" onClick={onClose}>
                Cancel
              </button>
              <button
                className="btn bg-emerald-600 text-white"
                disabled={busy || conflictBlocked}
                onClick={confirm}
              >
                {busy ? 'Processing…' : 'Confirm Retain'}
              </button>
            </div>
        </div>
      </div>
    </div>
  );
}
