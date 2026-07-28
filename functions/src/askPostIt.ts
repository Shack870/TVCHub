import { onCall, HttpsError } from "firebase-functions/v2/https";
import { defineSecret } from "firebase-functions/params";
import { logger } from "firebase-functions/v2";
import { getFirestore } from "firebase-admin/firestore";

// "Ask Question" follow-up chat on post-it notes.
//
// System post-its (Square sync alerts, TVC-thread flags, cadence escalations,
// missed calls) summarize an automated finding in a few lines. When the
// summary isn't enough, this callable answers follow-up questions grounded in
// EVERYTHING that was behind the note: the post-it itself, the full linked
// lead (complete contact timeline with per-call AI analyses, court dates,
// money state, follow-ups), and any referenced Square payment/invoice marker
// docs — serialized into a context block for a plain OpenAI chat completion
// (same model/API pattern as the CallRail transcript analysis).
//
// Each Q&A turn is appended to a `qa` array on the message doc by the Admin
// SDK (no rules change needed for the write; the board's existing Firestore
// subscription streams the update straight into the open drawer). The client
// only ever READS messages — allowed by the existing rules.

const OPENAI_API_KEY = defineSecret("OPENAI_API_KEY");

// Turns of prior conversation replayed to the model (a turn = one qa entry).
const MAX_HISTORY_TURNS = 20;

export interface QaTurn {
  role: "user" | "assistant";
  text: string;
  ts: number;
}

// ---------- Serialization helpers (pure — unit tested) ----------

// Epoch ms -> human-readable Chicago time ("Jul 24, 2026, 3:05 PM").
export function fmtChicago(ms: unknown): string {
  if (typeof ms !== "number" || !Number.isFinite(ms) || ms <= 0) return "unknown";
  return new Date(ms).toLocaleString("en-US", {
    timeZone: "America/Chicago",
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

const money = (n: unknown): string =>
  typeof n === "number" && Number.isFinite(n) ? `$${n % 1 === 0 ? n : n.toFixed(2)}` : String(n ?? "");

// Loose views of the raw Firestore docs (consumed as-is, like pdfhandoff.ts).
type Dict = Record<string, unknown>;
const arr = (v: unknown): Dict[] => (Array.isArray(v) ? (v as Dict[]) : []);
const str = (v: unknown): string => (v == null ? "" : String(v));

function line(label: string, v: unknown): string | null {
  if (v === null || v === undefined || v === "") return null;
  return `${label}: ${String(v)}`;
}

function serializeAiAnalysis(ai: Dict, indent: string): string[] {
  const out: string[] = [];
  const push = (label: string, v: unknown) => {
    const l = line(label, v);
    if (l) out.push(`${indent}${l}`);
  };
  push("AI summary", ai.summary);
  push("connection", ai.connection);
  if (ai.pitched) push("pitched", `yes → ${str(ai.pitchResult)}`);
  push("sale status on this call", ai.saleStatus);
  if (ai.saleAmount) push("amount discussed", money(ai.saleAmount));
  push("payment plan", ai.paymentPlan === "unknown" ? null : ai.paymentPlan);
  push("payment promise", ai.paymentPromise);
  push("why no payment moved", ai.nonPaymentReason);
  if (ai.declineType && ai.declineType !== "none") {
    push("decline", `${str(ai.declineType)}${ai.declineReason ? ` — ${str(ai.declineReason)}` : ""}`);
  }
  const commitments = arr(ai.commitments).map(String).filter(Boolean);
  if (commitments.length) push("commitments", commitments.join("; "));
  push("agreed callback", ai.callbackAt);
  if (ai.upset) push("caller upset", "yes");
  if (ai.existingClientInquiry) push("sounded like an existing client", "yes");
  push("caller name heard", ai.callerName);
  return out;
}

export function serializeAttempt(a: Dict): string {
  const head =
    `- ${fmtChicago(a.ts)} — ${str(a.outcome) || "unknown outcome"}` +
    (a.via ? ` (via ${str(a.via)})` : "") +
    (a.by ? ` by ${str(a.by)}` : "");
  const lines = [head];
  if (a.notes) lines.push(`    notes: ${str(a.notes)}`);
  if (typeof a.durationSec === "number" && a.durationSec > 0) {
    lines.push(`    duration: ${Math.round(a.durationSec / 60)}m ${a.durationSec % 60}s`);
  }
  if (a.ai && typeof a.ai === "object") {
    lines.push(...serializeAiAnalysis(a.ai as Dict, "    "));
  }
  return lines.join("\n");
}

export function serializeLead(lead: Dict): string {
  const out: string[] = [];
  const push = (label: string, v: unknown) => {
    const l = line(label, v);
    if (l) out.push(l);
  };

  push("Name", lead.name);
  push("TVC case number", lead.tvcCaseNumber);
  push("Stage", lead.stage);
  push("Phone", lead.phone);
  push("Alt phone", lead.altPhone);
  push("Email", lead.email);
  push("Charge", lead.charge);
  push("County", lead.county);
  push("Court", lead.courtName);
  push("Owner", lead.owner);

  // Money state.
  push("Sale status", lead.saleStatus && lead.saleStatus !== "none" ? lead.saleStatus : null);
  if (lead.saleStatusAt) push("Sale status as of", fmtChicago(lead.saleStatusAt));
  if (lead.saleAmount) push("Quoted/collected fee", money(lead.saleAmount));
  if (typeof lead.squarePaidTotal === "number" && lead.squarePaidTotal > 0) {
    push("Collected via Square so far", money(lead.squarePaidTotal));
  }
  if (lead.saleNonPaymentReason) push("Why money hasn't moved", lead.saleNonPaymentReason);
  const inv = lead.squareInvoice as Dict | null | undefined;
  if (inv && typeof inv === "object") {
    push(
      "Latest Square invoice",
      `${inv.number ? `#${str(inv.number)}` : str(inv.id)} — ${money((inv.amountCents as number) / 100)}, ` +
        `status ${str(inv.status)}, sent ${fmtChicago(inv.sentAt)}`,
    );
  }

  // Court dates.
  if (lead.nextCourtDate) {
    push(
      "Next court date",
      `${str(lead.nextCourtDate)}${lead.nextCourtTime ? ` at ${str(lead.nextCourtTime)}` : ""}` +
        (lead.nextCourtType ? ` (${str(lead.nextCourtType)})` : ""),
    );
  }
  const history = arr(lead.courtDateHistory);
  if (history.length) {
    push(
      "Court date history",
      history
        .map(
          (c) =>
            `${str(c.date)}${c.time ? ` ${str(c.time)}` : ""}${c.type ? ` (${str(c.type)})` : ""}` +
            (c.reason ? ` — ${str(c.reason)}` : ""),
        )
        .join("; "),
    );
  }
  if (lead.caseDismissed) push("Case dismissed", "yes");

  // Flags a human should know about.
  if (lead.needsReview) push("Flagged needs-review", "yes (identity/data unverified)");
  if (lead.possibleExistingClientAt) {
    push(
      "Possible-existing-client flag",
      `raised ${fmtChicago(lead.possibleExistingClientAt)} (sales cadence paused)`,
    );
  }
  if (lead.lostReason) push("Lost reason", lead.lostReason);
  if (lead.lostAt) push("Lost at", fmtChicago(lead.lostAt));
  if (lead.cadenceExhaustedAt) push("Chase cadence gave up at", fmtChicago(lead.cadenceExhaustedAt));

  push("TVC notes", lead.tvcNotes);
  push("Referral received", fmtChicago(lead.receivedAt));

  // Complete contact timeline, oldest first.
  const attempts = arr(lead.contactAttempts);
  if (attempts.length) {
    out.push(`Contact attempts (${attempts.length}, oldest first):`);
    for (const a of attempts) out.push(serializeAttempt(a));
  } else {
    out.push("Contact attempts: none logged");
  }

  // Follow-ups with done state.
  const followUps = arr(lead.followUps);
  if (followUps.length) {
    out.push("Follow-ups:");
    for (const f of followUps) {
      out.push(
        `- [${f.done ? "done" : "PENDING"}] ${str(f.type)} due ${fmtChicago(f.dueAt)}` +
          (f.note ? ` — ${str(f.note)}` : "") +
          (f.done && f.doneAt ? ` (completed ${fmtChicago(f.doneAt)})` : ""),
      );
    }
  }

  return out.join("\n");
}

export function serializeMessage(msg: Dict): string {
  const out: string[] = [];
  const push = (label: string, v: unknown) => {
    const l = line(label, v);
    if (l) out.push(l);
  };
  push("Kind", msg.kind ?? "tvc_message");
  push("Raised by", msg.fromName || msg.from);
  push("From", msg.from !== msg.fromName ? msg.from : null);
  push("Raised at", fmtChicago(msg.receivedAt));
  push("Subject", msg.subject);
  push("Note text", msg.message);
  push("About member", msg.memberName);
  push("TVC case number", msg.tvcCaseNumber);
  push("Why no payment (classifier)", msg.nonPaymentReason);
  if (msg.noPursuit) push("No-pursuit alarm", "yes — money promised and NO call in either direction since");
  push(
    "Handled",
    msg.handled
      ? `yes${msg.handledAt ? ` at ${fmtChicago(msg.handledAt)}` : ""}${msg.handledBy ? ` by ${str(msg.handledBy)}` : ""}`
      : "no — still open",
  );
  return out.join("\n");
}

function serializeMarker(label: string, id: string, marker: Dict | null): string {
  if (!marker) return `${label} ${id}: marker doc not found`;
  const out = [`${label} ${id}:`];
  const push = (l: string, v: unknown) => {
    const ln = line(l, v);
    if (ln) out.push(`  ${ln}`);
  };
  if (typeof marker.amountCents === "number") push("amount", money(marker.amountCents / 100));
  push("status", marker.status);
  push("matched to lead", marker.leadId ? `${str(marker.leadId)} (by ${str(marker.matchedBy) || "?"})` : "no lead matched");
  push("action", marker.action);
  push("evidence", marker.evidence);
  push("invoice number", marker.invoiceNumber);
  push("recipient", marker.recipientName);
  push("recipient email", marker.recipientEmail);
  push("recipient phone", marker.recipientPhone);
  push("payer name", marker.payerName);
  push("payer email", marker.payerEmail);
  push("payer phone", marker.payerPhone);
  if (Array.isArray(marker.concurrentCandidates) && marker.concurrentCandidates.length) {
    push("leads on calls when charge was keyed", marker.concurrentCandidates.map(String).join(", "));
  }
  if (marker.sentAt) push("sent", fmtChicago(marker.sentAt));
  if (marker.invoiceUpdatedAt) push("last status change", fmtChicago(marker.invoiceUpdatedAt));
  if (marker.processedAt) push("last processed by sync", fmtChicago(marker.processedAt));
  return out.join("\n");
}

// The domain briefing that makes answers competent instead of generic.
export const ASK_SYSTEM = `You are the built-in assistant of TVCHub, a law-firm intake & sales CRM used by Iron Rock Law Firm to work TVC (Truckers Voice in Court) traffic-ticket referrals. A user is asking a follow-up question about one specific post-it note on their desk. Answer it from the CONTEXT block provided.

Domain you must know:
- Leads move through stages: new (untouched referral), callback (attempted, needs another try), pitched (pitch delivered, awaiting decision), attorney_call (asked to speak with an attorney), nurture (declined/thinking, being nurtured), financed (hired us on a payment plan, actively paying), intake_complete (paid/handed off to the next department), lost (dead/not interested — terminal).
- saleStatus values: none; paid_full (full fee collected); paid_partial (some money collected); promised_unpaid (said YES on a call but no payment was taken — money on the table, drives billing escalations).
- Post-it notes are generated by automated syncs: Square payment/invoice matching (payments reconciled to leads by phone/email/case-number/note-name/concurrent-call; unpaid retainer invoices chased after 3 days), CallRail transcript analysis (every call is transcribed and classified — summaries, sale reads, declines, upset callers, missed calls), TVC email-thread classification, the contact-cadence engine (chase/billing escalations, e.g. promised money never collected), and QA reconciliation. Human notes from TVC staff appear the same way.
- Post-it kinds: tvc_message = a note from TVC staff OR a system action item; missed_call = CallRail-detected missed inbound call (or upset caller); billing_escalation = the cadence engine flagging promised money never collected.
- Money conventions: the retainer is typically $1,125; the trial fee is $750; TVC members get a 25% discount; "covered" cases mean TVC pays the fee.
- Contact attempts on a lead may be hand-logged or auto-logged (via callrail / email / square). Each CallRail attempt can carry an AI transcript analysis with a summary and sale read.

Answering rules:
- Answer ONLY from the provided context. Be concise and concrete — cite specific dates, dollar amounts, and names from the context.
- If the context does not contain the answer, say so plainly and point the user to where to look instead (the Square dashboard for payment/invoice detail, CallRail for recordings/transcripts, the Gmail TVC threads for correspondence). Never guess or invent facts.
- Timestamps in the context are in Chicago time (the firm's timezone).`;

// Full context assembly: the post-it, the linked lead, referenced Square
// payment/invoice markers, and the referenced call's analysis.
export function buildContext(opts: {
  msg: Dict;
  lead: Dict | null;
  leadId: string | null;
  squarePayment?: { id: string; marker: Dict | null } | null;
  squareInvoice?: { id: string; marker: Dict | null } | null;
}): string {
  const parts: string[] = [];
  parts.push("=== THE POST-IT NOTE ===", serializeMessage(opts.msg));

  if (opts.lead) {
    parts.push(`\n=== THE LINKED LEAD (${opts.leadId}) ===`, serializeLead(opts.lead));
  } else {
    parts.push(
      "\n=== THE LINKED LEAD ===",
      "No lead in the app is linked to this post-it" +
        (opts.msg.tvcCaseNumber ? ` (no lead found for TVC case #${str(opts.msg.tvcCaseNumber)})` : "") +
        ".",
    );
  }

  if (opts.squarePayment) {
    parts.push(
      "\n=== REFERENCED SQUARE PAYMENT ===",
      serializeMarker("Square payment", opts.squarePayment.id, opts.squarePayment.marker),
    );
  }
  if (opts.squareInvoice) {
    parts.push(
      "\n=== REFERENCED SQUARE INVOICE ===",
      serializeMarker("Square invoice", opts.squareInvoice.id, opts.squareInvoice.marker),
    );
  }

  // The specific call behind the note (missed call / upset caller / existing-
  // client flag). Its full analysis already rides in the lead's contact
  // timeline; call it out separately so the model connects note → call.
  const callId = str(opts.msg.callrailCallId);
  if (callId && opts.lead) {
    const attempt = arr(opts.lead.contactAttempts).find((a) => str(a.callId) === callId);
    parts.push(
      "\n=== THE CALL BEHIND THIS NOTE ===",
      attempt
        ? serializeAttempt(attempt)
        : `CallRail call ${callId} — no logged attempt found on the lead (it may have been a missed call that was never answered, so there is no transcript).`,
    );
  }

  return parts.join("\n");
}

// Prior conversation replayed to the model, capped at the last N turns.
export function historyMessages(qa: unknown): { role: "user" | "assistant"; content: string }[] {
  const turns = arr(qa)
    .filter((t) => (t.role === "user" || t.role === "assistant") && t.text)
    .slice(-MAX_HISTORY_TURNS);
  return turns.map((t) => ({
    role: t.role as "user" | "assistant",
    content: str(t.text),
  }));
}

// ---------- Core (shared by the callable and the live-test script) ----------

export async function askPostItCore(
  messageId: string,
  question: string,
  apiKey: string,
): Promise<string> {
  const db = getFirestore();
  const msgRef = db.collection("messages").doc(messageId);
  const msgSnap = await msgRef.get();
  if (!msgSnap.exists) throw new HttpsError("not-found", "Post-it note not found.");
  const msg = msgSnap.data() as Dict;

  // Resolve the lead: leadId directly, else try the TVC case number.
  let leadId = str(msg.leadId) || null;
  let lead: Dict | null = null;
  if (leadId) {
    const snap = await db.collection("leads").doc(leadId).get();
    if (snap.exists) lead = snap.data() as Dict;
    else leadId = null;
  }
  if (!lead && msg.tvcCaseNumber) {
    const snap = await db
      .collection("leads")
      .where("tvcCaseNumber", "==", str(msg.tvcCaseNumber))
      .limit(2)
      .get();
    const docs = snap.docs.filter((d) => !d.data().deletedAt);
    if (docs.length >= 1) {
      leadId = docs[0].id;
      lead = docs[0].data() as Dict;
    }
  }

  // Referenced Square marker docs.
  const paymentId = str(msg.squarePaymentId);
  const invoiceId = str(msg.squareInvoiceId);
  const squarePayment = paymentId
    ? {
        id: paymentId,
        marker: await db
          .collection("squarePayments")
          .doc(paymentId)
          .get()
          .then((s) => (s.exists ? (s.data() as Dict) : null)),
      }
    : null;
  const squareInvoice = invoiceId
    ? {
        id: invoiceId,
        marker: await db
          .collection("squareInvoices")
          .doc(invoiceId)
          .get()
          .then((s) => (s.exists ? (s.data() as Dict) : null)),
      }
    : null;

  const context = buildContext({ msg, lead, leadId, squarePayment, squareInvoice });

  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      temperature: 0.2,
      max_tokens: 600,
      messages: [
        { role: "system", content: `${ASK_SYSTEM}\n\n=== CONTEXT ===\n${context}` },
        ...historyMessages(msg.qa),
        { role: "user", content: question },
      ],
    }),
  });
  const json = (await res.json()) as {
    choices?: { message?: { content?: string } }[];
    error?: { message?: string };
  };
  if (!res.ok) throw new Error(json.error?.message || `OpenAI ${res.status}`);
  const answer = str(json.choices?.[0]?.message?.content).trim();
  if (!answer) throw new Error("OpenAI returned an empty answer");

  // Append both turns to the message doc (Admin SDK — rules untouched). The
  // board's live subscription streams this straight into the open drawer.
  const now = Date.now();
  const prior = arr(msg.qa) as unknown as QaTurn[];
  await msgRef.update({
    qa: [
      ...prior,
      { role: "user", text: question, ts: now },
      { role: "assistant", text: answer, ts: now },
    ],
    updatedAt: now,
  });

  return answer;
}

// ---------- Callable ----------

export const askPostIt = onCall(
  { secrets: [OPENAI_API_KEY], timeoutSeconds: 120 },
  async (req) => {
    if (!req.auth) throw new HttpsError("unauthenticated", "Sign in required.");
    const messageId = String(req.data?.messageId ?? "").trim();
    const question = String(req.data?.question ?? "").trim();
    if (!messageId) throw new HttpsError("invalid-argument", "messageId is required.");
    if (!question) throw new HttpsError("invalid-argument", "question is required.");
    if (question.length > 2000) {
      throw new HttpsError("invalid-argument", "Question is too long (2000 chars max).");
    }
    try {
      const answer = await askPostItCore(messageId, question, OPENAI_API_KEY.value());
      return { ok: true, answer };
    } catch (e) {
      if (e instanceof HttpsError) throw e;
      logger.error("askPostIt failed", { messageId, error: String(e) });
      throw new HttpsError("internal", e instanceof Error ? e.message : "Ask failed");
    }
  },
);
