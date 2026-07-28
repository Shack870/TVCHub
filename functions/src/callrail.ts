import { onSchedule } from "firebase-functions/v2/scheduler";
import { defineSecret } from "firebase-functions/params";
import { logger } from "firebase-functions/v2";
import { getFirestore } from "firebase-admin/firestore";
import { randomUUID } from "node:crypto";
import { stampHeartbeat } from "./heartbeat.js";
import { correctNameInText, nameVerdict } from "./nameMatch.js";
import { hardDeclineMove } from "./noSaleRouting.js";

// CallRail → TVCHub phone-activity sync.
//
// Every few minutes this pulls recent calls from the CallRail API and, for any
// call whose customer number matches a lead's phone:
//   - outbound or answered-inbound  -> appends an auto-logged contact attempt
//   - missed/voicemail inbound      -> drops a "missed call" post-it on the desk
//
// SAFETY: sales-critical stages move only by human action or verified payment.
// Two deliberate, user-approved automatic moves exist:
//   1. Payment confirmed on a transcript moves the lead off the working board
//      — paid_full -> intake_complete, paid_partial -> financed — with an
//      audit note on the lead and the attempt. promised_unpaid (yes, but no
//      money yet) never auto-moves, and if both rules fire on the same call
//      the sale move wins.
//   2. First contact activity promotes new -> callback: logging an auto
//      attempt (call or synced email) on a lead still in 'new' means it is no
//      longer untouched. ONLY that promotion — no other stage is ever touched,
//      and nothing is ever downgraded.
//   3. A HARD decline on the transcript ("already paid the ticket myself",
//      "hired another lawyer", explicit final refusal) routes an unsold board
//      lead to 'lost' (the No Sale view) — see noSaleRouting.ts for the
//      guards (never a paying client, never a lead a human revived out of
//      lost, never on a call older than the lost stamp). Soft declines
//      (price, thinking, wants evidence) stay on the board.
// Human-set retained/financed/intake_complete/lost stages are never overridden.
//
// ANALYSIS IS NEVER DROPPED: a connected call's transcript analysis either
// attaches when the call is processed, or — when the transcript isn't ready
// yet / the classifier call fails — the marker is stamped analysisPending and
// the late-attach pass re-checks it every run until the analysis lands (with
// the same guarded outcome/stage/sale consequences the live path applies).

const CALLRAIL_API_KEY = defineSecret("CALLRAIL_API_KEY");
const OPENAI_API_KEY_CR = defineSecret("OPENAI_API_KEY");
const CALLRAIL_ACCOUNT = "ACC0abdb2f39b9f45689f56e0e1eaea2ca3"; // Iron Rock Law Firm (#521-588-434)

interface CrCall {
  id: string;
  direction: "inbound" | "outbound";
  answered: boolean;
  voicemail: boolean;
  duration: number | null;
  customer_phone_number: string | null;
  customer_name: string | null;
  start_time: string;
  recording_player: string | null;
  recording_duration: number | null;
  transcription: string | null;
}

// What the transcript classifier returns. Everything is advisory: it enriches
// the contact log and schedules callbacks, but never moves the sales stage.
export interface CallAnalysis {
  connection: "conversation" | "brief" | "voicemail" | "wrong_number" | "unclear";
  pitched: boolean;
  pitchResult: "bought" | "declined" | "thinking" | "not_pitched";
  summary: string;
  commitments: string[];
  callbackAt: string | null; // ISO date if a specific callback was agreed
  upset: boolean;
  // Sale block. "promised_unpaid" (a verbal yes with no payment taken on the
  // call) is the money-on-the-table state that drives the billing cadence.
  saleStatus: "none" | "paid_full" | "paid_partial" | "promised_unpaid";
  saleAmount: number | null;
  paymentPlan: "full" | "financed" | "unknown";
  paymentPromise: string | null;
  // For promised_unpaid: WHY no money moved on this call — the caller's stated
  // reason, or an explicit call-out that the agent never attempted to collect.
  nonPaymentReason: string | null;
  // The caller talks like an ALREADY-HIRED client (asking for a status update
  // on a case the firm is handling), not a prospect being sold. When the app
  // still has the lead as unsold, that mismatch means the retention likely
  // happened outside the app's view — pause the sales cadence and ask a human
  // (the July QA's "retained client chased as prospect" failure).
  existingClientInquiry: boolean;
  // Decline classification. HARD = final and unambiguous (already paid the
  // ticket themselves, hired another lawyer, case already resolved, explicit
  // final refusal) — drives the No Sale auto-route (noSaleRouting.ts). SOFT =
  // could still turn (price objection, wants to think, wants evidence) and
  // never moves a lead.
  declineType: "none" | "soft" | "hard";
  declineReason: string | null; // short factual why, for hard/soft declines
  // The caller's name as heard on the call. When the call is tied to a known
  // lead the prompt carries the lead's legal spelling, and the sync
  // reconciles mishearings back to it (nameMatch.ts) — a heard name that
  // clearly names a DIFFERENT person is kept as-is (wrong-person signal).
  callerName: string | null;
}

export const ANALYSIS_SYSTEM = `You analyze a phone call transcript between a law firm (Agent) and a traffic-case lead (Caller). The firm's funnel is: reach the lead ("connect"), pitch representation, then the lead buys, declines, or thinks about it.
Return ONLY a JSON object:
- "connection": "conversation" (a real two-way exchange), "brief" (answered but no real exchange, e.g. hung up in seconds), "voicemail" (reached voicemail/answering service), "wrong_number", or "unclear".
- "pitched": true if representation/fees/retainer were discussed as an offer.
- "pitchResult": "bought" (agreed to retain/sign), "declined", "thinking", or "not_pitched".
- "summary": 1-2 tight sentences a colleague can act on. Facts only.
- "commitments": array of concrete promises made by either side ("Member emailing signed retainer today", "Agent to confirm fee with Jody"). [] if none.
- "callbackAt": ISO date (yyyy-mm-dd) ONLY if a specific callback day was agreed, else null.
- "upset": true if the caller is angry/frustrated with the firm.
- "saleStatus": "paid_full" (payment for the FULL fee was actually taken on this call — card number read, payment processed/confirmed), "paid_partial" (a partial/first payment was actually taken on this call), "promised_unpaid" (they agreed to buy/retain but NO payment was taken on this call — e.g. "I'll pay Friday", "my boss will pay", "I'll do the DocuSign later"), or "none" (no sale). CRITICAL: a verbal yes does NOT count as paid. Only mark paid_full/paid_partial when the transcript shows money actually changing hands on this call.
- "saleAmount": the dollar amount quoted or collected as a number (e.g. 1625), or null if no figure was stated.
- "paymentPlan": "full" (paying in one payment), "financed" (payment plan / installments discussed), or "unknown".
- "paymentPromise": for promised_unpaid only — a short quote of what they committed to ("will pay Friday after payday"), else null.
- "nonPaymentReason": for promised_unpaid only — 1-2 sentences explaining WHY money did not change hands on this call. If the caller gave a reason, state it ("Gets paid Friday and will call back then", "Needs to check with his boss who covers company tickets"). If the AGENT never asked for payment or never attempted to run a card, say that explicitly ("The agent never asked for payment on this call — the yes was left hanging with no collection attempt"). null when not promised_unpaid.
- "existingClientInquiry": true ONLY when the caller speaks as an already-hired client checking on a case the firm is ALREADY handling (asking for a status update, court outcome, paperwork, or next steps on their existing case) rather than a prospect being pitched or shopping for representation. false when in doubt.
- "declineType": "hard" ONLY when the caller gave a FINAL, unambiguous no to representation: they already paid/resolved the ticket themselves, already hired another lawyer, the case is already resolved/dismissed, or they explicitly and finally refused ("not interested, stop calling"). A hard decline can appear even without a formal pitch (e.g. the caller opens with "I already paid that ticket myself"). "soft" when the decline could still turn: price objection, wants to think about it, wants to see evidence/paperwork first, needs to check with someone. A price/affordability objection alone is NEVER hard, even when the caller sounds final — it only becomes hard when they also state they are done with the matter (paying/paid the ticket themselves, letting it go, hired someone else). "none" when no decline happened on this call. When in doubt between hard and soft, use "soft".
- "declineReason": for declineType hard/soft — a short factual phrase of why ("already paid the citation himself", "hired another attorney", "thinks the fee is too high"), else null.
- "callerName": the caller's name as stated or heard on this call (full name if given), else null. If our records name a likely caller and the person on the call plausibly is them, use EXACTLY that spelling; if they are clearly a different person, report the name you actually hear.
Do not invent facts. If the transcript is empty or useless, use connection "unclear", empty summary.`;

async function analyzeTranscript(
  transcript: string,
  direction: string,
  startTime: string,
  apiKey: string,
  // Legal name from the lead the call is tied to — the referral's exact
  // spelling. Feeding it in fixes heard names at the source (the AI mishears
  // roughly half of them otherwise).
  leadName?: string | null,
): Promise<CallAnalysis | null> {
  try {
    const leadHint = leadName
      ? `\nOur records say the caller is likely ${leadName} (exact legal spelling from the court referral). If the person on this call plausibly is them, use exactly that spelling for their name; if they are clearly someone else, report the name you actually hear.`
      : "";
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        temperature: 0,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: ANALYSIS_SYSTEM },
          {
            role: "user",
            content: `Call direction: ${direction}. Call date: ${startTime}.${leadHint}\n\nTranscript:\n${transcript.slice(0, 24000)}`,
          },
        ],
      }),
    });
    const json = (await res.json()) as {
      choices?: { message?: { content?: string } }[];
      error?: { message?: string };
    };
    if (!res.ok) throw new Error(json.error?.message || `OpenAI ${res.status}`);
    const parsed = JSON.parse(json.choices?.[0]?.message?.content || "{}");
    const saleAmount = Number(parsed.saleAmount);
    return {
      connection: parsed.connection ?? "unclear",
      pitched: Boolean(parsed.pitched),
      pitchResult: parsed.pitchResult ?? "not_pitched",
      summary: String(parsed.summary ?? ""),
      commitments: Array.isArray(parsed.commitments) ? parsed.commitments.map(String) : [],
      callbackAt: parsed.callbackAt || null,
      upset: Boolean(parsed.upset),
      saleStatus: ["paid_full", "paid_partial", "promised_unpaid"].includes(parsed.saleStatus)
        ? parsed.saleStatus
        : "none",
      saleAmount: Number.isFinite(saleAmount) && saleAmount > 0 ? saleAmount : null,
      paymentPlan: ["full", "financed"].includes(parsed.paymentPlan)
        ? parsed.paymentPlan
        : "unknown",
      paymentPromise: parsed.paymentPromise ? String(parsed.paymentPromise) : null,
      nonPaymentReason: parsed.nonPaymentReason ? String(parsed.nonPaymentReason) : null,
      existingClientInquiry: Boolean(parsed.existingClientInquiry),
      declineType: ["hard", "soft"].includes(parsed.declineType) ? parsed.declineType : "none",
      declineReason: parsed.declineReason ? String(parsed.declineReason) : null,
      callerName: parsed.callerName ? String(parsed.callerName) : null,
    };
  } catch (e) {
    logger.warn("Transcript analysis failed; falling back to basic logging", e);
    return null;
  }
}

const last10 = (s: unknown): string =>
  String(s ?? "").replace(/\D/g, "").slice(-10);

// Outcomes that mean a real two-way conversation happened.
const CONVERSATION_OUTCOMES = ["spoke", "thinking", "declined", "retained", "verbal_yes"];

// Map a call (and its transcript analysis) onto the same ContactOutcome values
// the manual decision tree uses, so the timeline reads consistently whether a
// call was hand-logged or auto-logged.
export function outcomeFor(call: CrCall, analysis: CallAnalysis | null): string {
  if (analysis && analysis.connection !== "unclear") {
    if (analysis.connection === "voicemail") return "voicemail";
    if (analysis.connection !== "conversation") return "no_answer"; // brief / wrong number
    // A real conversation: refine by pitch result when the transcript shows one.
    if (analysis.pitched) {
      if (analysis.pitchResult === "bought") {
        // A yes only counts as retained when money actually moved on the call;
        // a verbal yes with no payment is its own money-on-the-table state.
        return analysis.saleStatus === "promised_unpaid" ? "verbal_yes" : "retained";
      }
      if (analysis.pitchResult === "declined") return "declined";
      if (analysis.pitchResult === "thinking") return "thinking";
    }
    return "spoke";
  }
  return call.voicemail ? "voicemail" : call.answered ? "spoke" : "no_answer";
}

// Roll a call's sale read up onto the lead. Only evidence NEWER than what's
// already recorded can change the state, and a human-set paid state is never
// downgraded by an older call arriving late from the API.
export function saleRollup(
  d: Record<string, unknown>,
  analysis: CallAnalysis,
  callTs: number,
): Record<string, unknown> | null {
  if (analysis.saleStatus === "none") return null;
  const prevAt = (d.saleStatusAt as number) ?? 0;
  if (callTs <= prevAt) return null;
  const patch: Record<string, unknown> = {
    saleStatus: analysis.saleStatus,
    saleStatusAt: callTs,
  };
  if (analysis.saleAmount) patch.saleAmount = analysis.saleAmount;
  if (analysis.saleStatus === "promised_unpaid") {
    patch.salePromisedAt = callTs;
    patch.saleNonPaymentReason = analysis.nonPaymentReason ?? null;
  } else {
    // Paid (full or partial) clears the promised flag and its escalation.
    patch.saleEscalatedAt = null;
  }
  return patch;
}

// Stages the classifier may move a lead OUT of when payment is confirmed on a
// call. Human-set retained/financed/intake_complete/lost are never overridden,
// and promised_unpaid stays on the board under the gold ribbon (no money yet).
const AUTO_MOVE_FROM = ["new", "callback", "pitched", "attorney_call", "nurture"];

// The one sanctioned automatic stage move: transcript shows money collected.
// paid_full -> intake_complete (handed off), paid_partial -> financed (paying).
// Returns the lead patch plus the audit note to stamp on the attempt.
export function autoStageMove(
  d: Record<string, unknown>,
  analysis: CallAnalysis,
  callTs: number,
): { patch: Record<string, unknown>; note: string } | null {
  if (analysis.saleStatus !== "paid_full" && analysis.saleStatus !== "paid_partial") return null;
  if (!AUTO_MOVE_FROM.includes(d.stage as string)) return null;
  const to = analysis.saleStatus === "paid_full" ? "intake_complete" : "financed";
  const label = to === "intake_complete" ? "Intake Complete" : "Financed";
  const day = new Date(callTs).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "America/Chicago",
  });
  const note = `Stage moved to ${label} by classifier — payment confirmed on ${day} call`;
  const now = Date.now();
  const followUps = Array.isArray(d.followUps) ? (d.followUps as Record<string, unknown>[]) : [];
  const patch: Record<string, unknown> = {
    stage: to,
    // Business dates come from the CALL where the payment happened, not from
    // when the automation got around to processing it.
    retainedAt: (d.retainedAt as number) ?? callTs,
    autoStageNote: note,
    autoStageAt: now, // when the automation acted — audit metadata only
    // Money collected — sales follow-ups no longer apply; close them so they
    // don't linger on the calendar / Today queue.
    followUps: followUps.map((f) => (f.done ? f : { ...f, done: true, doneAt: now })),
  };
  if (to === "financed") patch.isFinanced = true;
  if (to === "intake_complete") {
    patch.intakeComplete = true;
    patch.intakeCompleteAt = callTs;
  }
  return { patch, note };
}

function fmtDuration(sec: number | null): string {
  if (!sec) return "";
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return m ? `${m}m ${s}s` : `${s}s`;
}

// --- Deferral & late analysis attachment ------------------------------------
// CallRail exposes calls the moment they START and fills duration → recording
// → transcription asynchronously over the following minutes. Processing a
// call before those settle logs a bare attempt, and the marker doc blocks
// every retry. Two layers of defense:
//   1. deferReason: fresh calls that are still settling are skipped WITHOUT a
//      marker so a later run sees the final record.
//   2. analysisPending markers: when an attempt IS logged without an `ai` map
//      on a call that should have produced one (transcript still missing
//      after the deferral window, or the OpenAI call itself failed — the
//      Michael Harris case, where a quota error at process time silently
//      dropped the analysis of a 15-minute sale call), the marker is stamped
//      analysisPending and the late-attach pass below re-checks it every run
//      until the analysis lands or the call ages out.

// How long a fresh call may defer (no marker) waiting to settle.
const DEFER_WINDOW_MS = 3 * 3600_000;
// An answered call at least this long is expected to produce a transcript —
// don't require recording_duration, which CallRail publishes LATE (a call
// processed right after hangup has duration but no recording metadata yet).
export const TRANSCRIPT_EXPECTED_MIN_SEC = 30;
// The late-attach pass gives up on markers older than this.
const LATE_ATTACH_MAX_AGE_MS = 7 * 86400_000;

// Why a fresh call must wait for the next run (or null = process it now).
export function deferReason(
  call: Pick<
    CrCall,
    "answered" | "duration" | "recording_duration" | "transcription" | "start_time"
  >,
  now: number,
): "in_progress" | "transcript_pending" | null {
  const startedAt = new Date(call.start_time).getTime() || now;
  if (now - startedAt >= DEFER_WINDOW_MS) return null; // stop waiting — log it
  // Still ringing / in progress: duration is null until the call ends.
  if (call.duration == null) return "in_progress";
  // Answered call that should produce a transcript but hasn't yet. Either the
  // recording exists and transcription is still running, or the call just
  // ended and even the recording metadata hasn't been published (the old
  // Boolean(recording_duration) gate missed that window and logged bare
  // attempts the marker then froze forever).
  if (
    call.answered &&
    (Boolean(call.recording_duration) || (call.duration ?? 0) >= TRANSCRIPT_EXPECTED_MIN_SEC) &&
    (!call.transcription || call.transcription.length <= 40)
  ) {
    return "transcript_pending";
  }
  return null;
}

// Rebuild an already-logged attempt with a late-arriving analysis: the ai map
// lands, the outcome is upgraded to the classifier's read, and the factual
// note/duration/recording fields are refreshed from the final call record.
// Pure — the caller owns the transaction.
export function lateAnalysisAttemptUpdate(
  attempt: Record<string, unknown>,
  call: CrCall,
  analysis: CallAnalysis,
): { attempt: Record<string, unknown>; outcome: string } {
  const outcome = outcomeFor(call, analysis);
  const dir = call.direction === "inbound" ? "Inbound" : "Outbound";
  const dur = fmtDuration(call.duration);
  let notes = `${dir} call via CallRail${dur ? ` — ${dur}` : ""}.`;
  if (analysis.connection === "wrong_number") {
    notes += " ⚠ Sounded like a wrong number — verify the phone on file.";
  }
  return {
    attempt: {
      ...attempt,
      outcome,
      notes,
      recordingUrl: call.recording_player || null,
      durationSec: call.duration ?? null,
      ai: analysis as unknown as Record<string, unknown>,
    },
    outcome,
  };
}

// Single-call fetch for the late-attach pass (the incremental list may no
// longer cover the call by the time its transcript shows up).
async function fetchCallById(apiKey: string, id: string): Promise<CrCall | null> {
  const fields =
    "id,direction,answered,voicemail,duration,customer_phone_number,customer_name,start_time,recording_player,recording_duration,transcription";
  const res = await fetch(
    `https://api.callrail.com/v3/a/${CALLRAIL_ACCOUNT}/calls/${id}.json?fields=${fields}`,
    { headers: { Authorization: `Token token="${apiKey}"` } },
  );
  if (!res.ok) {
    logger.warn(`CallRail call ${id} lookup failed: ${res.status}`);
    return null;
  }
  return (await res.json()) as CrCall;
}

async function fetchRecentCalls(apiKey: string): Promise<CrCall[]> {
  // A 48h window re-covers outages; already-processed calls are skipped via
  // marker docs, so overlap is harmless.
  const startDate = new Date(Date.now() - 48 * 3600_000).toISOString();
  const fields =
    "id,direction,answered,voicemail,duration,customer_phone_number,customer_name,start_time,recording_player,recording_duration,transcription";
  const calls: CrCall[] = [];
  let page = 1;
  for (;;) {
    const url =
      `https://api.callrail.com/v3/a/${CALLRAIL_ACCOUNT}/calls.json` +
      `?start_date=${encodeURIComponent(startDate)}&per_page=250&page=${page}&fields=${fields}`;
    const res = await fetch(url, {
      headers: { Authorization: `Token token="${apiKey}"` },
    });
    if (!res.ok) throw new Error(`CallRail ${res.status}: ${await res.text()}`);
    const json = (await res.json()) as { calls: CrCall[]; total_pages: number };
    calls.push(...(json.calls || []));
    if (page >= (json.total_pages || 1)) break;
    page++;
  }
  return calls;
}

// Adds a callback follow-up unless the lead already has an open one due within
// `withinMs` of the requested time — so machine scheduling never stacks
// duplicate reminders on top of human ones.
export async function ensureFollowUp(
  db: ReturnType<typeof getFirestore>,
  leadId: string,
  // allowLost: the cadence's lost-lead court reminders (the No Sale
  // resurrection path) are the ONE follow-up kind allowed onto a lost lead.
  opts: { dueAt: number; note: string; withinMs: number; type?: string; allowLost?: boolean },
): Promise<boolean> {
  let added = false;
  await db.runTransaction(async (tx) => {
    const ref = db.collection("leads").doc(leadId);
    const snap = await tx.get(ref);
    if (!snap.exists) return;
    const d = snap.data()!;
    // Don't chase decided leads.
    const blockedStages = opts.allowLost
      ? ["retained", "financed", "intake_complete"]
      : ["retained", "financed", "intake_complete", "lost"];
    if (blockedStages.includes(d.stage) || d.deletedAt) return;
    const followUps = Array.isArray(d.followUps) ? d.followUps : [];
    const dupe = followUps.some(
      (f: { done?: boolean; dueAt?: number }) =>
        !f.done && Math.abs((f.dueAt ?? 0) - opts.dueAt) < opts.withinMs,
    );
    if (dupe) return;
    tx.update(ref, {
      followUps: [
        ...followUps,
        {
          id: randomUUID(),
          type: opts.type ?? "callback",
          dueAt: opts.dueAt,
          done: false,
          note: opts.note,
        },
      ],
      updatedAt: Date.now(),
    });
    added = true;
  });
  return added;
}

// A returned call closes the loop: mark any open "Missed call" post-its from
// before the call as handled — matched by lead OR by the phone number on the
// note itself (last 10 digits), so post-its without a leadId still clear when
// we call that number back. Handled notes land in the UI's Handled tab
// (handled + handledAt), keeping the paper trail instead of silently
// archiving. "Upset caller" notes are left for a human even though they share
// the missed_call kind.
async function clearMissedCallPostIts(
  db: ReturnType<typeof getFirestore>,
  opts: { leadId?: string | null; phoneKey?: string; callTs: number },
): Promise<number> {
  const phoneKey = opts.phoneKey && opts.phoneKey.length === 10 ? opts.phoneKey : null;
  if (!opts.leadId && !phoneKey) return 0;
  const snap = await db
    .collection("messages")
    .where("kind", "==", "missed_call")
    .where("handled", "==", false)
    .get();
  const now = Date.now();
  let cleared = 0;
  for (const doc of snap.docs) {
    const m = doc.data();
    if (m.deletedAt) continue;
    if (!String(m.subject || "").startsWith("Missed call")) continue;
    if ((m.receivedAt ?? 0) > opts.callTs) continue; // they missed us again AFTER this call
    const leadMatch = Boolean(opts.leadId && m.leadId === opts.leadId);
    const phoneMatch = Boolean(
      phoneKey && (last10(m.phone) === phoneKey || last10(m.from) === phoneKey),
    );
    if (!leadMatch && !phoneMatch) continue;
    await doc.ref.update({
      handled: true,
      handledAt: opts.callTs,
      handledBy: "CallRail sync",
      updatedAt: now,
    });
    cleared++;
  }
  return cleared;
}

// Analysis-driven side effects shared by the live sync path and the
// late-attach pass — both MUST behave identically, whether the analysis
// arrived with the call or hours later: the possible-existing-client post-it,
// the collect-now follow-up on a fresh verbal yes, the agreed-callback
// follow-up, and the upset-caller post-it. Returns how many post-its landed.
async function analysisSideEffects(
  db: ReturnType<typeof getFirestore>,
  opts: {
    lead: { id: string; name: string; phone: string | null; email: string | null };
    call: CrCall;
    analysis: CallAnalysis;
    startedAt: number;
    flaggedExistingClient: boolean;
  },
): Promise<number> {
  const { lead, call, analysis, startedAt, flaggedExistingClient } = opts;
  let postIts = 0;
  const dir = call.direction === "inbound" ? "Inbound" : "Outbound";

  // Possible existing client flagged in the transaction — put the
  // verification ask on the desk (same Action Item treatment as the cadence
  // engine's notes).
  if (flaggedExistingClient) {
    await db.collection("messages").add({
      kind: "tvc_message",
      source: "system",
      from: "CallRail Sync",
      fromName: "CallRail Sync",
      subject: `Possible existing client — ${lead.name}`,
      message:
        `Possible existing client — ${lead.name} called for a case status update; ` +
        `verify retention before sales outreach.\n` +
        `The app still has them as an unsold prospect, so the retention may have happened ` +
        `outside the app's view (check with the firm / Square). Sales chasing is PAUSED ` +
        `until this is resolved — mark the sale (or clear the flag) to resume.\n` +
        `What the call said: ${analysis.summary}` +
        (call.recording_player ? `\nListen: ${call.recording_player}` : ""),
      tvcCaseNumber: null,
      memberName: lead.name,
      leadId: lead.id,
      phone: lead.phone || call.customer_phone_number || null,
      email: lead.email,
      gmailMessageId: null,
      callrailCallId: call.id,
      receivedAt: startedAt,
      handled: false,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    postIts++;
    logger.info("Flagged possible existing client; sales cadence paused", {
      leadId: lead.id,
      name: lead.name,
      callId: call.id,
    });
  }

  // A fresh verbal yes goes straight onto the billing track: collect while
  // the commitment is hot instead of waiting for tomorrow's sweep.
  if (analysis.saleStatus === "promised_unpaid") {
    await ensureFollowUp(db, lead.id, {
      dueAt: Date.now(),
      note:
        `Collect payment — said YES on the call` +
        (analysis.saleAmount ? ` ($${analysis.saleAmount} promised)` : "") +
        (analysis.paymentPromise ? ` — "${analysis.paymentPromise}"` : ""),
      withinMs: 12 * 3600_000,
      type: "billing",
    });
  }

  // A specific callback day agreed on the call becomes a real follow-up so
  // it lands on the calendar and the Today queue.
  if (analysis.callbackAt && /^\d{4}-\d{2}-\d{2}$/.test(analysis.callbackAt)) {
    const at = new Date(`${analysis.callbackAt}T09:00:00-05:00`).getTime();
    if (at > Date.now() - 86400_000) {
      await ensureFollowUp(db, lead.id, {
        dueAt: at,
        note: `Agreed callback (from call transcript)`,
        withinMs: 12 * 3600_000,
      });
    }
  }

  // An upset caller is a fire — put it on the desk like a missed call.
  if (analysis.upset) {
    await db.collection("messages").add({
      kind: "missed_call",
      source: "system",
      from: call.customer_phone_number || "",
      fromName: lead.name,
      subject: `Upset caller: ${lead.name}`,
      message:
        `⚠ The transcript of this ${dir.toLowerCase()} call sounds upset/frustrated.\n` +
        `${analysis.summary}` +
        (call.recording_player ? `\nListen: ${call.recording_player}` : ""),
      tvcCaseNumber: null,
      memberName: lead.name,
      leadId: lead.id,
      phone: lead.phone || call.customer_phone_number || null,
      email: lead.email,
      gmailMessageId: null,
      callrailCallId: call.id,
      receivedAt: startedAt,
      handled: false,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    postIts++;
  }

  return postIts;
}

// The late-attach pass: every marker stamped analysisPending is a logged
// attempt still missing its `ai` map. Re-fetch the call, and once the
// transcript exists run the SAME classifier and apply the SAME consequences
// the live path would have: analysis on the attempt, outcome upgraded to the
// classifier's read, lastConnectedAt, sale rollup, the sanctioned stage moves
// (payment-confirmed / hard-decline, both fully guarded), and the analysis
// side effects. Markers clear on success; calls that never produce a
// transcript age out after 7 days.
async function attachDeferredAnalyses(
  db: ReturnType<typeof getFirestore>,
  crApiKey: string,
  openaiKey: string,
): Promise<{ attached: number; gaveUp: number }> {
  const snap = await db
    .collection("callrailCalls")
    .where("analysisPending", "==", true)
    .get();
  let attached = 0;
  let gaveUp = 0;
  for (const m of snap.docs) {
    const md = m.data();
    const callId = m.id;
    const startedAt = (md.startedAt as number) ?? (md.processedAt as number) ?? 0;
    const giveUp = async (why: string) => {
      await m.ref.update({
        analysisPending: false,
        analysisGaveUpAt: Date.now(),
        analysisGaveUpWhy: why,
      });
      gaveUp++;
      logger.info("Gave up attaching late analysis", { callId, why });
    };
    if (!md.leadId) {
      await giveUp("no lead on the marker");
      continue;
    }
    if (Date.now() - startedAt > LATE_ATTACH_MAX_AGE_MS) {
      await giveUp("call aged out (7 days) with no transcript/analysis");
      continue;
    }

    const call = await fetchCallById(crApiKey, callId);
    if (!call) continue; // transient API failure — retry next run
    const transcript = call.transcription ?? "";
    if (transcript.length <= 40) {
      // No transcript yet. A recording that never materialized on an
      // hours-old call means none is coming.
      if (!call.recording_duration && Date.now() - startedAt > DEFER_WINDOW_MS) {
        await giveUp("call has no recording — no transcript will ever exist");
      }
      continue; // still transcribing — retry next run
    }

    const leadRef = db.collection("leads").doc(md.leadId as string);
    const leadSnap = await leadRef.get();
    if (!leadSnap.exists || leadSnap.data()?.deletedAt) {
      await giveUp("lead missing or deleted");
      continue;
    }
    const leadName = (leadSnap.data()?.name as string) ?? null;

    const analysis = await analyzeTranscript(
      transcript,
      call.direction,
      call.start_time,
      openaiKey,
      leadName,
    );
    if (!analysis) continue; // classifier failed again — retry next run

    // Same heard-name reconciliation as the live path.
    if (
      analysis.callerName &&
      leadName &&
      nameVerdict(analysis.callerName, leadName) === "match" &&
      analysis.callerName !== leadName
    ) {
      analysis.callerName = leadName;
    }
    if (leadName) {
      const fixedSummary = correctNameInText(analysis.summary, leadName);
      if (fixedSummary) analysis.summary = fixedSummary;
    }

    let outcome: string | null = null;
    let movedTo: string | null = null;
    let flaggedExistingClient = false;
    let leadForEffects: {
      id: string;
      name: string;
      phone: string | null;
      email: string | null;
    } | null = null;
    await db.runTransaction(async (tx) => {
      const snap2 = await tx.get(leadRef);
      if (!snap2.exists) return;
      const d = snap2.data()!;
      if (d.deletedAt) return;
      const attempts = Array.isArray(d.contactAttempts) ? d.contactAttempts : [];
      const idx = attempts.findIndex(
        (a: { callId?: string }) => a?.callId === callId,
      );
      if (idx < 0) return; // attempt vanished — marker cleared below either way
      if (attempts[idx].ai) return; // someone already attached it — done
      const callTs = (attempts[idx].ts as number) ?? startedAt;

      const updated = lateAnalysisAttemptUpdate(attempts[idx], call, analysis);
      outcome = updated.outcome;

      // Same sanctioned consequences as the live path, same guards: the
      // payment-confirmed move only leaves working-board stages, the hard
      // decline only fires on unsold board leads, and the sale rollup only
      // acts on evidence NEWER than what's already on the lead — a lead
      // hand-corrected after the call (saleStatusAt at payment time) is
      // left completely untouched.
      const move = autoStageMove(d, analysis, callTs);
      const lostMove = !move ? hardDeclineMove(d, analysis, callTs) : null;
      const applied = move ?? lostMove;
      const attemptFinal = applied
        ? { ...updated.attempt, notes: `${updated.attempt.notes} → ${applied.note}.` }
        : updated.attempt;
      const patch: Record<string, unknown> = {
        contactAttempts: attempts.map((a: unknown, i: number) =>
          i === idx ? attemptFinal : a,
        ),
        updatedAt: Date.now(),
      };
      if (
        analysis.existingClientInquiry &&
        !move &&
        !d.possibleExistingClientAt &&
        !(typeof d.saleStatus === "string" && (d.saleStatus as string).startsWith("paid")) &&
        AUTO_MOVE_FROM.includes(d.stage as string)
      ) {
        patch.possibleExistingClientAt = callTs;
        flaggedExistingClient = true;
      }
      if (
        CONVERSATION_OUTCOMES.includes(updated.outcome) &&
        ((d.lastConnectedAt as number) ?? 0) < callTs
      ) {
        patch.lastConnectedAt = callTs;
      }
      const sale = saleRollup(d, analysis, callTs);
      if (sale) Object.assign(patch, sale);
      if (move) {
        Object.assign(patch, move.patch);
        movedTo = move.patch.stage as string;
      } else if (lostMove) {
        Object.assign(patch, lostMove.patch);
        movedTo = "lost";
      }
      tx.update(leadRef, patch);
      leadForEffects = {
        id: leadRef.id,
        name: (d.name as string) ?? "",
        phone: (d.phone as string) || null,
        email: (d.email as string) || null,
      };
    });

    if (leadForEffects && outcome) {
      await analysisSideEffects(db, {
        lead: leadForEffects,
        call,
        analysis,
        startedAt,
        flaggedExistingClient,
      });
    }
    await m.ref.update({
      analysisPending: false,
      analysisAttachedAt: Date.now(),
      ...(outcome ? { action: outcome } : {}),
    });
    attached++;
    logger.info("Attached late analysis to logged attempt", {
      callId,
      leadId: md.leadId,
      outcome,
      movedTo,
      saleStatus: analysis.saleStatus,
      summary: analysis.summary.slice(0, 120),
    });
  }
  return { attached, gaveUp };
}

export const syncCallRail = onSchedule(
  {
    schedule: "every 5 minutes",
    secrets: [CALLRAIL_API_KEY, OPENAI_API_KEY_CR],
    timeoutSeconds: 300,
  },
  async () => {
    const db = getFirestore();

    // Late-attach pass first: attempts logged on earlier runs that are still
    // missing their analysis (analysisPending markers) get re-checked every
    // run — quiet phones must not delay a transcript that just landed.
    let late = { attached: 0, gaveUp: 0 };
    try {
      late = await attachDeferredAnalyses(
        db,
        CALLRAIL_API_KEY.value(),
        OPENAI_API_KEY_CR.value(),
      );
    } catch (e) {
      logger.warn("Late-analysis attach pass failed; continuing with the sync", e);
    }

    const calls = await fetchRecentCalls(CALLRAIL_API_KEY.value());
    if (!calls.length) {
      if (late.attached || late.gaveUp) {
        logger.info("CallRail sync: quiet phones", { lateAttached: late.attached, lateGaveUp: late.gaveUp });
      }
      await stampHeartbeat("syncCallRail"); // quiet phones still = healthy run
      return;
    }

    // Phone -> lead index over recent leads (covers the active board plus
    // months of history; older completed cases don't get phone activity).
    const leadSnap = await db
      .collection("leads")
      .orderBy("createdAt", "desc")
      .limit(1000)
      .select("name", "phone", "altPhone", "email", "deletedAt")
      .get();
    const byPhone = new Map<
      string,
      { id: string; name: string; phone: string | null; email: string | null }
    >();
    for (const doc of leadSnap.docs) {
      const d = doc.data();
      if (d.deletedAt) continue;
      for (const p of [d.phone, d.altPhone]) {
        const key = last10(p);
        // First (newest) lead wins a shared number.
        if (key.length === 10 && !byPhone.has(key)) {
          byPhone.set(key, {
            id: doc.id,
            name: d.name,
            phone: (d.phone as string) || null,
            email: (d.email as string) || null,
          });
        }
      }
    }

    let logged = 0;
    let postIts = 0;
    for (const call of calls) {
      const marker = db.collection("callrailCalls").doc(call.id);
      if ((await marker.get()).exists) continue;

      const key = last10(call.customer_phone_number);
      const lead = key.length === 10 ? byPhone.get(key) : undefined;
      const startedAt = new Date(call.start_time).getTime() || Date.now();

      if (!lead) {
        // Even with no lead match, an outbound call to a number sitting on a
        // missed-call post-it means the callback happened — clear the note.
        if (call.direction === "outbound") {
          const cleared = await clearMissedCallPostIts(db, { phoneKey: key, callTs: startedAt });
          if (cleared) {
            logger.info("Cleared missed-call post-its by phone match (no lead)", {
              phone: call.customer_phone_number,
              cleared,
              callId: call.id,
            });
          }
        }
        await marker.set({ processedAt: Date.now(), leadId: null, action: "ignored" });
        continue;
      }

      const missedInbound =
        call.direction === "inbound" && (!call.answered || call.voicemail);

      // A call that's still ringing or in progress reports answered=false —
      // processing it now would stamp a false "missed call" post-it on a call
      // that actually connects. Skip fresh inbound calls WITHOUT a marker so
      // the next run sees the settled record.
      if (missedInbound && Date.now() - startedAt < 10 * 60_000) continue;

      // CallRail exposes calls the moment they START and fills the record in
      // asynchronously (duration → recording → transcription). A fresh call
      // that's still settling is skipped WITHOUT a marker so a later run sees
      // the final record — see deferReason for the exact rules.
      if (!missedInbound && deferReason(call, Date.now())) continue;

      if (missedInbound) {
        // Surface the callback on the desk instead of burying it in a log —
        // a lead calling back and missing us is exactly a "don't drop this".
        await db.collection("messages").add({
          kind: "missed_call",
          source: "system",
          from: call.customer_phone_number || "",
          fromName: lead.name,
          subject: `Missed call from ${lead.name}`,
          message:
            `Missed inbound call${call.voicemail ? " (left a voicemail)" : ""}` +
            ` from ${call.customer_phone_number}.` +
            (call.recording_player ? `\nListen: ${call.recording_player}` : ""),
          tvcCaseNumber: null,
          memberName: lead.name,
          leadId: lead.id,
          phone: lead.phone || call.customer_phone_number || null,
          email: lead.email,
          gmailMessageId: null,
          callrailCallId: call.id,
          receivedAt: startedAt,
          handled: false,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        });
        // They reached for us — jump the cadence: make sure a callback is due
        // TODAY (existing later follow-ups are left in place).
        await ensureFollowUp(db, lead.id, {
          dueAt: Date.now(),
          note: "They called us — call back ASAP (missed connection)",
          withinMs: 12 * 3600_000,
        });
        await marker.set({ processedAt: Date.now(), leadId: lead.id, action: "missed_call" });
        postIts++;
        continue;
      }

      // Read the transcript (when CallRail produced one) so the log entry says
      // what actually happened, not just that a call connected.
      const transcriptReady = Boolean(
        call.answered && call.transcription && call.transcription.length > 40,
      );
      const analysis = transcriptReady
        ? await analyzeTranscript(
            call.transcription!,
            call.direction,
            call.start_time,
            OPENAI_API_KEY_CR.value(),
            lead.name,
          )
        : null;

      // The transcript exists but the classifier call itself failed (OpenAI
      // outage/quota — the Michael Harris case: his 15-minute sale call was
      // logged bare because one quota error at process time dropped the
      // analysis and the marker froze it). While the call is fresh, skip
      // WITHOUT a marker so the next run simply retries; past the window the
      // attempt is logged bare and the analysisPending marker below hands the
      // call to the late-attach pass.
      if (transcriptReady && !analysis && Date.now() - startedAt < DEFER_WINDOW_MS) continue;

      // Heard-name reconciliation (belt and braces on top of the prompt
      // hint): a heard name that fuzzy-matches the lead's legal name gets the
      // legal spelling; a clearly DIFFERENT name is kept — wrong-person calls
      // are signal. The summary gets the same spelling fix.
      if (analysis) {
        if (
          analysis.callerName &&
          nameVerdict(analysis.callerName, lead.name) === "match" &&
          analysis.callerName !== lead.name
        ) {
          analysis.callerName = lead.name;
        }
        const fixedSummary = correctNameInText(analysis.summary, lead.name);
        if (fixedSummary) analysis.summary = fixedSummary;
      }

      // Outcome: prefer the transcript's read of the call over the raw
      // answered/voicemail flags, using the SAME outcome values as the manual
      // "Log a Call" decision tree (spoke / thinking / declined / retained)
      // so auto-logged and hand-logged calls line up on the timeline.
      const outcome = outcomeFor(call, analysis);

      const dir = call.direction === "inbound" ? "Inbound" : "Outbound";
      const dur = fmtDuration(call.duration);
      // Keep notes to the bare facts; the AI summary renders from the `ai`
      // field in its own block on the timeline.
      let notes = `${dir} call via CallRail${dur ? ` — ${dur}` : ""}.`;
      if (analysis && analysis.connection === "wrong_number") {
        notes += " ⚠ Sounded like a wrong number — verify the phone on file.";
      }

      const attempt = {
        ts: startedAt,
        outcome,
        notes,
        by: "CallRail sync",
        via: "callrail",
        callId: call.id,
        recordingUrl: call.recording_player || null,
        durationSec: call.duration ?? null,
        ...(analysis ? { ai: analysis as unknown as Record<string, unknown> } : {}),
      };
      let movedTo: string | null = null;
      let flaggedExistingClient = false;
      await db.runTransaction(async (tx) => {
        const ref = db.collection("leads").doc(lead.id);
        const snap = await tx.get(ref);
        if (!snap.exists) return;
        const d = snap.data()!;
        const attempts = Array.isArray(d.contactAttempts) ? d.contactAttempts : [];
        // Payment confirmed on the transcript moves the lead off the working
        // board (the one sanctioned auto-move) — the audit note lands on both
        // the lead and this attempt's timeline entry.
        const move = analysis ? autoStageMove(d, analysis, startedAt) : null;
        // HARD decline routes an unsold board lead to No Sale — but a
        // confirmed-payment move always wins if both somehow fire on one call.
        const lostMove = !move && analysis ? hardDeclineMove(d, analysis, startedAt) : null;
        const applied = move ?? lostMove;
        const attemptFinal = applied
          ? { ...attempt, notes: `${attempt.notes} → ${applied.note}.` }
          : attempt;
        const patch: Record<string, unknown> = {
          contactAttempts: [...attempts, attemptFinal],
          updatedAt: Date.now(),
        };
        // EXISTING-CLIENT DETECTOR: the transcript reads as a status-update
        // call from an already-hired client, but the app still has this lead
        // as an unsold prospect — the retention likely happened outside the
        // app's view. Never treat that call as sales momentum: stamp
        // possibleExistingClientAt (the cadence sweep pauses its chase until
        // a human clears the flag or the lead is marked sold) and put an
        // Action Item on the desk. A confirmed-payment move outranks it.
        if (
          analysis?.existingClientInquiry &&
          !move &&
          !d.possibleExistingClientAt &&
          !(typeof d.saleStatus === "string" && (d.saleStatus as string).startsWith("paid")) &&
          AUTO_MOVE_FROM.includes(d.stage as string)
        ) {
          patch.possibleExistingClientAt = startedAt;
          flaggedExistingClient = true;
        }
        // A real conversation stamps the lead as connected — the cadence sweep
        // uses this to stop the daily chase.
        if (CONVERSATION_OUTCOMES.includes(outcome)) patch.lastConnectedAt = startedAt;
        // Sale rollup: promised or collected money updates the lead's billing state.
        if (analysis) {
          const sale = saleRollup(d, analysis, startedAt);
          if (sale) Object.assign(patch, sale);
        }
        if (move) {
          Object.assign(patch, move.patch);
          movedTo = move.patch.stage as string;
        } else if (lostMove) {
          Object.assign(patch, lostMove.patch);
          movedTo = "lost";
        } else if (d.stage === "new") {
          // First contact activity: the lead is no longer untouched, so it
          // leaves Initial Leads for the pipeline. Only new -> callback — a
          // sale-driven move above wins, and every other stage stays human.
          patch.stage = "callback";
          movedTo = "callback";
        }
        tx.update(ref, patch);
      });
      if (movedTo === "callback") {
        logger.info("Promoted new lead to callback on first contact activity", {
          leadId: lead.id,
          name: lead.name,
          callId: call.id,
        });
      } else if (movedTo === "lost") {
        logger.info("Auto-routed hard decline to No Sale", {
          leadId: lead.id,
          name: lead.name,
          reason: analysis?.declineReason ?? null,
          callId: call.id,
        });
      } else if (movedTo) {
        logger.info("Auto-moved lead stage on confirmed payment", {
          leadId: lead.id,
          name: lead.name,
          to: movedTo,
          callId: call.id,
        });
      }

      // Analysis-driven side effects (existing-client post-it, collect-now
      // follow-up, agreed callback, upset-caller post-it) — shared with the
      // late-attach pass so late analyses behave identically.
      if (analysis) {
        postIts += await analysisSideEffects(db, {
          lead,
          call,
          analysis,
          startedAt,
          flaggedExistingClient,
        });
      }

      // We called them back (any outbound attempt), or they got through to us
      // (inbound conversation) — the missed-call post-it has served its
      // purpose, so take it off the desk automatically.
      if (call.direction === "outbound" || CONVERSATION_OUTCOMES.includes(outcome)) {
        const cleared = await clearMissedCallPostIts(db, {
          leadId: lead.id,
          phoneKey: key,
          callTs: startedAt,
        });
        if (cleared) {
          logger.info("Cleared missed-call post-its after returned call", {
            leadId: lead.id,
            cleared,
            callId: call.id,
          });
        }
      }

      // An attempt logged WITHOUT an ai map on a call that should produce one
      // (transcript missing past the deferral window, or the classifier call
      // failed past it) gets analysisPending stamped so the late-attach pass
      // keeps trying until the analysis lands — the marker doc alone must
      // never freeze a bare attempt again.
      const analysisPending =
        call.answered &&
        !analysis &&
        (transcriptReady ||
          Boolean(call.recording_duration) ||
          (call.duration ?? 0) >= TRANSCRIPT_EXPECTED_MIN_SEC);
      await marker.set({
        processedAt: Date.now(),
        leadId: lead.id,
        action: outcome,
        ...(analysisPending ? { analysisPending: true, startedAt } : {}),
      });
      logged++;
    }

    logger.info("CallRail sync complete", {
      pulled: calls.length,
      attemptsLogged: logged,
      missedCallPostIts: postIts,
      lateAnalysesAttached: late.attached,
      lateAnalysesGaveUp: late.gaveUp,
    });
    await stampHeartbeat("syncCallRail");
  },
);
