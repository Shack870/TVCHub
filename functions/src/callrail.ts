import { onSchedule } from "firebase-functions/v2/scheduler";
import { defineSecret } from "firebase-functions/params";
import { logger } from "firebase-functions/v2";
import { getFirestore } from "firebase-admin/firestore";
import { randomUUID } from "node:crypto";

// CallRail → TVCHub phone-activity sync.
//
// Every few minutes this pulls recent calls from the CallRail API and, for any
// call whose customer number matches a lead's phone:
//   - outbound or answered-inbound  -> appends an auto-logged contact attempt
//   - missed/voicemail inbound      -> drops a "missed call" post-it on the desk
//
// SAFETY: the sync NEVER changes a lead's sales stage — stage moves (pitched,
// retained, lost, ...) stay human decisions. It only records that phone
// activity happened, which clears the "uncontacted"/overdue indicators exactly
// as a manually logged attempt would.

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
interface CallAnalysis {
  connection: "conversation" | "brief" | "voicemail" | "wrong_number" | "unclear";
  pitched: boolean;
  pitchResult: "bought" | "declined" | "thinking" | "not_pitched";
  summary: string;
  commitments: string[];
  callbackAt: string | null; // ISO date if a specific callback was agreed
  upset: boolean;
}

const ANALYSIS_SYSTEM = `You analyze a phone call transcript between a law firm (Agent) and a traffic-case lead (Caller). The firm's funnel is: reach the lead ("connect"), pitch representation, then the lead buys, declines, or thinks about it.
Return ONLY a JSON object:
- "connection": "conversation" (a real two-way exchange), "brief" (answered but no real exchange, e.g. hung up in seconds), "voicemail" (reached voicemail/answering service), "wrong_number", or "unclear".
- "pitched": true if representation/fees/retainer were discussed as an offer.
- "pitchResult": "bought" (agreed to retain/sign), "declined", "thinking", or "not_pitched".
- "summary": 1-2 tight sentences a colleague can act on. Facts only.
- "commitments": array of concrete promises made by either side ("Member emailing signed retainer today", "Agent to confirm fee with Jody"). [] if none.
- "callbackAt": ISO date (yyyy-mm-dd) ONLY if a specific callback day was agreed, else null.
- "upset": true if the caller is angry/frustrated with the firm.
Do not invent facts. If the transcript is empty or useless, use connection "unclear", empty summary.`;

async function analyzeTranscript(
  transcript: string,
  direction: string,
  startTime: string,
  apiKey: string,
): Promise<CallAnalysis | null> {
  try {
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
            content: `Call direction: ${direction}. Call date: ${startTime}.\n\nTranscript:\n${transcript.slice(0, 24000)}`,
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
    return {
      connection: parsed.connection ?? "unclear",
      pitched: Boolean(parsed.pitched),
      pitchResult: parsed.pitchResult ?? "not_pitched",
      summary: String(parsed.summary ?? ""),
      commitments: Array.isArray(parsed.commitments) ? parsed.commitments.map(String) : [],
      callbackAt: parsed.callbackAt || null,
      upset: Boolean(parsed.upset),
    };
  } catch (e) {
    logger.warn("Transcript analysis failed; falling back to basic logging", e);
    return null;
  }
}

const last10 = (s: unknown): string =>
  String(s ?? "").replace(/\D/g, "").slice(-10);

function fmtDuration(sec: number | null): string {
  if (!sec) return "";
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return m ? `${m}m ${s}s` : `${s}s`;
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
  opts: { dueAt: number; note: string; withinMs: number; type?: string },
): Promise<boolean> {
  let added = false;
  await db.runTransaction(async (tx) => {
    const ref = db.collection("leads").doc(leadId);
    const snap = await tx.get(ref);
    if (!snap.exists) return;
    const d = snap.data()!;
    // Don't chase decided leads.
    if (["retained", "intake_complete", "lost"].includes(d.stage) || d.deletedAt) return;
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

// A returned call closes the loop: archive any open "Missed call" post-its
// for this lead from before the call. "Upset caller" notes are left for a
// human even though they share the missed_call kind.
async function clearMissedCallPostIts(
  db: ReturnType<typeof getFirestore>,
  leadId: string,
  beforeTs: number,
): Promise<number> {
  const snap = await db
    .collection("messages")
    .where("leadId", "==", leadId)
    .where("kind", "==", "missed_call")
    .get();
  const now = Date.now();
  let cleared = 0;
  for (const doc of snap.docs) {
    const m = doc.data();
    if (m.deletedAt) continue;
    if (!String(m.subject || "").startsWith("Missed call")) continue;
    if ((m.receivedAt ?? 0) > beforeTs) continue; // they missed us again AFTER this call
    await doc.ref.update({ handled: true, deletedAt: now, updatedAt: now });
    cleared++;
  }
  return cleared;
}

export const syncCallRail = onSchedule(
  {
    schedule: "every 5 minutes",
    secrets: [CALLRAIL_API_KEY, OPENAI_API_KEY_CR],
    timeoutSeconds: 300,
  },
  async () => {
    const db = getFirestore();
    const calls = await fetchRecentCalls(CALLRAIL_API_KEY.value());
    if (!calls.length) return;

    // Phone -> lead index over recent leads (covers the active board plus
    // months of history; older completed cases don't get phone activity).
    const leadSnap = await db
      .collection("leads")
      .orderBy("createdAt", "desc")
      .limit(1000)
      .select("name", "phone", "altPhone", "deletedAt")
      .get();
    const byPhone = new Map<string, { id: string; name: string }>();
    for (const doc of leadSnap.docs) {
      const d = doc.data();
      if (d.deletedAt) continue;
      for (const p of [d.phone, d.altPhone]) {
        const key = last10(p);
        // First (newest) lead wins a shared number.
        if (key.length === 10 && !byPhone.has(key)) {
          byPhone.set(key, { id: doc.id, name: d.name });
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
        await marker.set({ processedAt: Date.now(), leadId: null, action: "ignored" });
        continue;
      }

      const missedInbound =
        call.direction === "inbound" && (!call.answered || call.voicemail);

      // CallRail transcribes recordings asynchronously — often minutes after
      // the call ends. If an answered+recorded call has no transcript yet and
      // is still fresh, skip it WITHOUT a marker so a later run picks it up
      // with the transcript (and therefore an AI summary) attached.
      const transcriptPending =
        !missedInbound &&
        call.answered &&
        Boolean(call.recording_duration) &&
        (!call.transcription || call.transcription.length <= 40) &&
        Date.now() - startedAt < 3 * 3600_000;
      if (transcriptPending) continue;

      if (missedInbound) {
        // Surface the callback on the desk instead of burying it in a log —
        // a lead calling back and missing us is exactly a "don't drop this".
        await db.collection("messages").add({
          kind: "missed_call",
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
      const analysis =
        call.answered && call.transcription && call.transcription.length > 40
          ? await analyzeTranscript(
              call.transcription,
              call.direction,
              call.start_time,
              OPENAI_API_KEY_CR.value(),
            )
          : null;

      // Outcome: prefer the transcript's read of the call over the raw
      // answered/voicemail flags. Stage is intentionally untouched either way.
      let outcome: string;
      if (analysis && analysis.connection !== "unclear") {
        outcome =
          analysis.connection === "conversation"
            ? "spoke"
            : analysis.connection === "voicemail"
              ? "voicemail"
              : "no_answer"; // brief hang-up / wrong number = not a connection
      } else {
        outcome = call.voicemail ? "voicemail" : call.answered ? "spoke" : "no_answer";
      }

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
      await db.runTransaction(async (tx) => {
        const ref = db.collection("leads").doc(lead.id);
        const snap = await tx.get(ref);
        if (!snap.exists) return;
        const d = snap.data()!;
        const attempts = Array.isArray(d.contactAttempts) ? d.contactAttempts : [];
        const patch: Record<string, unknown> = {
          contactAttempts: [...attempts, attempt],
          updatedAt: Date.now(),
        };
        // A real conversation stamps the lead as connected — the cadence sweep
        // uses this to stop the daily chase.
        if (outcome === "spoke") patch.lastConnectedAt = startedAt;
        tx.update(ref, patch);
      });

      // We called them back (any outbound attempt), or they got through to us
      // (inbound conversation) — the missed-call post-it has served its
      // purpose, so take it off the desk automatically.
      if (call.direction === "outbound" || outcome === "spoke") {
        const cleared = await clearMissedCallPostIts(db, lead.id, startedAt);
        if (cleared) {
          logger.info("Cleared missed-call post-its after returned call", {
            leadId: lead.id,
            cleared,
            callId: call.id,
          });
        }
      }

      // A specific callback day agreed on the call becomes a real follow-up so
      // it lands on the calendar and the Today queue.
      if (analysis?.callbackAt && /^\d{4}-\d{2}-\d{2}$/.test(analysis.callbackAt)) {
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
      if (analysis?.upset) {
        await db.collection("messages").add({
          kind: "missed_call",
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
          gmailMessageId: null,
          callrailCallId: call.id,
          receivedAt: startedAt,
          handled: false,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        });
        postIts++;
      }

      await marker.set({ processedAt: Date.now(), leadId: lead.id, action: outcome });
      logged++;
    }

    logger.info("CallRail sync complete", {
      pulled: calls.length,
      attemptsLogged: logged,
      missedCallPostIts: postIts,
    });
  },
);
