// The mail program's brain — pure functions only (unit tested, no I/O).
//
// TVCHub's letter program works the half of the funnel the phone can't reach:
// the never-answered, the full-voicemail-box, the "thinking about it", and
// the politely-declined-but-still-exposed. Every letter exists to make the
// phone ring, and every letter is keyed to a state the system already tracks.
//
// Two hard laws, enforced here:
//   1. ELIGIBILITY IS COMPUTED FROM LIVE STATE. The daily sweep proposes
//      letters and the send path re-checks this same function at approval
//      time — a lead who retained an hour ago can never be mailed a pitch.
//   2. MAIL PHYSICS. PostGrid printing + first-class delivery ≈ 10 calendar
//      days door to door. A milestone letter is only proposed while it can
//      still arrive in time to matter; when it can't, the letter dies (its
//      moment has passed) and the phone cadence is the only channel left.

export type LetterType =
  | "intro" // "we tried to reach you" — first-contact letter
  | "second_chase" // still no conversation ~2 weeks later
  | "thinking" // recap letter after a pitch ended in "thinking"
  | "motions" // motions-deadline pressure letter (the workhorse)
  | "motions_late" // deadline just passed — "call immediately, we can still try"
  | "court_week" // free court reminder, arrives ~1 week out (incl. lost leads)
  | "court_passed"; // court came and went — "a warrant may have issued"

export const LETTER_LABEL: Record<LetterType, string> = {
  intro: "We tried to reach you",
  second_chase: "Second attempt — court is getting closer",
  thinking: "While you're thinking it over",
  motions: "Motions deadline — hire us and skip the trip",
  motions_late: "Deadline passed — call immediately",
  court_week: "Free court reminder — one week out",
  court_passed: "Your court date has passed",
};

// Door-to-door letter latency (PostGrid processing + USPS first class).
export const MAIL_LEAD_DAYS = 10;
// No lead ever receives more than this many letters, lifetime.
export const MAX_LETTERS_PER_LEAD = 6;
// And never two letters inside the same week.
export const MIN_DAYS_BETWEEN_LETTERS = 7;

const DAY = 86400_000;

type Dict = Record<string, unknown>;
const str = (v: unknown): string => (v == null ? "" : String(v));
const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

// Real two-way conversation outcomes — mirrors cadence.ts / leadFlow.ts.
const CONVERSATION_OUTCOMES = [
  "spoke",
  "thinking",
  "declined",
  "verbal_yes",
  "wants_attorney",
  "retained",
  "lost",
];

// ---------- Address parsing ----------

export interface MailAddress {
  line1: string;
  city: string;
  provinceOrState: string;
  postalOrZip: string;
}

// TVC referral sheets carry one-line addresses like
// "400 W. Gettysburg Ave Apt 223A, Clovis, CA 93612". Parse the tail
// (city, ST zip) and keep everything before it as line1. Anything that
// doesn't fit the shape is rejected — a letter to a half-address is a
// dollar mailed to nowhere.
export function parseMailAddress(raw: unknown): MailAddress | null {
  const s = str(raw).replace(/\s+/g, " ").trim();
  if (!s) return null;
  const m = /^(.*?),?\s*([A-Za-z .'-]+?),?\s+([A-Z]{2})\s+(\d{5}(?:-\d{4})?)$/.exec(s);
  if (!m) return null;
  const line1 = m[1].replace(/,\s*$/, "").trim();
  const city = m[2].trim();
  if (!line1 || !city) return null;
  return { line1, city, provinceOrState: m[3], postalOrZip: m[4] };
}

// ---------- Lost-reason triage ----------

// "No Sale" splits on one question: does this person still have unresolved
// legal exposure? Hired counsel / paid the ticket / handled it → silent
// forever (mailing them is an ethics problem, not a sales miss). A plain
// "not interested" keeps the free court reminders — that door stays open.
export function lostReasonIsResolved(reason: unknown): boolean {
  const r = str(reason).toLowerCase();
  if (!r) return false;
  return (
    /hired|other attorney|another attorney|other counsel|own lawyer|represented/.test(r) ||
    /paid (the |their |it|citation|ticket|fine)|already paid|took care of|handled (it|themselves|myself)/.test(r) ||
    /dismissed|resolved|no longer needs|case (was )?closed/.test(r) ||
    /warrant declined|do not contact|stop contact|remove/.test(r)
  );
}

// ---------- Core lead facts (derived once, used by eligibility + triggers) ----------

export interface LeadMailFacts {
  hadConversation: boolean;
  lastConversationTs: number; // 0 when none
  lastConversationWasThinking: boolean;
  attemptCount: number;
  courtDate: string | null; // yyyy-mm-dd
  daysToCourtFrom(todayISO: string): number | null; // negative = passed
}

export function leadMailFacts(d: Dict): LeadMailFacts {
  const attempts = (Array.isArray(d.contactAttempts) ? d.contactAttempts : []) as Dict[];
  const conversations = attempts.filter((a) =>
    CONVERSATION_OUTCOMES.includes(str(a.outcome)),
  );
  const last = conversations.reduce<Dict | null>(
    (m, a) => (num(a.ts) >= num(m?.ts) ? a : m),
    null,
  );
  const lastAi = last?.ai as Dict | undefined;
  const courtDate =
    typeof d.nextCourtDate === "string" && /^\d{4}-\d{2}-\d{2}$/.test(d.nextCourtDate)
      ? (d.nextCourtDate as string)
      : null;
  return {
    hadConversation: conversations.length > 0 || Boolean(d.lastConnectedAt),
    lastConversationTs: num(last?.ts),
    lastConversationWasThinking:
      !!last && (str(last.outcome) === "thinking" || str(lastAi?.pitchResult) === "thinking"),
    attemptCount: attempts.length,
    courtDate,
    daysToCourtFrom(todayISO: string): number | null {
      if (!courtDate) return null;
      const c = new Date(`${courtDate}T00:00:00Z`).getTime();
      const t = new Date(`${todayISO}T00:00:00Z`).getTime();
      return Math.round((c - t) / DAY);
    },
  };
}

// ---------- Eligibility (the suppression engine) ----------

// Non-null = the letter is forbidden, with the human-readable reason that
// lands on the letter doc. Checked when a letter is PROPOSED and re-checked
// when it is APPROVED — live state wins, always.
export function letterBlockReason(d: Dict, type: LetterType, todayISO: string): string | null {
  if (d.deletedAt) return "lead deleted";
  if (d.needsReview) return "identity unverified (needs review)";
  if (d.mailOptOut) return "do-not-mail flag on the lead";
  if (d.mailReturnedAt) return "previous letter returned — bad address";
  if (d.possibleExistingClientAt) return "possible existing client — sales paused";
  if (d.caseDismissed) return "case dismissed";

  const saleStatus = str(d.saleStatus);
  const stage = str(d.stage);
  if (
    saleStatus === "paid_full" ||
    saleStatus === "paid_partial" ||
    stage === "financed" ||
    stage === "intake_complete" ||
    d.retainedAt
  ) {
    return "retained — client, not a prospect";
  }
  if (saleStatus === "promised_unpaid") {
    return "promised payment — collections is a phone job, not a letter";
  }
  if (stage === "attorney_call") return "attorney call pending — we owe THEM the next touch";

  if (stage === "lost") {
    if (lostReasonIsResolved(d.lostReason)) {
      return "case resolved or represented — permanent mail stop";
    }
    if (type !== "court_week" && type !== "court_passed") {
      return "declined — free court reminders only";
    }
  }

  if (!parseMailAddress(d.address)) return "no mailable address on file";

  // Mail physics: a letter that cannot arrive before its moment is wasted.
  const facts = leadMailFacts(d);
  const days = facts.daysToCourtFrom(todayISO);
  if (
    days !== null &&
    days >= 0 &&
    days < MAIL_LEAD_DAYS &&
    (type === "intro" || type === "second_chase" || type === "thinking" || type === "court_week")
  ) {
    return `court in ${days} day(s) — too close for mail, phone only`;
  }

  return null;
}

// ---------- Trigger logic (which letter does this lead need today?) ----------

export interface LetterProposal {
  type: LetterType;
  // Semantic idempotency key — one letter per (lead, meaning). A continuance
  // moves the court date, which changes the key, which re-arms the milestone
  // letters for the new date. That's by design.
  dedupeKey: string;
  // Why the sweep proposed it — shown in the Mail Room so approval is a
  // judgment, not a mystery.
  reason: string;
}

export interface LetterHistoryFacts {
  introSentAt: number | null; // when the intro letter was mailed, if ever
  sentCount: number; // letters ever mailed to this lead
  lastSentAt: number | null; // newest mailed letter
  sentKeys: Set<string>; // dedupeKeys already proposed/sent/skipped (never re-raise)
}

// Evaluate every trigger for one lead. Returns at most ONE proposal — the
// most urgent letter wins, and the weekly frequency cap does the rest.
// `ddl` is the state-aware motions deadline from motionsDeadline.ts (null
// when there's no court date or it can't be computed).
export function proposeLetter(
  d: Dict,
  ddl: { date: string; passed: boolean } | null,
  history: LetterHistoryFacts,
  todayISO: string,
  nowMs: number,
): LetterProposal | null {
  const facts = leadMailFacts(d);
  const days = facts.daysToCourtFrom(todayISO);
  const stage = str(d.stage);
  const active = ["new", "callback", "pitched", "nurture"].includes(stage);
  const lostButExposed = stage === "lost" && !lostReasonIsResolved(d.lostReason);

  // Frequency guards (lifetime cap + one letter a week).
  if (history.sentCount >= MAX_LETTERS_PER_LEAD) return null;
  if (history.lastSentAt && nowMs - history.lastSentAt < MIN_DAYS_BETWEEN_LETTERS * DAY) {
    return null;
  }

  const candidates: LetterProposal[] = [];
  const push = (type: LetterType, keySuffix: string, reason: string) => {
    const dedupeKey = `${type}:${keySuffix}`;
    if (history.sentKeys.has(dedupeKey)) return;
    candidates.push({ type, dedupeKey, reason });
  };

  // court_passed — the hammer, and the honest last door back in. Active
  // undecided leads AND lost-but-exposed declines. 2-day grace (they may
  // have appeared), stale cutoff at 14 (older = historical backlog).
  if ((active || lostButExposed) && days !== null && days <= -2 && days >= -14) {
    push(
      "court_passed",
      facts.courtDate!,
      `Court date ${facts.courtDate} passed ${-days} days ago with no retention and no known resolution.`,
    );
  }

  // motions / motions_late — the pressure point. Sales letters: active only.
  if (active && facts.courtDate) {
    if (ddl && !ddl.passed) {
      const ddlDays = Math.round(
        (new Date(`${ddl.date}T00:00:00Z`).getTime() - new Date(`${todayISO}T00:00:00Z`).getTime()) /
          DAY,
      );
      // Send while the letter still lands ~4-6 days before the deadline.
      if (ddlDays >= MAIL_LEAD_DAYS && ddlDays <= MAIL_LEAD_DAYS + 6) {
        push(
          "motions",
          facts.courtDate,
          `Motions-filing deadline is ${ddl.date} (${ddlDays} days out) — letter arrives ~${ddlDays - MAIL_LEAD_DAYS + 4} days before it.`,
        );
      }
    } else if (ddl && ddl.passed && days !== null && days >= MAIL_LEAD_DAYS + 2) {
      // Deadline behind us, court still far enough ahead for mail to matter:
      // the "call immediately — courts sometimes grant late continuances"
      // variant. Shares the motions key family: one motions letter per
      // court date, whichever variant fires first.
      push(
        "motions_late",
        facts.courtDate,
        `Motions deadline has passed but court (${facts.courtDate}) is still ${days} days out — late-continuance angle.`,
      );
    }
  }

  // court_week — free reminder, arrives ~7 days out. Active AND lost-but-exposed.
  if ((active || lostButExposed) && days !== null && days >= 12 && days <= 16) {
    push(
      "court_week",
      facts.courtDate!,
      `Court is ${facts.courtDate} (${days} days out) — reminder letter arrives about a week before.`,
    );
  }

  // thinking — they heard the pitch and stalled. 2+ days of silence after
  // that conversation, keyed to the conversation so a NEW "thinking" call
  // re-arms a new letter.
  if (
    active &&
    facts.lastConversationWasThinking &&
    nowMs - facts.lastConversationTs >= 2 * DAY
  ) {
    const convDay = new Date(facts.lastConversationTs).toISOString().slice(0, 10);
    push(
      "thinking",
      convDay,
      `Said they were thinking it over on ${convDay} and there has been no conversation since.`,
    );
  }

  // intro / second_chase — the never-reached. A voicemail is not a contact.
  if (active && !facts.hadConversation) {
    if (!history.introSentAt) {
      // At least one failed attempt, or the lead has sat 2+ days untouched.
      const aged = nowMs - num(d.receivedAt) >= 2 * DAY;
      if (facts.attemptCount >= 1 || aged) {
        push(
          "intro",
          "once",
          facts.attemptCount >= 1
            ? `${facts.attemptCount} phone attempt(s), no conversation yet — the letter may be the only channel that reaches them.`
            : "Referral is 2+ days old with no contact — open the mail channel.",
        );
      }
    } else if (nowMs - history.introSentAt >= 12 * DAY) {
      push(
        "second_chase",
        "once",
        "Intro letter mailed 12+ days ago and still no conversation — one more, more urgent, letter.",
      );
    }
  }

  if (!candidates.length) return null;

  // Most urgent wins (one letter per lead per sweep).
  const priority: Record<LetterType, number> = {
    court_passed: 0,
    motions_late: 1,
    motions: 2,
    court_week: 3,
    thinking: 4,
    second_chase: 5,
    intro: 6,
  };
  candidates.sort((a, b) => priority[a.type] - priority[b.type]);
  return candidates[0];
}

// ---------- Letter rendering ----------

export interface LetterVars {
  name: string;
  courtDate?: string | null; // human, e.g. "Monday, August 24, 2026"
  courtTime?: string | null;
  courtName?: string | null;
  county?: string | null;
  stateName?: string | null; // "Arkansas" / "Missouri"
  deadlineDate?: string | null; // human motions deadline
}

const FIRM = {
  name: "Iron Rock Law Firm",
  line1: "PO Box 125",
  line2: "131 Church Street",
  city: "Salem",
  state: "AR",
  zip: "72576",
  phone: "870-399-1440",
  signer: "Stephanie McBride",
  signerTitle: "Office Manager",
};

export const FIRM_CONTACT = {
  companyName: FIRM.name,
  addressLine1: FIRM.line1,
  city: FIRM.city,
  provinceOrState: FIRM.state,
  postalOrZip: FIRM.zip,
  country: "US",
};

// "VISHUN PAL" -> "Vishun Pal" for the salutation.
export function titleCaseName(name: string): string {
  return name
    .trim()
    .split(/\s+/)
    .map((w) => (w.length <= 2 && w === w.toUpperCase() && !/[a-z]/.test(w)
      ? w // keep short all-caps tokens (initials like "JD")
      : w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()))
    .join(" ");
}

const esc = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function courtLine(v: LetterVars): string {
  const where = [v.courtName, v.county ? `${v.county} County` : null, v.stateName]
    .filter(Boolean)
    .join(", ");
  return `${v.courtDate ?? ""}${v.courtTime ? ` at ${v.courtTime}` : ""}${where ? ` — ${where}` : ""}`;
}

// The big boxed panel that makes milestone letters worth keeping on the
// fridge: the court date, and the escape hatch phone number under it.
function keepThisBox(v: LetterVars, heading: string): string {
  return `
  <div style="border:3px solid #14532d; border-radius:8px; padding:16px 20px; margin:22px 0; text-align:center;">
    <div style="font-size:11px; letter-spacing:2px; font-weight:bold; color:#14532d;">${esc(heading)}</div>
    <div style="font-size:20px; font-weight:bold; margin:6px 0;">${esc(courtLine(v))}</div>
    <div style="font-size:13px;">Can't make it? Call <b>${FIRM.phone}</b> — you may not have to.</div>
  </div>`;
}

function para(text: string): string {
  return `<p style="margin:0 0 14px 0;">${text}</p>`;
}

// Per-letter body copy. Grounded, short sentences, one job: make them call.
function letterBody(type: LetterType, v: LetterVars): string {
  const state = v.stateName ?? "Arkansas";
  const court = v.courtDate
    ? `Your court date is <b>${esc(courtDate(v))}</b>.`
    : "";
  switch (type) {
    case "intro":
      return [
        para(
          `TVC (Truckers Voice in Court) has assigned your traffic case in ${esc(state)} to our firm, and we have been trying to reach you by phone. We can help you.`,
        ),
        v.courtDate ? para(court + ` As things stand, the court expects you to appear in person in ${esc(state)}.`) : "",
        para(
          `If we are hired, we can ask the court to excuse your appearance — most of our clients never travel back at all. We work to get tickets dismissed, reduced, or beaten at trial, and we protect your driving record and your CDL.`,
        ),
        para(`Please call us at <b>${FIRM.phone}</b>. It costs nothing to talk, and we can start filing court documents on your behalf immediately.`),
        v.courtDate ? keepThisBox(v, "KEEP THIS — YOUR COURT DATE") : "",
      ].join("");
    case "second_chase":
      return [
        para(
          `We have tried to reach you by phone several times about your traffic case in ${esc(state)} — this letter may be the only way to reach you.`,
        ),
        v.courtDate
          ? para(
              court +
                ` Important deadlines come before that date, and once they pass, some of the best options for your case pass with them.`,
            )
          : para(`Important deadlines in a traffic case expire quickly, and once they pass, some of the best options for your case pass with them.`),
        para(
          `One phone call is all it takes to find out what we can do — including asking the court to excuse you from appearing in person. Call <b>${FIRM.phone}</b> today.`,
        ),
        v.courtDate ? keepThisBox(v, "KEEP THIS — YOUR COURT DATE") : "",
      ].join("");
    case "thinking":
      return [
        para(`It was good to speak with you about your traffic case in ${esc(state)}. You wanted some time to think it over — that's fair, and this letter is here when you're ready.`),
        para(
          `Here is what hiring us gets you: we ask the court to excuse your personal appearance, so you don't travel. We work to get the ticket dismissed, negotiated down, or beaten at trial. Your driving record — and your livelihood — stays protected.`,
        ),
        v.courtDate
          ? para(
              court +
                ` The sooner we start, the more options we have. Filing deadlines come well before the court date itself.`,
            )
          : "",
        para(`Call <b>${FIRM.phone}</b> and we can have your defense started the same day.`),
        v.courtDate ? keepThisBox(v, "KEEP THIS — YOUR COURT DATE") : "",
      ].join("");
    case "motions":
      return [
        para(
          `There is an important deadline coming in your ${esc(state)} traffic case: <b>${esc(v.deadlineDate ?? "the filing deadline")}</b> is the last day to file a Motion to Continue.`,
        ),
        para(
          `Why it matters to you: right now the court expects you to appear in person${v.courtDate ? ` on <b>${esc(courtDate(v))}</b>` : ""}. If you hire us before the deadline, we can file to move that date and ask the court to excuse your appearance — meaning you likely never make the trip at all, and we get the time we need to fight the ticket properly.`,
        ),
        para(
          `After the deadline passes, this option gets much harder. Call <b>${FIRM.phone}</b> today and we can have the paperwork moving the same day.`,
        ),
        v.courtDate ? keepThisBox(v, "KEEP THIS — YOUR COURT DATE") : "",
      ].join("");
    case "motions_late":
      return [
        para(
          `The standard deadline to file a Motion to Continue in your ${esc(state)} traffic case has now passed — but this is not over.`,
        ),
        para(
          `Courts sometimes accept late-filed motions, and every day matters. If you call us immediately, we can still try to move your court date${v.courtDate ? ` (<b>${esc(courtDate(v))}</b>)` : ""} and ask the court to excuse you from appearing in person.`,
        ),
        para(
          `If we can't move it, you are expected in court — and missing it can lead to a warrant. Don't let it get there. Call <b>${FIRM.phone}</b> the moment you read this.`,
        ),
        v.courtDate ? keepThisBox(v, "KEEP THIS — YOUR COURT DATE") : "",
      ].join("");
    case "court_week":
      return [
        para(
          `This is a free courtesy reminder from our office: your court date in ${esc(state)} is coming up.`,
        ),
        keepThisBox(v, "YOUR COURT DATE — ABOUT ONE WEEK AWAY"),
        para(
          `If you plan to appear, we wish you the best — no reply needed. If you can't be there, or you'd rather not make the trip, call us right away: in many cases we can still ask the court for a new date and appear on your behalf.`,
        ),
        para(`Missing a court date usually leads to a warrant. A five-minute call to <b>${FIRM.phone}</b> can keep it from getting there.`),
      ].join("");
    case "court_passed":
      return [
        para(
          `Our records show your court date in ${esc(state)}${v.courtDate ? ` (<b>${esc(courtDate(v))}</b>)` : ""} has passed. If you appeared or resolved the ticket — congratulations, and you can set this letter aside.`,
        ),
        para(
          `If you did not appear, the court <b>may have issued a warrant</b> for failure to appear. This is serious, but it is fixable: our firm handles warrant recalls, and the sooner it's addressed, the simpler it is — a routine traffic stop should never turn into an arrest.`,
        ),
        para(`Call us at <b>${FIRM.phone}</b>. We will tell you honestly where your case stands and exactly what it takes to clear it up.`),
      ].join("");
  }
}

function courtDate(v: LetterVars): string {
  return `${v.courtDate}${v.courtTime ? ` at ${v.courtTime}` : ""}`;
}

// Full letter HTML: letterhead, date, salutation, body, signature, and the
// advertising-compliance footer. PostGrid stamps the recipient address into
// the top of page one (addressPlacement top_first_page), so the layout
// leaves that zone clear.
export function renderLetterHtml(type: LetterType, v: LetterVars, todayHuman: string): string {
  const body = letterBody(type, v);
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><style>
  body { font-family: Georgia, 'Times New Roman', serif; font-size: 14px; color: #111; line-height: 1.5; }
</style></head>
<body>
  <!-- PostGrid address window occupies the top of page 1 -->
  <div style="height: 220px;"></div>
  <div style="text-align:center; border-bottom: 3px double #14532d; padding-bottom: 10px; margin-bottom: 18px;">
    <div style="font-size: 22px; font-weight: bold; letter-spacing: 1px; color: #14532d;">${FIRM.name.toUpperCase()}</div>
    <div style="font-size: 11px;">${FIRM.line2} · ${FIRM.line1} · ${FIRM.city}, ${FIRM.state} ${FIRM.zip} · <b>${FIRM.phone}</b></div>
  </div>
  <p style="margin:0 0 14px 0;">${esc(todayHuman)}</p>
  <p style="margin:0 0 14px 0;">Dear ${esc(titleCaseName(v.name))},</p>
  ${body}
  <p style="margin:22px 0 2px 0;">Sincerely,</p>
  <p style="margin:0;"><b>${FIRM.signer}</b><br>${FIRM.signerTitle}, ${FIRM.name}<br><b>${FIRM.phone}</b></p>
  <div style="margin-top: 26px; border-top: 1px solid #999; padding-top: 8px; font-size: 9px; color: #555;">
    ADVERTISING MATERIAL. This letter is a communication from a law firm and is not legal advice.
    If you have already retained counsel for this matter or resolved it, please disregard this letter
    and accept our apologies — call ${FIRM.phone} and we will update our records immediately.
  </div>
</body></html>`;
}

// Plain-text preview for the Mail Room card (no HTML soup in the UI).
export function letterPreviewText(type: LetterType, v: LetterVars): string {
  return letterBody(type, v)
    .replace(/<div[^>]*>/g, "\n")
    .replace(/<p[^>]*>/g, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{2,}/g, "\n\n")
    .trim();
}
