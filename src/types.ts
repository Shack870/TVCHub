// Core data model for TVCHub intake & sales.
// A single `Lead` document is carried through the whole lifecycle.

export type Stage =
  | 'new' // freshly ingested, sitting on the notepad board
  | 'callback' // attempted, no answer / voicemail -> needs another attempt
  | 'pitched' // spoke with them, pitch delivered, awaiting decision
  | 'attorney_call' // requested to speak with an attorney, call scheduled
  | 'nurture' // declined / thinking -> sales command center follow-ups
  | 'retained' // hired us
  | 'intake_complete' // handed off to the next department
  | 'lost'; // dead / unreachable / not interested — terminal, off the board

export type ContactOutcome =
  | 'no_answer'
  | 'voicemail'
  | 'spoke'
  | 'declined'
  | 'thinking'
  | 'wants_attorney'
  | 'retained'
  | 'lost';

export type FollowUpType =
  | 'callback'
  | 'nurture'
  | 'week_before'
  | 'day_before'
  | 'warrant'
  | 'attorney';

export type CheckStatus = 'pending' | 'clear' | 'conflict';

export interface ContactAttempt {
  ts: number; // epoch ms
  outcome: ContactOutcome;
  notes?: string;
  by?: string; // user display name / uid
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
