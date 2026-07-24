// TVC-thread rules (pure logic, no Firebase imports — testable).
//
// The firm's dispositions and negotiations happen in EMAIL THREADS WITH TVC
// (prodriver.com), not with the client — so the app was blind to them until
// the July 2026 audit found 8+ misfiled leads (retained clients chased,
// declined leads sitting live, a covered-case fee negotiation invisible).
// This module holds every decision the TVC-thread sync (tvcthreads.ts) makes
// about an office reply: case-number extraction, quoted-history stripping,
// phrase-anchored classification, and the per-lead write plan.
//
// CLASSIFICATION IS PHRASE-ANCHORED, NOT FUZZY. The audit measured these
// anchors at 100% precision across 733 real office replies — anything that
// only smells like a disposition goes to a human post-it, never to an
// automatic action. Corrections/retractions ALWAYS go to a human (a real
// retraction once arrived inside a DIFFERENT client's thread), and so does
// any reply that names another lead.

import { AUTO_ROUTE_FROM } from "./noSaleRouting.js";

const lc = (s: unknown): string => String(s ?? "").toLowerCase().trim();

// Lowercase, punctuation stripped, whitespace collapsed — the shape reply
// text and lead names are reduced to before name matching (mirrors
// normalizeText in squaresync.ts).
export const normalizeText = (s: unknown): string =>
  lc(s).replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();

// --- TVC case-number extraction --------------------------------------------
// Case numbers are 7 digits (~1.4–1.6M; the range guard rejects the 7-digit
// TVC MEMBER ids like "(9032788)" that ride next to case numbers in some
// subjects). Known real formats:
//   "Case:1564563"          "TVC 25% Case 1559857"   "Case# 1444463"
//   "CASE - 1554711 -"      "Case ID 1559178"        "TVC Legal Case: 1526639"
//   ...plus bare 7-digit numbers near the word Case.
// A manual audit's first regex MISSED the dashed format and silently dropped
// a decline — so the rule is deliberately loose: ANY 7-digit run (not part of
// a longer number) with "case" or "TVC" within 40 characters on either side.
// The proximity anchor is what keeps dollar figures and phone fragments out.
const CASE_RANGE = (n: string): boolean => n >= "1000000" && n < "2000000";

export function extractCaseNumbers(text: unknown): string[] {
  const src = String(text ?? "");
  const out = new Set<string>();
  const re = /(?<!\d)\d{7}(?!\d)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    if (!CASE_RANGE(m[0])) continue;
    const before = src.slice(Math.max(0, m.index - 40), m.index);
    const after = src.slice(m.index + 7, m.index + 47);
    if (/case|tvc/i.test(before) || /case|tvc/i.test(after)) out.add(m[0]);
  }
  return [...out];
}

// Bare in-range 7-digit runs with NO keyword requirement. Some real subjects
// carry only "Alberta King - 1525899" — no "case", no "TVC". The caller may
// use these ONLY as candidates against the app's known tvcCaseNumber index
// (an exact hit on a known case number is its own anchor).
export function extractBareCaseNumbers(text: unknown): string[] {
  const src = String(text ?? "");
  const out = new Set<string>();
  const re = /(?<!\d)\d{7}(?!\d)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    if (CASE_RANGE(m[0])) out.add(m[0]);
  }
  return [...out];
}

// --- Fresh-reply extraction --------------------------------------------------
// Classification runs on the part the office WROTE, never on the quoted
// history below it (which carries TVC's own words and other threads' text).
const QUOTE_MARKERS: RegExp[] = [
  /\n\s*On [\s\S]{0,300}?wrote:/, // "On Jul 17, 2026, at 9:01 AM, X wrote:"
  /\n\s*>/, // ">"-quoted lines
  /-{3,}\s*Original Message\s*-{3,}/i, // Outlook
  /\n\s*From:\s/, // forwarded/top-posted header block
  /\n_{6,}\n/, // Outlook divider
];

export function stripQuotedHistory(text: unknown): string {
  const src = String(text ?? "").replace(/\r\n/g, "\n");
  let cut = src.length;
  for (const re of QUOTE_MARKERS) {
    const m = re.exec(src);
    if (m && m.index < cut) cut = m.index;
  }
  let body = src.slice(0, cut);
  // Standard signature delimiter ("-- \n") — drop everything under it.
  const sig = /\n-- ?\n/.exec(body);
  if (sig) body = body.slice(0, sig.index);
  return body.trim();
}

// A reply that is nothing but a pleasantry ("Okay, thank you so much!") adds
// noise, not ground truth — no timeline entry for those.
export const isPleasantry = (replyText: unknown): boolean =>
  String(replyText ?? "").replace(/\s+/g, " ").trim().length < 60;

// Short quote of the reply for notes/post-its (1–2 lines).
export function excerptOf(replyText: unknown, max = 220): string {
  const t = String(replyText ?? "").replace(/\s+/g, " ").trim();
  return t.length <= max ? t : `${t.slice(0, max - 1).trimEnd()}…`;
}

// --- Phrase-anchored classification -----------------------------------------
export type TvcKind =
  | "declined" // the firm told TVC the member declined our services
  | "retained" // the firm told TVC the member retained our services
  | "correction" // mix-up / correction / apology — ALWAYS a human post-it
  | "not_viable" // case can't proceed (dismissed/paid/plea/nothing pending)
  | "review" // disposition-ish words but no anchor — human post-it
  | "none"; // ordinary negotiation traffic (fee quotes etc.)

export interface TvcClassification {
  kind: TvcKind;
  anchor: string | null; // the matched phrase, for the audit trail
}

const RE_DECLINED = /declined our services/i;
// The corpus phrases retention two ways — "has retained our services" and
// "has decided to retain our services" (sometimes singular "service"). The
// conditional fee-quote phrasing "$1,125 to retain our services" deliberately
// does NOT match: it needs the past tense or an explicit "decided to".
const RE_RETAINED = /(retained|decided to retain) our services?\b/i;
// Retractions arrive as "mixed him up with", "correction", "apologies" — and
// at least one real one arrived inside a DIFFERENT client's thread, so these
// NEVER act automatically.
const RE_CORRECTION = /mix(ed)? .{0,20}up|correction|apolog/i;
// The category that varies the most — flag only, never auto-close.
const RE_NOT_VIABLE =
  /cannot assist|charges? (were|was|already) dismissed|already (entered a guilty plea|paid the (fine|citation|ticket))|reached a plea deal|nothing .{0,30}pending/i;
// Disposition-ish keywords with no anchor → human review, no auto-action.
const RE_DISPOSITIONISH = /declin|retain|dismiss|cannot|hired/i;
// Plain fee quotes ("the retainer fee is $1,125… a $750 trial fee") are
// negotiation traffic, not dispositions — they'd otherwise trip the
// "retain" keyword and flood the desk with review post-its.
const RE_FEE_QUOTE = /(retainer|trial) fee/i;
const RE_DOLLARS = /\$\s?[\d,]+/;

// A negated anchor ("has NOT retained our services") is precisely the read a
// human must make — never auto-act on it.
const negated = (t: string, index: number): boolean =>
  /\b(?:not|never|no longer|hasn'?t|has not)\s*(?:yet\s+)?$/i.test(
    t.slice(Math.max(0, index - 24), index),
  );

export function classifyReply(replyText: unknown): TvcClassification {
  const t = String(replyText ?? "");
  const correction = RE_CORRECTION.exec(t);
  if (correction) return { kind: "correction", anchor: correction[0] };
  const declined = RE_DECLINED.exec(t);
  const retained = RE_RETAINED.exec(t);
  const notViable = RE_NOT_VIABLE.exec(t);
  const hits = [declined, retained, notViable].filter(Boolean);
  if (hits.length > 1) {
    // Two anchors in one reply is exactly the ambiguity a human must read.
    return { kind: "review", anchor: hits.map((h) => h![0]).join(" + ") };
  }
  if (declined && negated(t, declined.index)) return { kind: "review", anchor: declined[0] };
  if (retained && negated(t, retained.index)) return { kind: "review", anchor: retained[0] };
  if (declined) return { kind: "declined", anchor: declined[0] };
  if (retained) return { kind: "retained", anchor: retained[0] };
  if (notViable) return { kind: "not_viable", anchor: notViable[0] };
  if (RE_FEE_QUOTE.test(t) && RE_DOLLARS.test(t)) return { kind: "none", anchor: null };
  if (RE_DISPOSITIONISH.test(t)) return { kind: "review", anchor: null };
  return { kind: "none", anchor: null };
}

// --- Other-lead name detection ----------------------------------------------
// A disposition reply that NAMES A DIFFERENT LEAD (by case number or name)
// may be about that other lead, not the thread's — the retraction that
// arrived inside another client's thread proved it. Name needles mirror the
// payment-note matcher in squaresync.ts: "first last", "last first", and
// first+last skipping middle names, all normalized, length-floored at 6.
export interface NameIndexEntry {
  needles: string[];
  lead: { id: string; name: string };
}

export function buildNameIndex(leads: { id: string; name: string }[]): NameIndexEntry[] {
  const index: NameIndexEntry[] = [];
  for (const lead of leads) {
    const normName = normalizeText(lead.name);
    if (normName.length < 6) continue;
    const parts = normName.split(" ");
    const needles = new Set<string>([parts.join(" ")]);
    if (parts.length >= 2) {
      needles.add([...parts].reverse().join(" "));
      needles.add(`${parts[0]} ${parts[parts.length - 1]}`);
      needles.add(`${parts[parts.length - 1]} ${parts[0]}`);
    }
    const usable = [...needles].filter((n) => n.length >= 6);
    if (usable.length) index.push({ needles: usable, lead });
  }
  return index;
}

export function findNamedLeads(
  text: unknown,
  index: NameIndexEntry[],
): Map<string, { id: string; name: string }> {
  const hits = new Map<string, { id: string; name: string }>();
  const hay = ` ${normalizeText(text)} `;
  for (const entry of index) {
    if (entry.needles.some((n) => hay.includes(` ${n} `))) {
      hits.set(entry.lead.id, entry.lead);
    }
  }
  return hits;
}

// --- Gmail payload → plain text ----------------------------------------------
// Prefer the text/plain part; fall back to a crude tag-strip of text/html.
// Kept dependency-free so the backfill script can import this module as-is.
export interface GmailPayloadPart {
  mimeType?: string;
  body?: { data?: string };
  parts?: GmailPayloadPart[];
}

function collectParts(p: GmailPayloadPart | undefined, mime: string, out: string[]): void {
  if (!p) return;
  if (p.mimeType === mime && p.body?.data) {
    out.push(Buffer.from(p.body.data, "base64url").toString("utf8"));
  }
  for (const child of p.parts ?? []) collectParts(child, mime, out);
}

function htmlToPlain(html: string): string {
  return html
    .replace(/<(style|script)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|tr|li|h[1-6]|blockquote)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/[ \t]+/g, " ");
}

export function payloadText(payload: GmailPayloadPart | undefined): string {
  const plain: string[] = [];
  collectParts(payload, "text/plain", plain);
  if (plain.length) return plain.join("\n");
  const html: string[] = [];
  collectParts(payload, "text/html", html);
  if (html.length) return htmlToPlain(html.join("\n"));
  return "";
}

// --- Per-lead write plan ------------------------------------------------------
// Given the matched lead's CURRENT doc data (read inside the caller's
// transaction) and the classified message, decide every write: the lead
// patch, the timeline attempt, and the post-it. Idempotent by design — a
// lead whose state already reflects the disposition gets only the (missing)
// timeline entry, and an attempt carrying this gmailMessageId (or a
// reconstructed email attempt at the same timestamp) is never duplicated.

export interface TvcMessageFacts {
  gmailMessageId: string;
  ts: number; // Gmail internalDate — the business date for everything
  subject: string;
  replyText: string; // fresh reply only, quoted history stripped
  caseNumber: string; // the case number that matched this lead
  classification: TvcClassification;
  otherLeadNames: string[]; // OTHER leads named in the reply (case# or name)
}

export interface TvcLeadPlan {
  action: string; // marker label — the audit trail
  patch: Record<string, unknown> | null; // lead fields (contactAttempts excluded)
  attempt: Record<string, unknown> | null; // timeline entry to append, if any
  postIt: { subject: string; message: string } | null;
}

const BY = "TVC thread sync";
// Mirrors noSaleRouting.ts: court reminders are the No Sale resurrection
// path and survive the move to lost.
const SURVIVES_LOST = ["week_before", "day_before"];

const chicagoDay = (ts: number): string =>
  new Date(ts).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "America/Chicago",
  });

export function planLeadWrites(
  d: Record<string, unknown>,
  msg: TvcMessageFacts,
): TvcLeadPlan {
  const cls = msg.classification;
  const name = String(d.name ?? "this lead");
  const quote = excerptOf(msg.replyText);
  const attempts = Array.isArray(d.contactAttempts)
    ? (d.contactAttempts as Record<string, unknown>[])
    : [];
  // Dedupe: the gmailMessageId stored on the attempt, or a manually
  // reconstructed email entry stamped at (nearly) the same message time.
  const alreadyLogged = attempts.some(
    (a) =>
      a?.gmailMessageId === msg.gmailMessageId ||
      (a?.via === "email" &&
        typeof a.ts === "number" &&
        Math.abs((a.ts as number) - msg.ts) < 2 * 60_000),
  );
  const pleasantry = isPleasantry(msg.replyText);

  // Timeline visibility for ALL matched office replies — including plain
  // negotiation traffic (fee quotes to TVC). This is what makes cards
  // reflect ground truth ("ton of emails about him" now visible). The
  // outcome is 'no_answer' on purpose: a thread with TVC is NOT member
  // contact and must never read as a connection. The pleasantry skip only
  // applies to non-disposition replies — "Client retained our services" is
  // short but is exactly the ground truth the timeline exists for.
  const genericAttempt =
    alreadyLogged || (pleasantry && cls.kind === "none")
      ? null
      : {
          ts: msg.ts,
          outcome: "no_answer",
          via: "email",
          by: BY,
          gmailMessageId: msg.gmailMessageId,
          notes: `TVC thread (not member contact): "${msg.subject}" — ${quote}`,
        };

  const stage = String(d.stage ?? "");
  const sold = typeof d.saleStatus === "string" && (d.saleStatus as string).startsWith("paid");
  const onBoard = AUTO_ROUTE_FROM.includes(stage);

  // A disposition reply that names ANOTHER lead may be about that other
  // lead — the retraction-in-the-wrong-thread failure. Human decides.
  if (msg.otherLeadNames.length && cls.kind !== "none") {
    return {
      action: `${cls.kind}_names_other_lead`,
      patch: null,
      attempt: genericAttempt,
      postIt: {
        subject: `TVC thread names another lead — ${name}`,
        message:
          `A firm reply in ${name}'s TVC thread (case ${msg.caseNumber}) also names ` +
          `${msg.otherLeadNames.join(", ")} — the disposition may belong to the other ` +
          `thread (a real retraction once arrived inside a different client's thread).\n` +
          `Classifier read: ${cls.kind}${cls.anchor ? ` ("${cls.anchor}")` : ""}. ` +
          `No automatic action was taken on anyone.\n` +
          `The reply: "${quote}"\n` +
          `Verify which member this is really about and fix the affected card(s).`,
      },
    };
  }

  switch (cls.kind) {
    case "declined": {
      const declineAttempt = alreadyLogged
        ? null
        : {
            ts: msg.ts,
            outcome: "declined",
            via: "email",
            by: BY,
            gmailMessageId: msg.gmailMessageId,
            notes:
              `Member declined — "${quote}" ` +
              `(case ${msg.caseNumber}, from the firm's reply to TVC).`,
          };
      if (stage === "lost") {
        // Already routed (by hand, by the manual audit, or a prior run) —
        // the state matches the disposition; only the timeline entry lands.
        return {
          action: "declined_already_lost",
          patch: null,
          attempt: declineAttempt,
          postIt: null,
        };
      }
      // Mirrors noSaleRouting.ts's safety valves. Any block on a decline is
      // a CONTRADICTION (firm says declined, app says otherwise) — post-it.
      const blocked = sold
        ? `the lead is marked ${d.saleStatus}`
        : !onBoard
          ? `the lead sits in ${stage}`
          : d.lostRevivedAt
            ? "a human revived this lead out of No Sale"
            : d.possibleExistingClientAt
              ? "the possible-existing-client flag is set (identity unresolved)"
              : msg.ts <= ((d.lostAt as number) ?? 0)
                ? "the reply predates the current lost stamp"
                : null;
      if (blocked) {
        return {
          action: "declined_needs_review",
          patch: null,
          attempt: genericAttempt,
          postIt: {
            subject: `TVC thread needs review — ${name}`,
            message:
              `The firm's reply to TVC says ${name} DECLINED our services ` +
              `(case ${msg.caseNumber}): "${quote}"\n` +
              `But ${blocked} — refusing to auto-route. Reconcile the card by hand.`,
          },
        };
      }
      const now = Date.now();
      const followUps = Array.isArray(d.followUps)
        ? (d.followUps as Record<string, unknown>[])
        : [];
      const note =
        `Stage moved to No Sale by TVC thread sync — the firm's ` +
        `${chicagoDay(msg.ts)} reply to TVC says the member declined our services`;
      return {
        action: "declined_routed_lost",
        patch: {
          stage: "lost",
          lostAt: msg.ts, // business date = the reply, not the sync run
          lostReason: `Declined our services per the firm's reply to TVC (case ${msg.caseNumber}): "${quote}"`,
          autoStageNote: note,
          autoStageAt: now,
          // Dead prospect — close pending SALES follow-ups, but SPARE the
          // week_before/day_before court reminders (the resurrection path;
          // see noSaleRouting.ts for why closing them would arm the
          // cadence's proximity dedupe against re-adds).
          followUps: followUps.map((f) =>
            f.done || SURVIVES_LOST.includes((f.type as string) ?? "")
              ? f
              : { ...f, done: true, doneAt: now },
          ),
        },
        attempt: declineAttempt,
        postIt: null,
      };
    }

    case "retained": {
      if (sold || stage === "financed" || stage === "intake_complete") {
        // The app already shows the sale — nothing to reconcile.
        return {
          action: "retained_already_sold",
          patch: null,
          attempt: genericAttempt,
          postIt: null,
        };
      }
      if (stage === "lost") {
        return {
          action: "retained_but_lost_needs_review",
          patch: null,
          attempt: genericAttempt,
          postIt: {
            subject: `TVC thread needs review — ${name}`,
            message:
              `The firm's reply to TVC says ${name} RETAINED our services ` +
              `(case ${msg.caseNumber}): "${quote}"\n` +
              `But the app has them in No Sale — reconcile the card by hand.`,
          },
        };
      }
      if (d.possibleExistingClientAt) {
        // Already paused pending human verification — don't re-stamp or
        // stack another post-it.
        return {
          action: "retained_already_flagged",
          patch: null,
          attempt: genericAttempt,
          postIt: null,
        };
      }
      // NEVER guess money: pause the chase (possibleExistingClientAt, the
      // same flag the CallRail existing-client detector uses) and put the
      // ask on the desk — the Square matcher or a human settles the sale.
      return {
        action: "retained_flagged",
        patch: { possibleExistingClientAt: msg.ts },
        attempt: genericAttempt,
        postIt: {
          subject: `Retained per TVC thread but unsold in app — ${name}`,
          message:
            `The firm told TVC it retained ${name} (case ${msg.caseNumber}): "${quote}"\n` +
            `The app still shows them unsold, so the retention happened outside the ` +
            `app's view. Sales chasing is PAUSED (possible-existing-client flag). ` +
            `Money is never guessed from a thread — the Square matcher or a human ` +
            `settles it: mark the sale (or clear the flag) to resume.`,
        },
      };
    }

    case "not_viable": {
      if (stage === "lost") {
        // Already closed — the not-viable read changes nothing.
        return {
          action: "not_viable_already_lost",
          patch: null,
          attempt: genericAttempt,
          postIt: null,
        };
      }
      if (d.needsReview) {
        // Already flagged (the manual audit's state) — don't re-flag.
        return {
          action: "not_viable_already_flagged",
          patch: null,
          attempt: genericAttempt,
          postIt: null,
        };
      }
      if (sold || !onBoard) {
        return {
          action: "not_viable_needs_review",
          patch: null,
          attempt: genericAttempt,
          postIt: {
            subject: `TVC thread needs review — ${name}`,
            message:
              `The firm's reply to TVC reads as CAN'T PROCEED on ${name}'s case ` +
              `(case ${msg.caseNumber}, anchor "${cls.anchor}"): "${quote}"\n` +
              `But the lead is ${sold ? `marked ${d.saleStatus}` : `in ${stage}`} — ` +
              `reconcile the card by hand.`,
          },
        };
      }
      // Flag only, NEVER auto-close — this category varies the most.
      return {
        action: "not_viable_flagged",
        patch: { needsReview: true },
        attempt: genericAttempt,
        postIt: {
          subject: `Not viable per TVC thread — ${name}`,
          message:
            `The firm's reply to TVC reads as CAN'T PROCEED on ${name}'s case ` +
            `(case ${msg.caseNumber}, anchor "${cls.anchor}"): "${quote}"\n` +
            `Flagged for review only — never auto-closed (this category varies the ` +
            `most). Decide: close it out or correct the read.`,
        },
      };
    }

    case "correction":
      // ALWAYS a human — a real retraction arrived inside a DIFFERENT
      // client's thread once; auto-routing a correction is how a retained
      // client gets lost (or a declined one revived) on the wrong card.
      return {
        action: "correction_needs_review",
        patch: null,
        attempt: genericAttempt,
        postIt: {
          subject: `Correction/retraction in TVC thread — ${name}`,
          message:
            `A firm reply in ${name}'s TVC thread (case ${msg.caseNumber}) reads as ` +
            `a correction/retraction (anchor "${cls.anchor}"): "${quote}"\n` +
            `Corrections never act automatically — verify which member and which ` +
            `disposition this is really about and fix the card by hand.`,
        },
      };

    case "review":
      if (d.needsReview) {
        // The card is already sitting in Needs Review — a second "read this
        // thread" note on the same lead is noise, not signal.
        return {
          action: "review_already_flagged",
          patch: null,
          attempt: genericAttempt,
          postIt: null,
        };
      }
      return {
        action: "needs_review",
        patch: null,
        attempt: genericAttempt,
        postIt: {
          subject: `TVC thread needs review — ${name}`,
          message:
            `A firm reply in ${name}'s TVC thread (case ${msg.caseNumber}) uses ` +
            `disposition language but matches no known phrasing` +
            `${cls.anchor ? ` (saw: "${cls.anchor}")` : ""} — no automatic action taken.\n` +
            `The reply: "${quote}"\n` +
            `Read it and settle the card by hand.`,
        },
      };

    default:
      // Ordinary negotiation traffic — timeline visibility only.
      return {
        action: pleasantry ? "pleasantry_skipped" : genericAttempt ? "logged" : "already_logged",
        patch: null,
        attempt: genericAttempt,
        postIt: null,
      };
  }
}
