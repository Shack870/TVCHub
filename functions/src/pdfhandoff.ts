import { onCall, HttpsError } from "firebase-functions/v2/https";
import { onDocumentUpdated } from "firebase-functions/v2/firestore";
import { onSchedule } from "firebase-functions/v2/scheduler";
import { defineSecret } from "firebase-functions/params";
import { logger } from "firebase-functions/v2";
import { getFirestore } from "firebase-admin/firestore";
import { createSign } from "node:crypto";

// TVCHub -> Iron Rock PDF app case handoff.
//
// When a lead reaches Intake Complete it belongs to the next department, whose
// tool is the IronRockPDF court-filing generator (separate Firebase project
// `ironrockpdf`). This module writes the lead into that app's `cases`
// collection, shaped exactly like the PDF app's own blankCase() + TVC importer
// (see IronRockPDFMaker js/case-store.js and js/tvc-import.js), so the case
// shows up in the firm's shared workspace ready for document generation.
//
// Two entry points share the same mapping + write logic:
//   - `sendToPdfApp` callable: the "Send to PDF App" button in the UI.
//   - `autoSendToPdfApp` trigger: fires when a lead's stage transitions to
//     intake_complete and it has never been sent (pdfAppSentAt absent).
//
// Cross-project auth: a service account in the ironrockpdf project
// (tvchub-handoff@ironrockpdf.iam.gserviceaccount.com, roles/datastore.user)
// whose JSON key lives in the PDFAPP_SA_KEY secret. We mint an OAuth token by
// JWT-signing (same pattern as emailsync.ts delegatedToken, datastore scope,
// no sub claim) and talk to the Firestore REST API.

// Exported so the cadence sweep can reuse the same secret + token plumbing
// for its read-only motion check (see motionExistsInPdfApp below).
export const PDFAPP_SA_KEY = defineSecret("PDFAPP_SA_KEY");

const PDF_PROJECT = "ironrockpdf";
const FS_BASE = `https://firestore.googleapis.com/v1/projects/${PDF_PROJECT}/databases/(default)/documents`;
const WORKSPACE_ID = "ironrocklaw";

// When the auto-handoff first went live. The retry sweep only auto-sends
// leads that completed intake AFTER this moment — leads already at
// intake_complete before the feature shipped were deliberately excluded
// (they may have been hand-entered in the PDF app; dedup would usually catch
// that, but a mistyped case number there would create a duplicate).
const HANDOFF_LIVE_SINCE = Date.parse("2026-07-22T21:10:00Z");

const MAX_SEND_ATTEMPTS = 3;
const HOUR = 3600_000;

const b64url = (s: string | Buffer): string =>
  Buffer.from(s).toString("base64url");

// OAuth token for the ironrockpdf Firestore: sign a JWT with the SA key and
// exchange it at Google's token endpoint. Unlike the Gmail sync there is no
// `sub` claim — we act as the service account itself, not as a user.
export async function datastoreToken(keyJson: string): Promise<string> {
  const key = JSON.parse(keyJson) as { client_email: string; private_key: string };
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = b64url(
    JSON.stringify({
      iss: key.client_email,
      scope: "https://www.googleapis.com/auth/datastore",
      aud: "https://oauth2.googleapis.com/token",
      iat: now,
      exp: now + 3600,
    }),
  );
  const signer = createSign("RSA-SHA256");
  signer.update(`${header}.${claims}`);
  const jwt = `${header}.${claims}.${signer.sign(key.private_key, "base64url")}`;

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: `grant_type=${encodeURIComponent("urn:ietf:params:oauth:grant-type:jwt-bearer")}&assertion=${jwt}`,
  });
  const json = (await res.json()) as { access_token?: string; error?: string; error_description?: string };
  if (!res.ok || !json.access_token) {
    throw new Error(`PDF app token failed: ${json.error} ${json.error_description ?? ""}`.trim());
  }
  return json.access_token;
}

// ---------- Firestore REST value encoding ----------

type FsValue = Record<string, unknown>;

function toFsValue(v: unknown): FsValue {
  if (v === null || v === undefined) return { nullValue: null };
  if (typeof v === "boolean") return { booleanValue: v };
  if (typeof v === "number") {
    return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
  }
  if (typeof v === "string") return { stringValue: v };
  if (Array.isArray(v)) return { arrayValue: { values: v.map(toFsValue) } };
  if (v instanceof Date) return { timestampValue: v.toISOString() };
  return { mapValue: { fields: toFsFields(v as Record<string, unknown>) } };
}

function toFsFields(obj: Record<string, unknown>): Record<string, FsValue> {
  const out: Record<string, FsValue> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined) continue;
    out[k] = toFsValue(v);
  }
  return out;
}

// ---------- Lead -> caseData mapping ----------

// TVCHub Lead fields we read. Kept loose since we're consuming raw Firestore data.
interface LeadDoc {
  name?: string;
  phone?: string;
  altPhone?: string;
  email?: string;
  address?: string;
  birthdate?: string;
  driversLicense?: string;
  driversLicenseState?: string;
  driversLicenseType?: string;
  tvcCaseNumber?: string;
  coverageType?: string;
  caseOpenedOn?: string;
  vehicleType?: string;
  violationDate?: string;
  charge?: string;
  tickets?: { type?: string; number?: string; violation?: string; code?: string }[];
  courtName?: string;
  courtPhone?: string;
  courtAddress?: string;
  courtCity?: string;
  county?: string;
  state?: string;
  courtZip?: string;
  nextCourtDate?: string | null;
  nextCourtTime?: string;
  nextCourtType?: string;
  courtDateHistory?: { date?: string; time?: string; type?: string; reason?: string }[];
  financing?: { totalFee?: number };
  saleAmount?: number | null;
  stage?: string;
  intakeCompleteAt?: number | null;
  pdfAppSentAt?: number | null;
  pdfAppCaseId?: string | null;
  pdfAppSendError?: string | null;
  pdfAppSendErrorAt?: number | null;
  pdfAppSendAttempts?: number | null;
  pdfAppFailFlaggedAt?: number | null;
  deletedAt?: number | null;
}

const isoDay = (): string => new Date().toISOString().slice(0, 10);

// PDF-app-style case id (see case-store.js uid()).
function newCaseId(): string {
  return "c_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 8);
}

// "M/D/YYYY" -> "YYYY-MM-DD"; passes through values already in ISO form.
function toIsoDate(s: string | undefined): string {
  const v = String(s ?? "").trim();
  if (!v) return "";
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return v;
  const m = v.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!m) return "";
  return `${m[3]}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}`;
}

// Split TVCHub's single-line member address ("123 Main St, City, AR 72201")
// into the PDF app's defendant address fields. Mirrors tvc-import.js
// splitClientAddress.
function splitAddress(address: string | undefined): { line1: string; city: string; state: string; zip: string } {
  const out = { line1: "", city: "", state: "", zip: "" };
  const raw = String(address ?? "").replace(/\s+/g, " ").trim();
  if (!raw) return out;
  const parts = raw.split(/\s*,\s*/).filter(Boolean);
  // Well-formed "street[, unit], city, ST zip": last part is state+zip, the
  // one before it is the city, everything earlier is the street line. This
  // keeps apartment/suite segments on line1 instead of leaking into city.
  const last = parts[parts.length - 1] ?? "";
  const stZip = last.match(/^([A-Z]{2})\s+(\d{5}(?:-\d{4})?)$/);
  if (stZip && parts.length >= 3) {
    out.state = stZip[1];
    out.zip = stZip[2];
    out.city = parts[parts.length - 2];
    out.line1 = parts.slice(0, -2).join(", ");
    return out;
  }
  out.line1 = parts[0] ?? raw;
  const tail = parts.slice(1).join(" ");
  const m = tail.match(/^(.+?)\s+([A-Z]{2})\s+(\d{5}(?:-\d{4})?)$/);
  if (m) {
    out.city = m[1].trim();
    out.state = m[2];
    out.zip = m[3];
  } else if (tail) {
    out.line1 = [out.line1, tail].filter(Boolean).join(", ");
  }
  return out;
}

// TVCHub stores counties uppercase ("PULASKI"); the PDF app's court
// directory and importer use title case ("Pulaski"). Mirror the importer.
function titleCase(s: string | undefined): string {
  return String(s ?? "").toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());
}

// TVCHub stores the DL type as a bare letter ("A"); the PDF app's cdlClass
// field carries the importer's "Class A" form.
function cdlClassOf(s: string | undefined): string {
  const v = String(s ?? "").trim();
  if (/^[A-Za-z]$/.test(v)) return `Class ${v.toUpperCase()}`;
  return v;
}

function courtDateKind(type: string | undefined): "arraignment" | "pretrial" | "trial" | "unknown" {
  const t = String(type ?? "").toLowerCase().replace(/[\s_-]+/g, "");
  if (t.includes("arraign")) return "arraignment";
  if (t.includes("pretrial") || t.includes("preliminary") || t === "pre") return "pretrial";
  if (t.includes("trial")) return "trial";
  return "unknown";
}

interface CourtDateEntry {
  date: string;
  time: string;
  type: string;
  reason: string;
}

// All known court dates (prior entries plus the current next date), sorted
// ascending like the PDF app keeps them, with the derived charge dates.
// Shared by the initial handoff mapping and the post-handoff date push.
function buildCourtDates(lead: LeadDoc): {
  courtDates: CourtDateEntry[];
  arraignmentDate: string;
  trialDate: string;
} {
  const courtDates = [
    ...(lead.courtDateHistory ?? []).map((c) => ({
      date: toIsoDate(c.date) || String(c.date ?? ""),
      time: c.time ?? "",
      type: c.type ?? "",
      reason: c.reason ?? "",
    })),
    ...(lead.nextCourtDate
      ? [{
          date: toIsoDate(lead.nextCourtDate) || String(lead.nextCourtDate),
          time: lead.nextCourtTime ?? "",
          type: lead.nextCourtType ?? "",
          reason: "",
        }]
      : []),
  ]
    .filter((d) => d.date)
    .sort((a, b) => a.date.localeCompare(b.date));

  const trialDate = courtDates.find((d) => courtDateKind(d.type) === "trial")?.date ?? "";
  const arraignmentDate =
    courtDates.find((d) => courtDateKind(d.type) === "arraignment")?.date ??
    (courtDates[0]?.date ?? "");

  return { courtDates, arraignmentDate, trialDate };
}

// The lead's real fee for the PDF app's retainer.fee field. The PDF app keeps
// it as a bare numeric string — firmDefaults.retainerFee is '1125', the form
// input is text with placeholder "1125", and templates interpolate
// `$${caseData.retainer.fee}` — so no "$", no thousands separators.
// financing.totalFee is the authoritative quoted fee when financing exists;
// saleAmount (the dollar figure from the sale call) is the fallback.
function retainerFeeOf(lead: LeadDoc): string {
  const n = lead.financing?.totalFee ?? lead.saleAmount;
  if (typeof n !== "number" || !Number.isFinite(n) || n <= 0) return "";
  return Number.isInteger(n) ? String(n) : n.toFixed(2);
}

// Build the full caseData object in the exact shape of the PDF app's
// blankCase(), populated the same way its TVC importer populates a case.
export function mapLeadToCaseData(lead: LeadDoc): Record<string, unknown> {
  const today = isoDay();
  const nowIso = new Date().toISOString();
  const addr = splitAddress(lead.address);

  const { courtDates, arraignmentDate, trialDate } = buildCourtDates(lead);

  const violations = (lead.tickets ?? []).map((t) => t.violation).filter(Boolean) as string[];
  const chargeDescription = lead.charge || violations.join("; ");
  const isSpeeding = /\bspeed/i.test(chargeDescription);
  const ticketNumber = (lead.tickets ?? []).map((t) => t.number).find(Boolean) ?? "";

  // TVC's "Court Name" is sometimes just the county without a "Court" suffix;
  // the PDF app only adopts complete court names and otherwise derives
  // "{county} County District Court" itself (same rule as its importer).
  const courtName = /\bcourt\b/i.test(lead.courtName ?? "") ? (lead.courtName as string) : "";
  const courtState = String(lead.state ?? "").trim().toUpperCase();
  const courtCityStateZip = [
    [lead.courtCity, courtState].filter(Boolean).join(", "),
    lead.courtZip ?? "",
  ].filter(Boolean).join(" ").trim();

  return {
    id: newCaseId(),
    createdAt: today,
    updatedAt: today,
    workspaceId: WORKSPACE_ID,
    createdBy: { uid: "", email: "", at: "" },
    lastModifiedBy: { uid: "", email: "", at: "" },
    ownerUid: "",
    ownerEmail: "",
    court: {
      county: titleCase(lead.county),
      caseNumber: "",
      courtName,
      state: courtState,
      judgeName: "",
      judgeEmail: "",
      judgePhone: "",
      judgeAddressLine1: lead.courtAddress ?? "",
      judgeAddressLine2: courtCityStateZip,
      judgeAddressLine3: "",
      clerkName: "",
      clerkEmail: "",
      clerkPhone: "",
      clerkFax: "",
      courtPhone: lead.courtPhone ?? "",
    },
    defendant: {
      fullName: lead.name ?? "",
      phone: lead.phone ?? "",
      mobile: lead.altPhone ?? "",
      email: lead.email ?? "",
      dob: lead.birthdate ?? "",
      addressLine1: addr.line1,
      city: addr.city,
      state: addr.state,
      zip: addr.zip,
      driversLicense: [lead.driversLicenseState, lead.driversLicense].filter(Boolean).join(" "),
      cdlClass: cdlClassOf(lead.driversLicenseType),
      truckingCompany: "",
    },
    charge: {
      description: chargeDescription,
      accusationDate: toIsoDate(lead.violationDate),
      isSpeedingCase: isSpeeding,
      arraignmentDate,
      trialDate,
      nextHearingType: "Trial",
      nextHearingDate: "",
    },
    courtDates,
    discovery: {
      status: "none_received",
      receivedDate: "",
      reviewedDate: "",
      reviewIssues: "",
      reviewNotes: "",
      attorneyConferredAt: "",
      priorDiscoveryRequestDate: "",
      priorPleaDate: "",
    },
    prosecutor: { name: "", email: "", phone: "", fax: "" },
    // trialFee/matterDescription stay blank: the PDF app fills its own firm
    // defaults (ensureRetainerDefaults) for anything we leave empty.
    retainer: { fee: retainerFeeOf(lead), trialFee: "", matterDescription: "" },
    offer: { terms: "", responseDeadline: "", notes: "", sentAt: "" },
    flags: {
      absentiaProsecutorObjected: false,
      limineProsecutorObjected: false,
    },
    workflow: {
      initialPleadingsFiledAt: "",
      absentiaResponseStatus: "",
      absentiaResponseCheckedAt: "",
      absentiaOppositionResponseFiledAt: "",
      limineResponseStatus: "",
      limineResponseCheckedAt: "",
      limineOppositionResponseFiledAt: "",
      motionsDeadlineDiscoveryStatus: "",
      motionsDeadlineCheckedAt: "",
      pretrialDeadlineAction: "",
      pretrialDeadlineCheckedAt: "",
      trialDeadlineAction: "",
      trialDeadlineCheckedAt: "",
      absentiaRulingStatus: "",
      absentiaRulingCheckedAt: "",
      limineRulingStatus: "",
      limineRulingCheckedAt: "",
      arraignmentOutcomeStatus: "",
      arraignmentOutcomeCheckedAt: "",
      continuanceCheckedInAt: "",
      absentiaOrderInHandAt: "",
      absentiaWithdrawnAt: "",
      limineWithdrawnAt: "",
    },
    generated: {},
    // The TVC reference block, mirroring what the PDF app's own importer
    // stores from a referral sheet.
    tvc: {
      caseNumber: lead.tvcCaseNumber ?? "",
      ticketNumber,
      coverageType: lead.coverageType ?? "",
      openedDate: lead.caseOpenedOn ?? "",
      importedAt: nowIso,
      collapsed: false,
      member: {
        name: lead.name ?? "",
        address: lead.address ?? "",
        dob: lead.birthdate ?? "",
        phone: lead.phone ?? "",
        mobile: lead.altPhone ?? "",
        email: lead.email ?? "",
        dlNumber: lead.driversLicense ?? "",
        dlState: lead.driversLicenseState ?? "",
        dlClass: cdlClassOf(lead.driversLicenseType),
      },
      court: {
        name: lead.courtName ?? "",
        phone: lead.courtPhone ?? "",
        address: lead.courtAddress ?? "",
        city: lead.courtCity ?? "",
        state: courtState,
        zip: lead.courtZip ?? "",
      },
      charge: {
        vehicleType: lead.vehicleType ?? "",
        isCommercial: /commercial/i.test(lead.vehicleType ?? ""),
        violationDate: lead.violationDate ?? "",
        violations,
      },
      driver: {},
    },
    intakeOpen: {},
    status: "wizard",
    timeline: [],
    disposition: { type: "", date: "", notes: "" },
  };
}

// ---------- Dedup + write against the ironrockpdf project ----------

interface QueryRow {
  document?: { name: string; fields?: Record<string, FsValue> };
}

// Look for an existing workspace case with the same TVC case number (or, when
// the lead has none, the exact defendant name). Returns the existing case's
// doc id or null. Equality-only queries need no composite index.
async function findExistingCase(token: string, lead: LeadDoc): Promise<string | null> {
  const tvcNumber = String(lead.tvcCaseNumber ?? "").trim();
  const matchField = tvcNumber
    ? { path: "caseData.tvc.caseNumber", value: tvcNumber }
    : { path: "caseData.defendant.fullName", value: String(lead.name ?? "").trim() };
  if (!matchField.value) return null;

  const body = {
    structuredQuery: {
      from: [{ collectionId: "cases" }],
      where: {
        compositeFilter: {
          op: "AND",
          filters: [
            {
              fieldFilter: {
                field: { fieldPath: "workspaceId" },
                op: "EQUAL",
                value: { stringValue: WORKSPACE_ID },
              },
            },
            {
              fieldFilter: {
                field: { fieldPath: matchField.path },
                op: "EQUAL",
                value: { stringValue: matchField.value },
              },
            },
          ],
        },
      },
      limit: 1,
    },
  };
  const res = await fetch(`${FS_BASE}:runQuery`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`PDF app dedup query ${res.status}: ${await res.text()}`);
  const rows = (await res.json()) as QueryRow[];
  const hit = rows.find((r) => r.document?.name);
  if (!hit?.document) return null;
  return hit.document.name.split("/").pop() ?? null;
}

async function createCase(token: string, caseData: Record<string, unknown>): Promise<string> {
  const id = caseData.id as string;
  // Top-level shape mirrors the PDF app's own pushCase(): workspace + owner +
  // attribution mirrored beside the caseData payload for rules/queries.
  const doc = {
    workspaceId: WORKSPACE_ID,
    ownerUid: "",
    ownerEmail: "",
    createdBy: caseData.createdBy,
    lastModifiedBy: caseData.lastModifiedBy,
    caseData,
    updatedAt: new Date(),
  };
  const res = await fetch(`${FS_BASE}/cases?documentId=${encodeURIComponent(id)}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ fields: toFsFields(doc) }),
  });
  if (!res.ok) throw new Error(`PDF app case write ${res.status}: ${await res.text()}`);
  return id;
}

// Shared handoff: map, dedup, write, and stamp the TVCHub lead. Returns the
// PDF-app case id (existing or new) and whether it was a duplicate.
export async function handoffLead(
  leadId: string,
  sentBy: string,
  keyJson: string,
): Promise<{ caseId: string; duplicate: boolean }> {
  const db = getFirestore();
  const ref = db.collection("leads").doc(leadId);
  const snap = await ref.get();
  if (!snap.exists) throw new Error(`Lead ${leadId} not found`);
  const lead = snap.data() as LeadDoc;
  if (!String(lead.name ?? "").trim()) throw new Error("Lead has no client name — cannot hand off.");

  const token = await datastoreToken(keyJson);

  const existingId = await findExistingCase(token, lead);
  let caseId: string;
  let duplicate = false;
  if (existingId) {
    caseId = existingId;
    duplicate = true;
    logger.info("PDF handoff: case already exists, not duplicating", { leadId, caseId });
  } else {
    caseId = await createCase(token, mapLeadToCaseData(lead));
    logger.info("PDF handoff: case created", { leadId, caseId });
  }

  // Success clears any failure bookkeeping from earlier attempts so the UI
  // error state disappears and the retry sweep stops considering the lead.
  await ref.update({
    pdfAppSentAt: Date.now(),
    pdfAppCaseId: caseId,
    pdfAppSentBy: sentBy,
    pdfAppSendError: null,
    pdfAppSendErrorAt: null,
    pdfAppSendAttempts: 0,
    updatedAt: Date.now(),
  });

  return { caseId, duplicate };
}

// Failure bookkeeping shared by the trigger and the retry sweep: stamp the
// error on the lead, count the attempt, and after the final consecutive
// failure put an Action Item post-it on the desk (exactly once, guarded by
// pdfAppFailFlaggedAt) so a dropped case is never silent.
async function recordHandoffFailure(leadId: string, err: unknown): Promise<void> {
  const db = getFirestore();
  const ref = db.collection("leads").doc(leadId);
  const snap = await ref.get();
  if (!snap.exists) return;
  const lead = snap.data() as LeadDoc;
  const now = Date.now();
  const attempts = (lead.pdfAppSendAttempts ?? 0) + 1;
  const message = err instanceof Error ? err.message : String(err);

  await ref.update({
    pdfAppSendError: message,
    pdfAppSendErrorAt: now,
    pdfAppSendAttempts: attempts,
    ...(attempts >= MAX_SEND_ATTEMPTS && !lead.pdfAppFailFlaggedAt
      ? { pdfAppFailFlaggedAt: now }
      : {}),
    updatedAt: now,
  });

  if (attempts < MAX_SEND_ATTEMPTS || lead.pdfAppFailFlaggedAt) return;

  const name = lead.name || "(unnamed)";
  await db.collection("messages").add({
    kind: "tvc_message",
    source: "system",
    from: "PDF Handoff",
    fromName: "PDF Handoff",
    subject: `Case failed to reach PDF app — ${name}`,
    message:
      `${name} is intake-complete but ${attempts} attempts to create their case in the ` +
      `Iron Rock PDF app have failed. The case must be entered or the send fixed by hand.\n\n` +
      `Last error: ${message}\n` +
      `Lead: ${leadId}` +
      (lead.tvcCaseNumber ? ` · TVC #${lead.tvcCaseNumber}` : "") +
      (lead.phone ? ` · ${lead.phone}` : ""),
    tvcCaseNumber: lead.tvcCaseNumber ?? null,
    memberName: name,
    leadId,
    phone: lead.phone ?? null,
    email: lead.email ?? null,
    gmailMessageId: null,
    receivedAt: now,
    handled: false,
    createdAt: now,
    updatedAt: now,
  });
  logger.warn("PDF handoff: gave up after max attempts, post-it created", { leadId, attempts });
}

// ---------- Motion detection (read-only, for the cadence sweep) ----------

// Does the lead's PDF-app case already have a motion on file? Detection is
// deliberately CONSERVATIVE — we only answer true when the case data clearly
// shows one, and any doubt (missing case, fetch error, unexpected shape)
// answers false so the reminder still fires.
//
// Where motions live in the PDF app's caseData (see IronRockPDFMaker
// js/case-store.js and js/motion-tracks.js):
//   - caseData.generated is a map { templateId: 'YYYY-MM-DD' } stamped by
//     markGenerated() each time a document is produced. Motion templates all
//     carry ids starting with "motion" (motionForDiscovery, motionToContinue,
//     motionInAbsentia, motionInLimine — see js/templates.js).
//   - caseData.workflow.initialPleadingsFiledAt is the human-confirmed date
//     the opening packet (entry of appearance + motions) was FILED with the
//     court — the strongest signal a motion exists.
export async function motionExistsInPdfApp(
  token: string,
  caseId: string,
): Promise<boolean> {
  const res = await fetch(`${FS_BASE}/cases/${encodeURIComponent(caseId)}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    if (res.status !== 404) {
      logger.warn("PDF app motion check failed — treating as no motion", {
        caseId,
        status: res.status,
      });
    }
    return false;
  }
  const doc = (await res.json()) as {
    fields?: { caseData?: { mapValue?: { fields?: Record<string, FsValue> } } };
  };
  const caseFields = doc.fields?.caseData?.mapValue?.fields ?? {};

  const mapFields = (v: FsValue | undefined): Record<string, FsValue> =>
    ((v as { mapValue?: { fields?: Record<string, FsValue> } } | undefined)?.mapValue
      ?.fields ?? {});
  const str = (v: FsValue | undefined): string =>
    String((v as { stringValue?: string } | undefined)?.stringValue ?? "");

  if (str(mapFields(caseFields.workflow).initialPleadingsFiledAt)) return true;
  const generated = mapFields(caseFields.generated);
  return Object.entries(generated).some(
    ([templateId, v]) => templateId.startsWith("motion") && Boolean(str(v)),
  );
}

// ---------- Post-handoff court-date sync ----------

// Push ONLY the court-date-derived fields onto an existing PDF-app case via
// updateMask so nothing else in caseData is touched. Names, phones, and other
// intake fields are deliberately NOT synced after handoff: they rarely change,
// and the attorneys edit their copy in the PDF app — overwriting that work
// with a stale TVCHub value would be worse than a missed edit.
async function pushCourtDatesToCase(
  token: string,
  caseId: string,
  lead: LeadDoc,
): Promise<void> {
  const { courtDates, arraignmentDate, trialDate } = buildCourtDates(lead);
  const paths = [
    "caseData.courtDates",
    "caseData.charge.arraignmentDate",
    "caseData.charge.trialDate",
    "caseData.updatedAt",
    "updatedAt",
  ];
  const qs = paths
    .map((p) => `updateMask.fieldPaths=${encodeURIComponent(p)}`)
    .join("&");
  const body = {
    fields: toFsFields({
      caseData: {
        courtDates,
        charge: { arraignmentDate, trialDate },
        updatedAt: isoDay(),
      },
      updatedAt: new Date(),
    }),
  };
  // currentDocument.exists guards against resurrecting a case the attorneys
  // deleted in the PDF app as an empty stub containing only court dates.
  const res = await fetch(
    `${FS_BASE}/cases/${encodeURIComponent(caseId)}?${qs}&currentDocument.exists=true`,
    {
      method: "PATCH",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
  );
  if (!res.ok) throw new Error(`PDF app court-date update ${res.status}: ${await res.text()}`);
}

function courtFieldsChanged(before: LeadDoc, after: LeadDoc): boolean {
  return (
    (before.nextCourtDate ?? null) !== (after.nextCourtDate ?? null) ||
    (before.nextCourtTime ?? "") !== (after.nextCourtTime ?? "") ||
    (before.nextCourtType ?? "") !== (after.nextCourtType ?? "") ||
    JSON.stringify(before.courtDateHistory ?? []) !== JSON.stringify(after.courtDateHistory ?? [])
  );
}

// ---------- Entry points ----------

export const sendToPdfApp = onCall(
  { secrets: [PDFAPP_SA_KEY], timeoutSeconds: 60 },
  async (req) => {
    if (!req.auth) throw new HttpsError("unauthenticated", "Sign in required.");
    const leadId = String(req.data?.leadId ?? "").trim();
    if (!leadId) throw new HttpsError("invalid-argument", "leadId is required.");
    try {
      const result = await handoffLead(leadId, req.auth.uid, PDFAPP_SA_KEY.value());
      return { ok: true, ...result };
    } catch (e) {
      logger.error("PDF handoff failed", { leadId, error: String(e) });
      throw new HttpsError("internal", e instanceof Error ? e.message : "Handoff failed");
    }
  },
);

// Auto-handoff: the moment a lead transitions into intake_complete (and has
// never been sent), push it to the PDF app with sentBy 'auto'. Leads already
// at intake_complete before this feature shipped are NOT auto-sent — they may
// have been manually entered in the PDF app already; use the button instead.
//
// The same trigger also owns the post-handoff court-date sync: when a lead
// that already has a PDF-app case gets a changed next court date (or history),
// the new dates are pushed onto that case.
export const autoSendToPdfApp = onDocumentUpdated(
  { document: "leads/{leadId}", secrets: [PDFAPP_SA_KEY] },
  async (event) => {
    const before = event.data?.before.data() as LeadDoc | undefined;
    const after = event.data?.after.data() as LeadDoc | undefined;
    if (!before || !after) return;
    const leadId = event.params.leadId;

    const becameComplete =
      before.stage !== "intake_complete" && after.stage === "intake_complete";
    if (becameComplete && !after.pdfAppSentAt) {
      try {
        await handoffLead(leadId, "auto", PDFAPP_SA_KEY.value());
      } catch (e) {
        // Stamp the failure so the UI shows it and the retry sweep picks it
        // up — throwing would just make the trigger retry against the same
        // data immediately.
        logger.error("Auto PDF handoff failed", { leadId, error: String(e) });
        await recordHandoffFailure(leadId, e);
      }
      return;
    }

    // Court dates move after intake (continuances, reset dockets). Keep the
    // PDF-app case's calendar current; everything else stays hands-off.
    if (after.pdfAppCaseId && courtFieldsChanged(before, after)) {
      try {
        const token = await datastoreToken(PDFAPP_SA_KEY.value());
        await pushCourtDatesToCase(token, after.pdfAppCaseId, after);
        await event.data!.after.ref.update({ pdfAppUpdatedAt: Date.now() });
        logger.info("PDF handoff: court dates pushed", {
          leadId,
          caseId: after.pdfAppCaseId,
          nextCourtDate: after.nextCourtDate ?? null,
        });
      } catch (e) {
        logger.error("PDF app court-date push failed", { leadId, error: String(e) });
      }
    }
  },
);

// Retry sweep: hourly safety net so a failed auto-send never silently drops a
// case. Picks up intake-complete leads that are unsent because
//   (a) the handoff failed (pdfAppSendError stamped), or
//   (b) the trigger never fired at all (no error, no stamp, intake completed
//       over an hour ago — but only after HANDOFF_LIVE_SINCE; see above).
// Each lead gets up to MAX_SEND_ATTEMPTS tries, then recordHandoffFailure
// raises the Action Item post-it once and the sweep leaves it alone.
export const retryPdfHandoff = onSchedule(
  { schedule: "every 60 minutes", secrets: [PDFAPP_SA_KEY], timeoutSeconds: 300 },
  async () => {
    const db = getFirestore();
    const snap = await db
      .collection("leads")
      .where("stage", "==", "intake_complete")
      .get();
    const now = Date.now();
    let retried = 0;
    let succeeded = 0;

    for (const doc of snap.docs) {
      const lead = doc.data() as LeadDoc;
      if (lead.deletedAt || lead.pdfAppSentAt) continue;

      const failedBefore = Boolean(lead.pdfAppSendError);
      const neverFired =
        !failedBefore &&
        typeof lead.intakeCompleteAt === "number" &&
        lead.intakeCompleteAt > HANDOFF_LIVE_SINCE &&
        now - lead.intakeCompleteAt > HOUR;
      if (!failedBefore && !neverFired) continue;
      if ((lead.pdfAppSendAttempts ?? 0) >= MAX_SEND_ATTEMPTS) continue; // already flagged

      retried++;
      try {
        await handoffLead(doc.id, "auto-retry", PDFAPP_SA_KEY.value());
        succeeded++;
        logger.info("PDF handoff retry succeeded", { leadId: doc.id });
      } catch (e) {
        logger.error("PDF handoff retry failed", { leadId: doc.id, error: String(e) });
        await recordHandoffFailure(doc.id, e);
      }
    }

    if (retried > 0) {
      logger.info("PDF handoff retry sweep complete", { retried, succeeded });
    }
  },
);
