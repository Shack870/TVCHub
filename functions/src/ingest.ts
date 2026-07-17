import { onRequest } from "firebase-functions/v2/https";
import { defineSecret, defineString } from "firebase-functions/params";
import { logger } from "firebase-functions/v2";
import { getFirestore } from "firebase-admin/firestore";
import { getStorage } from "firebase-admin/storage";
import { randomUUID } from "node:crypto";
import { convert as htmlToText } from "html-to-text";

const BUCKET = "tvchub-f2401.firebasestorage.app";
import { isTvcReferral, parseTvc } from "./parser.js";
import { extractLead, extractLeadFromPdf } from "./llm.js";

// Shared secret so only our Apps Script can post here.
export const INGEST_TOKEN = defineSecret("INGEST_TOKEN");
const OPENAI_API_KEY_INGEST = defineSecret("OPENAI_API_KEY");
const OPENAI_MODEL_INGEST = defineString("OPENAI_MODEL");

interface IngestAttachment {
  name: string;
  contentType?: string;
  dataB64: string;
}

interface IngestBody {
  token?: string;
  messageId?: string;
  subject?: string;
  from?: string;
  plainBody?: string;
  htmlBody?: string;
  receivedAt?: number;
  attachments?: IngestAttachment[];
}

interface SavedAttachment {
  name: string;
  path: string;
  url: string;
  contentType?: string;
  size: number;
}

// --- Identity-matching helpers (fallback dedup when no case number) ---------
const digitsOnly = (s: unknown): string => String(s ?? "").replace(/\D/g, "");
const lower = (s: unknown): string => String(s ?? "").trim().toLowerCase();
const countyKey = (s: unknown): string => lower(s).replace(/[^a-z]/g, "");
const nameTokens = (s: unknown): string[] =>
  lower(s)
    .replace(/[^a-z0-9 ]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 1);

// True when one name's tokens are a subset of the other's, sharing >= 2 tokens.
// Handles "Awet Hayle" vs "Awet Teweldebrahan Hayle" without matching unrelated
// people who merely share a single common first name.
function nameMatches(a: unknown, b: unknown): boolean {
  const ta = new Set(nameTokens(a));
  const tb = new Set(nameTokens(b));
  if (ta.size < 2 || tb.size < 2) return false;
  const [small, big] = ta.size <= tb.size ? [ta, tb] : [tb, ta];
  let shared = 0;
  for (const t of small) if (big.has(t)) shared++;
  return shared === small.size && shared >= 2;
}

// Pulls a 6-8 digit TVC case number out of the email subject as a backstop for
// PDF-only emails whose body/PDF extraction missed it. Prefers a number with
// TVC/Case/# context (subjects can also carry member ids, e.g. "(19830758)");
// otherwise accepts the subject's single unambiguous 6-8 digit number, which
// covers formats like "TVC NEW 25% CASE FILES - 1561355 - MANUEL COSTA" and
// "Alberta King - 1525899".
function caseNumberFromSubject(subject: string): string | undefined {
  const labeled =
    subject.match(/(?:TVC|Legal\s*Case|Case)\D{0,20}?(\d{6,8})/i)?.[1] ||
    subject.match(/#\s*(\d{6,8})/)?.[1];
  if (labeled) return labeled;
  const all = [...subject.matchAll(/\b(\d{6,8})\b/g)].map((m) => m[1]);
  const uniq = [...new Set(all)];
  return uniq.length === 1 ? uniq[0] : undefined;
}

// Recovers the member's name from the subject line when body/PDF extraction
// couldn't find one — TVC subjects usually carry it ("Case:1559085 - Ronald
// Brisa (19830758)", "TVC NEW 25% CASE FILES - 1561355 - MANUEL ERNESTO
// COSTA"). Only trusted when the subject also yielded a case number, so a
// generic subject like "Forwarded email" can never become a lead name.
function nameFromSubject(subject: string): string | undefined {
  const cleaned = subject
    .replace(/\(?\d{5,}\)?/g, " ") // case numbers / member ids
    .replace(/\d+\s*%/g, " ") // "25%" coverage markers
    .replace(/\b(TVC|NEW|CASE|FILES?|LEGAL|COVERAGE|RE|FWD?|FW)\b:?/gi, " ")
    .replace(/[#:()[\]\-–—_,.]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const words = cleaned.split(" ").filter((w) => /^[A-Za-z][A-Za-z.'-]*$/.test(w));
  if (words.length < 2 || words.length > 5) return undefined;
  return words.join(" ");
}

// Uploads email attachments to referrals/{leadId}/ and returns their metadata
// with a tokenized download URL for the UI.
async function storeAttachments(
  leadId: string,
  attachments: IngestAttachment[],
): Promise<SavedAttachment[]> {
  const bucket = getStorage().bucket(BUCKET);
  const saved: SavedAttachment[] = [];
  const seen = new Set<string>();
  for (const a of attachments) {
    if (!a.dataB64 || !a.name || seen.has(a.name)) continue;
    seen.add(a.name);
    const buf = Buffer.from(a.dataB64, "base64");
    if (buf.length > 25 * 1024 * 1024) continue; // skip oversized
    const token = randomUUID();
    const path = `referrals/${leadId}/${a.name}`;
    await bucket.file(path).save(buf, {
      contentType: a.contentType || "application/octet-stream",
      metadata: { metadata: { firebaseStorageDownloadTokens: token } },
    });
    const url = `https://firebasestorage.googleapis.com/v0/b/${BUCKET}/o/${encodeURIComponent(
      path,
    )}?alt=media&token=${token}`;
    saved.push({ name: a.name, path, url, contentType: a.contentType, size: buf.length });
  }
  return saved;
}

// Creates a lead doc (real or flagged review card) and saves its attachments.
async function createLeadDoc(
  db: ReturnType<typeof getFirestore>,
  fields: Record<string, unknown>,
  body: IngestBody,
  text: string,
  opts: { name: string; needsReview?: boolean },
): Promise<string> {
  const now = Date.now();
  const ref = await db.collection("leads").add({
    ...fields,
    name: opts.name,
    needsReview: opts.needsReview ?? false,
    source: "gmail",
    gmailMessageId: body.messageId || null,
    subject: body.subject || null,
    rawEmail: text.slice(0, 20000),
    receivedAt: body.receivedAt || now,
    stage: "new",
    contactAttempts: [],
    followUps: [],
    conflictCheck: { status: "clear" },
    courtNotesCheck: { allowsTrialInAbstentia: null, allowsWaiver: null },
    createdAt: now,
    updatedAt: now,
  });
  if (body.attachments?.length) {
    try {
      const saved = await storeAttachments(ref.id, body.attachments);
      if (saved.length) await ref.update({ attachments: saved, pdfUrl: saved[0].url });
    } catch (e) {
      logger.error("Attachment save failed", e);
    }
  }
  return ref.id;
}

// Fields a fallback match merges into the existing card (without overwriting
// values it already has). Excludes bookkeeping fields handled elsewhere.
const MERGEABLE_FIELDS = [
  "tvcCaseNumber", "name", "phone", "email", "address", "birthdate", "language",
  "driversLicense", "driversLicenseState", "driversLicenseType", "vehicleType",
  "violationDate", "caseOpenedOn", "tickets", "charge", "courtName", "courtPhone",
  "courtAddress", "courtCity", "county", "state", "courtZip", "nextCourtDate",
  "nextCourtTime", "nextCourtType", "tvcNotes",
];

const isEmpty = (v: unknown): boolean =>
  v === undefined ||
  v === null ||
  v === "" ||
  (Array.isArray(v) && v.length === 0);

// Last-resort dedup for referrals that arrive without a usable case number
// (e.g. PDF-only emails whose extraction came back thin). Scans recent leads
// and matches on phone, email, or name + county so a second copy of the same
// person merges into the existing card instead of spawning a duplicate.
// Returns the matched doc, or null when this is a genuinely new lead.
async function findIdentityMatch(
  db: ReturnType<typeof getFirestore>,
  fields: Record<string, unknown>,
): Promise<FirebaseFirestore.QueryDocumentSnapshot | null> {
  const phone = digitsOnly(fields.phone);
  const email = lower(fields.email);
  const county = countyKey(fields.county);
  const name = fields.name;

  const snap = await db
    .collection("leads")
    .orderBy("createdAt", "desc")
    .limit(500)
    .select(
      "name", "phone", "email", "county", "tvcCaseNumber",
      "attachments", ...MERGEABLE_FIELDS,
    )
    .get();

  // Require a name match plus a corroborating signal (same phone, email, or
  // county). Name-only is too loose (common names); phone/email-only is unsafe
  // because trucking companies submit multiple drivers under one shared line.
  for (const doc of snap.docs) {
    const d = doc.data();
    if (!nameMatches(name, d.name)) continue;
    const samePhone = Boolean(phone) && digitsOnly(d.phone) === phone;
    const sameEmail = Boolean(email) && lower(d.email) === email;
    const sameCounty = Boolean(county) && countyKey(d.county) === county;
    if (samePhone || sameEmail || sameCounty) return doc;
  }
  return null;
}

// Fills in any fields the existing card is missing from this newer copy, without
// clobbering data it already has. Also attaches a PDF if the existing card had
// none. Returns the list of field keys that were filled.
async function mergeIntoExisting(
  existing: FirebaseFirestore.QueryDocumentSnapshot,
  fields: Record<string, unknown>,
  body: IngestBody,
  opts: { bump?: boolean } = {},
): Promise<string[]> {
  const ex = existing.data();
  const update: Record<string, unknown> = {};
  const filled: string[] = [];

  // A true re-send (new Gmail message for a case we already have) usually means
  // TVC is nudging the firm about an unworked referral. Stamp it so the board
  // can float the card back to the top instead of leaving it buried under its
  // original arrival date.
  if (opts.bump) {
    update.lastReferralAt = Date.now();
    update.referralCount =
      (typeof ex.referralCount === "number" ? ex.referralCount : 1) + 1;
    filled.push("lastReferralAt");
  }
  for (const key of MERGEABLE_FIELDS) {
    // The "⚠ Needs Review" placeholder counts as an empty name so a reprocess
    // with a real extraction can replace it.
    const exEmpty =
      isEmpty(ex[key]) ||
      (key === "name" && /needs review/i.test(String(ex[key] ?? "")));
    if (!isEmpty(fields[key]) && exEmpty) {
      update[key] = fields[key];
      filled.push(key);
    }
  }

  // Append any attachments this copy carries that the existing card doesn't
  // already have (matched by filename). A PDF-only re-send often bundles the
  // citation scans that the original text email lacked.
  const exAtts: SavedAttachment[] = Array.isArray(ex.attachments) ? ex.attachments : [];
  const exNames = new Set(exAtts.map((a) => a?.name));
  const newAtts = (body.attachments || []).filter((a) => a.name && !exNames.has(a.name));
  if (newAtts.length) {
    try {
      const saved = await storeAttachments(existing.id, newAtts);
      if (saved.length) {
        update.attachments = [...exAtts, ...saved];
        if (isEmpty(ex.pdfUrl)) update.pdfUrl = saved[0].url;
        filled.push("attachments");
      }
    } catch (e) {
      logger.error("Attachment merge failed", e);
    }
  }

  // If this merge gave a flagged card a real name and core referral data, it
  // no longer needs human review — clear the flag automatically.
  if (ex.needsReview) {
    const merged = { ...ex, ...update } as Record<string, unknown>;
    const hasRealName =
      !isEmpty(merged.name) && !/needs review/i.test(String(merged.name));
    const hasCoreData = Boolean(
      merged.courtName ||
        merged.county ||
        (Array.isArray(merged.tickets) && merged.tickets.length > 0),
    );
    if (hasRealName && hasCoreData) {
      update.needsReview = false;
      filled.push("needsReview cleared");
    }
  }

  if (Object.keys(update).length) {
    update.updatedAt = Date.now();
    await existing.ref.update(update);
  }
  return filled;
}

// HTTP endpoint the intake@ Apps Script posts each new TVC email to.
export const ingestEmail = onRequest(
  { secrets: [INGEST_TOKEN, OPENAI_API_KEY_INGEST], cors: false },
  async (req, res) => {
    if (req.method !== "POST") {
      res.status(405).json({ ok: false, error: "POST only" });
      return;
    }
    const body = (req.body || {}) as IngestBody;
    if (!body.token || body.token !== INGEST_TOKEN.value()) {
      res.status(401).json({ ok: false, error: "bad token" });
      return;
    }

    const subject = body.subject || "";
    if (!isTvcReferral(subject, body.from || "")) {
      res.json({ ok: true, skipped: "not a TVC referral" });
      return;
    }

    const db = getFirestore();

    // Dedupe by Gmail message id up front (same message reposted) — this also
    // saves an LLM call and prevents duplicate review cards on reprocessing.
    // Exception: if the existing card is still flagged needs-review (e.g. its
    // PDF couldn't be read during an LLM outage), fall through so a reprocess
    // (Apps Script rescanRecent) can re-extract and heal it in place.
    let reprocessTarget: FirebaseFirestore.QueryDocumentSnapshot | null = null;
    if (body.messageId) {
      const dup = await db
        .collection("leads")
        .where("gmailMessageId", "==", body.messageId)
        .limit(1)
        .get();
      if (!dup.empty) {
        if (!dup.docs[0].data().needsReview) {
          res.json({ ok: true, skipped: "duplicate message", id: dup.docs[0].id });
          return;
        }
        reprocessTarget = dup.docs[0];
      }
    }

    const text =
      (body.plainBody && body.plainBody.trim()) ||
      (body.htmlBody ? htmlToText(body.htmlBody, { wordwrap: false }) : "");
    const pdfs = (body.attachments || []).filter(
      (a) => /pdf/i.test(a.contentType || "") || /\.pdf$/i.test(a.name),
    );
    // Nothing to read at all — no body and no PDF. A correct, permanent skip.
    if (!text && !pdfs.some((p) => p.dataB64)) {
      res.json({ ok: true, skipped: "empty body" });
      return;
    }

    // Prefer the multimodal LLM extractor on the body; fall back to regex.
    let fields: Record<string, unknown> = {};
    let llmError = false; // transient (e.g. OpenAI quota) — let the script retry
    if (text) {
      try {
        const r = await extractLead(
          { text },
          OPENAI_API_KEY_INGEST.value(),
          OPENAI_MODEL_INGEST.value() || "gpt-4o",
        );
        fields = r.fields;
      } catch (e) {
        llmError = true;
        logger.warn("LLM extraction failed; using regex fallback", e);
        fields = parseTvc(text).fields as Record<string, unknown>;
      }
    }

    // The body is often just the forwarder's signature; the real member/court
    // data is in the attached PDF. Read it when the core fields are missing —
    // this also covers PDF-only emails that have no usable body text. Some
    // emails bundle several PDFs (referral form + citation scans), so try each
    // one and keep the first non-empty value for every field.
    const hasCore = (f: Record<string, unknown>) =>
      Boolean(
        f.courtName ||
          f.county ||
          f.address ||
          (Array.isArray(f.tickets) && f.tickets.length > 0),
      );
    if (pdfs.length && !hasCore(fields)) {
      for (const p of pdfs) {
        if (!p.dataB64) continue;
        try {
          const r = await extractLeadFromPdf(
            p.dataB64,
            OPENAI_API_KEY_INGEST.value(),
            OPENAI_MODEL_INGEST.value() || "gpt-4o",
          );
          for (const [k, v] of Object.entries(r.fields || {})) {
            if (isEmpty(fields[k]) && !isEmpty(v)) fields[k] = v;
          }
        } catch (e) {
          llmError = true;
          logger.warn("PDF extraction failed", e);
        }
        // Stop once we have the two identifiers dedup relies on.
        if (!isEmpty(fields.name) && !isEmpty(fields.tvcCaseNumber)) break;
      }
    }

    // Backstop: if neither the body nor the PDF yielded a case number, try the
    // subject line. PDF-only re-sends often still carry "TVC #1234567" there,
    // and recovering it lets the case-number dedup below link the email to its
    // lead even when it's too thin to parse a name.
    if (isEmpty(fields.tvcCaseNumber)) {
      const fromSubject = caseNumberFromSubject(subject);
      if (fromSubject) fields.tvcCaseNumber = fromSubject;
    }

    // Name backstop from the subject — only when the subject also identified
    // the case, so this can't invent a name from a generic subject. Turns a
    // would-be "Needs Review" card into a real, callable lead. If the core
    // referral fields are still missing, keep the review flag so staff know to
    // open the attached PDF.
    let subjectNamed = false;
    if (isEmpty(fields.name) && !isEmpty(fields.tvcCaseNumber)) {
      const n = nameFromSubject(subject);
      if (n) {
        fields.name = n;
        subjectNamed = true;
      }
    }

    // Reprocessing a message whose card is still flagged: merge the fresh
    // extraction into that card (fills fields, attaches PDFs, clears the flag
    // once it has a real name + core data) and stop.
    if (reprocessTarget) {
      const filled = await mergeIntoExisting(reprocessTarget, fields, body);
      logger.info("Reprocessed needs-review card", { id: reprocessTarget.id, filled });
      res.json({ ok: true, merged: true, filled, id: reprocessTarget.id });
      return;
    }

    // Dedupe by TVC case number FIRST — before the name check — so a thin,
    // PDF-only re-send merges into the existing lead (contributing any new
    // attachments) instead of spawning a "Needs Review" card. Also rolls a
    // changed court date into history as a continuance.
    const caseNum = fields.tvcCaseNumber as string | undefined;
    if (caseNum) {
      const dupCase = await db
        .collection("leads")
        .where("tvcCaseNumber", "==", caseNum)
        .limit(1)
        .get();
      if (!dupCase.empty) {
        const existing = dupCase.docs[0];
        const ex = existing.data();
        // Fill any fields the existing card lacks and attach new PDFs.
        const filled = await mergeIntoExisting(existing, fields, body, { bump: true });
        const newDate = fields.nextCourtDate as string | undefined;
        if (newDate && newDate !== ex.nextCourtDate) {
          const history = Array.isArray(ex.courtDateHistory) ? [...ex.courtDateHistory] : [];
          if (ex.nextCourtDate) {
            history.push({
              date: ex.nextCourtDate,
              time: ex.nextCourtTime ?? null,
              type: ex.nextCourtType ?? null,
            });
          }
          await existing.ref.update({
            nextCourtDate: newDate,
            nextCourtTime: (fields.nextCourtTime as string) ?? ex.nextCourtTime ?? null,
            nextCourtType: (fields.nextCourtType as string) ?? ex.nextCourtType ?? null,
            courtDateHistory: history,
            caseDismissed: false,
            updatedAt: Date.now(),
          });
          logger.info("Updated court date on existing case", { id: existing.id, newDate });
          res.json({ ok: true, updated: "court date", filled, id: existing.id });
          return;
        }
        logger.info("Merged duplicate case into existing lead", { id: existing.id, filled });
        res.json({ ok: true, merged: true, filled, id: existing.id });
        return;
      }
    }

    // A usable name is required. Reject the regex fallback's "Unknown"
    // placeholder so junk never looks like a real client.
    const rawName = String((fields.name as string) ?? "").trim();
    const hasName = rawName.length > 0 && !/^unknown$/i.test(rawName);

    if (!hasName) {
      // Transient extractor failure → ask the script to retry (don't label).
      if (llmError) {
        res.status(503).json({ ok: false, retry: true, error: "extractor unavailable" });
        return;
      }
      // Matched the TVC filter but we couldn't parse a name — and it has no case
      // number linking it to an existing lead. Flag it for manual review with
      // the raw email + attachments so it isn't lost.
      const id = await createLeadDoc(db, fields, body, text, {
        name: "\u26A0 Needs Review",
        needsReview: true,
      });
      logger.warn("Lead needs manual review (no name parsed)", { id });
      res.json({ ok: true, needsReview: true, id });
      return;
    }

    // Fallback identity dedup — for named referrals that arrived without a case
    // number. Match an existing card by phone/email/name+county and merge.
    const match = await findIdentityMatch(db, fields);
    if (match) {
      const filled = await mergeIntoExisting(match, fields, body, { bump: true });
      logger.info("Merged duplicate into existing lead", { id: match.id, filled });
      res.json({ ok: true, merged: true, filled, id: match.id });
      return;
    }

    // A subject-derived name with no core referral data means the PDF wasn't
    // readable (e.g. LLM outage): keep the review flag so staff open the PDF.
    const thinSubjectCard = subjectNamed && !hasCore(fields);
    const id = await createLeadDoc(db, fields, body, text, {
      name: rawName,
      needsReview: thinSubjectCard,
    });
    logger.info("Lead created from email", { id, thinSubjectCard });
    res.json({ ok: true, id });
  },
);
