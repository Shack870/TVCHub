import { onSchedule } from "firebase-functions/v2/scheduler";
import { defineSecret } from "firebase-functions/params";
import { logger } from "firebase-functions/v2";
import { getFirestore } from "firebase-admin/firestore";

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
    "id,direction,answered,voicemail,duration,customer_phone_number,customer_name,start_time,recording_player,recording_duration";
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

export const syncCallRail = onSchedule(
  { schedule: "every 5 minutes", secrets: [CALLRAIL_API_KEY], timeoutSeconds: 120 },
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
        await marker.set({ processedAt: Date.now(), leadId: lead.id, action: "missed_call" });
        postIts++;
        continue;
      }

      // Answered call (either direction) or unanswered outbound dial: append a
      // contact attempt transactionally so it can't clobber a human logging at
      // the same moment. Stage is intentionally untouched.
      const outcome = call.voicemail
        ? "voicemail"
        : call.answered
          ? "spoke"
          : "no_answer";
      const dir = call.direction === "inbound" ? "Inbound" : "Outbound";
      const dur = fmtDuration(call.duration);
      const attempt = {
        ts: startedAt,
        outcome,
        notes:
          `${dir} call via CallRail${dur ? ` — ${dur}` : ""}.` +
          (call.recording_player ? ` Recording: ${call.recording_player}` : ""),
        by: "CallRail sync",
        via: "callrail",
        callId: call.id,
        recordingUrl: call.recording_player || null,
        durationSec: call.duration ?? null,
      };
      await db.runTransaction(async (tx) => {
        const ref = db.collection("leads").doc(lead.id);
        const snap = await tx.get(ref);
        if (!snap.exists) return;
        const attempts = Array.isArray(snap.data()?.contactAttempts)
          ? snap.data()!.contactAttempts
          : [];
        tx.update(ref, {
          contactAttempts: [...attempts, attempt],
          updatedAt: Date.now(),
        });
      });
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
