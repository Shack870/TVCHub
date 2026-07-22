// Core data model for TVCHub intake & sales.
// A single `Lead` document is carried through the whole lifecycle.

export type Stage =
  | 'new' // freshly ingested, sitting on the notepad board
  | 'callback' // attempted, no answer / voicemail -> needs another attempt
  | 'pitched' // spoke with them, pitch delivered, awaiting decision
  | 'attorney_call' // requested to speak with an attorney, call scheduled
  | 'nurture' // declined / thinking -> sales command center follow-ups
  | 'retained' // hired us
  | 'financed' // hired us on a payment plan — actively paying, not paid off
  | 'intake_complete' // handed off to the next department
  | 'lost'; // dead / unreachable / not interested — terminal, off the board

export type ContactOutcome =
  | 'no_answer'
  | 'voicemail'
  | 'spoke'
  | 'declined'
  | 'thinking'
  | 'verbal_yes' // said yes on the call, but payment wasn't collected
  | 'wants_attorney'
  | 'retained'
  | 'lost';

// Sale detection rolled up from call-transcript analysis. "promised_unpaid"
// is the money-on-the-table state: they agreed to buy but no payment was
// taken on the call — needs a billing follow-up, not another pitch.
export type SaleStatus = 'none' | 'paid_full' | 'paid_partial' | 'promised_unpaid';

export type FollowUpType =
  | 'callback'
  | 'nurture'
  | 'week_before'
  | 'day_before'
  | 'warrant'
  | 'attorney'
  | 'billing'; // collect a payment that was promised on a call

export type CheckStatus = 'pending' | 'clear' | 'conflict';

export interface ContactAttempt {
  ts: number; // epoch ms
  outcome: ContactOutcome;
  notes?: string;
  by?: string; // user display name / uid
  // Set by the CallRail / Gmail / Square syncs for auto-logged activity.
  via?: 'callrail' | 'email' | 'square';
  callId?: string;
  paymentId?: string; // Square payment id (via 'square')
  recordingUrl?: string | null;
  durationSec?: number | null;
  // Transcript analysis (advisory only — never drives stage changes).
  ai?: {
    connection: 'conversation' | 'brief' | 'voicemail' | 'wrong_number' | 'unclear';
    pitched: boolean;
    pitchResult: 'bought' | 'declined' | 'thinking' | 'not_pitched';
    summary: string;
    commitments: string[];
    callbackAt: string | null;
    upset: boolean;
    // Sale block: "bought" only counts as paid when the transcript shows
    // payment actually being taken on the call.
    saleStatus?: SaleStatus;
    saleAmount?: number | null;
    paymentPlan?: 'full' | 'financed' | 'unknown';
    paymentPromise?: string | null;
    nonPaymentReason?: string | null;
  };
}

export interface FollowUp {
  id: string;
  type: FollowUpType;
  dueAt: number; // epoch ms
  done: boolean;
  doneAt?: number;
  note?: string;
}

export interface CourtDate {
  date: string; // ISO yyyy-mm-dd
  time?: string;
  type?: string; // Arraignment, Pre-Trial, Trial...
  reason?: string;
}

export interface LeadAttachment {
  name: string;
  path: string; // Storage path
  url?: string; // tokenized download URL
  contentType?: string;
  size?: number;
}

export interface Ticket {
  type?: string;
  number?: string;
  violation?: string;
  code?: string;
}

export interface Payment {
  id: string;
  amount: number;
  date: number; // epoch ms
  // Payments are taken outside the app (firm terminal, cash, check) and
  // recorded here for tracking.
  method: 'card' | 'cash' | 'check' | 'other';
  note?: string;
}

export interface Financing {
  totalFee: number;
  warrantFee?: number;
  payments: Payment[];
  nextPaymentDue?: string | null; // ISO date
  monthlyAmount?: number; // expected monthly payment for a financed plan
}

export interface ConflictCheck {
  status: CheckStatus;
  notes?: string;
}

export interface CourtNotesCheck {
  allowsTrialInAbstentia: boolean | null;
  allowsWaiver: boolean | null;
  notes?: string;
}

export interface Lead {
  id: string;

  // --- Identity (TVC member) ---
  tvcCaseNumber?: string;
  coverageType?: string; // e.g. "25%"
  name: string;
  phone?: string;
  altPhone?: string; // secondary number (home / work / family)
  email?: string;
  address?: string;
  birthdate?: string;
  language?: string;
  driversLicense?: string;
  driversLicenseState?: string;
  driversLicenseType?: string;
  vehicleType?: string;
  violationDate?: string;
  caseOpenedOn?: string;

  // --- Ticket Info (referral metadata) ---
  familyMemberName?: string;
  familyMemberRelationship?: string;

  // --- Tickets / charges ---
  tickets?: Ticket[];
  charge?: string; // summary

  // --- Attorney Info (our firm, from the referral sheet) ---
  attorneyNames?: string;
  firmName?: string;
  firmAddress?: string;
  firmPhone?: string;
  firmFax?: string;
  attorneyMobile?: string;
  attorneyEmail?: string;
  lawType?: string;

  // --- Notes / activity log from the referral ---
  tvcNotes?: string;

  // --- Court ---
  courtName?: string;
  courtPhone?: string;
  courtAddress?: string;
  courtCity?: string;
  county?: string;
  state?: string;
  courtZip?: string;
  // Driver Info (right column of the TVC sheet)
  movingViolation?: string;
  preExisting?: string;
  accidentInvolved?: string;
  examinationReport?: string;
  nextCourtDate?: string | null; // ISO date
  nextCourtTime?: string;
  nextCourtType?: string;
  courtDateHistory?: CourtDate[];
  caseDismissed?: boolean;

  // --- Source ---
  source: 'manual' | 'paste' | 'gmail';
  // Set when ingestion matched a TVC referral but couldn't parse a client name,
  // so it's surfaced as a flagged card to fix rather than silently dropped.
  needsReview?: boolean;
  rawEmail?: string;
  pdfUrl?: string;
  attachments?: LeadAttachment[];
  receivedAt: number;
  // Set when TVC re-sends a case we already have — the board floats the card
  // back to the top and stamps it as re-sent.
  lastReferralAt?: number;
  referralCount?: number;
  // Cadence engine bookkeeping (see functions/src/cadence.ts).
  lastConnectedAt?: number | null; // last real two-way conversation
  cadenceExhaustedAt?: number | null; // chase gave up after max attempts
  courtPassedNotifiedAt?: number | null; // court date passed while undecided

  // Sale rollup from call analysis (see functions/src/callrail.ts). The
  // promised_unpaid state drives the gold "SAID YES · COLLECT" treatment.
  saleStatus?: SaleStatus | null;
  saleStatusAt?: number | null; // ts of the call/action that set saleStatus
  salePromisedAt?: number | null; // when the verbal yes happened
  saleAmount?: number | null; // dollar figure quoted/collected, when known
  saleEscalatedAt?: number | null; // billing cadence raised the decision post-it
  saleNonPaymentReason?: string | null; // classifier's read on why no money moved
  salePursuitAlertAt?: number | null; // no-pursuit alarm raised (no call since promise)
  squarePaidTotal?: number | null; // dollars collected via Square (see functions/src/squaresync.ts)
  squareVerifyFlaggedAt?: number | null; // transcript-says-paid-but-no-charge alarm raised
  // Audit trail for automatic stage moves (classifier-confirmed payments).
  autoStageNote?: string | null;
  autoStageAt?: number | null;

  // --- Ownership ---
  owner?: string | null; // display label of the operator who owns this lead
  ownerUid?: string | null;

  // --- Lifecycle ---
  stage: Stage;
  contactAttempts: ContactAttempt[];
  pitchDelivered?: boolean;
  attorneyCallAt?: number | null;
  lostAt?: number | null;
  lostReason?: string;
  followUps: FollowUp[];

  // --- Intake checks ---
  conflictCheck: ConflictCheck;
  courtNotesCheck: CourtNotesCheck;

  // --- Retainer ---
  retainedAt?: number | null; // when the client was retained (for weekly reporting)
  retainerSentForSignature?: boolean;
  retainerSignedConfirmed?: boolean;

  // --- Financing ---
  isFinanced?: boolean;
  financing?: Financing;
  hasWarrant?: boolean;

  // --- Handoff ---
  intakeComplete?: boolean;
  intakeCompleteAt?: number | null;

  // --- Meta ---
  createdAt: number;
  updatedAt: number;
  // Soft-delete: archived files are hidden from every view but kept in the
  // database so a mistaken delete can be undone.
  deletedAt?: number | null;
}

export interface AppUser {
  uid: string;
  email: string | null;
  displayName: string | null;
}

// A human note from TVC staff (question, complaint, status request) — displayed
// as a post-it on the Desk rather than a lead card. Created by the ingest
// function; the app only toggles `handled`.
export interface TvcMessage {
  id: string;
  // 'tvc_message' = human note from TVC staff; 'missed_call' = CallRail-detected
  // missed inbound call from a lead; 'billing_escalation' = the cadence engine
  // flagging promised money that was never collected.
  kind?: 'tvc_message' | 'missed_call' | 'billing_escalation';
  // Who stuck this note on the desk. Older docs may lack it — the UI falls
  // back to kind/from heuristics (see noteSplit in NotepadBoard).
  source?: 'human' | 'system' | null;
  // Client contact info so system post-its are actionable in one tap.
  phone?: string | null;
  email?: string | null;
  // Why money didn't change hands on the promise call (from the transcript
  // classifier) — rendered on the blue note under the flip-up billing post-it.
  nonPaymentReason?: string | null;
  // Maximum urgency: money was promised and NOT ONE call (in or out) has
  // happened since. Cleared/downgraded once any later call exists.
  noPursuit?: boolean | null;
  leadId?: string | null;
  callrailCallId?: string | null;
  from: string;
  fromName: string;
  subject?: string | null;
  message: string;
  tvcCaseNumber?: string | null;
  memberName?: string | null;
  receivedAt: number;
  handled: boolean;
  handledAt?: number | null;
  handledBy?: string | null;
  createdAt: number;
  updatedAt: number;
  // Soft-delete: archived notes disappear from the desk but stay in the
  // database.
  deletedAt?: number | null;
}
