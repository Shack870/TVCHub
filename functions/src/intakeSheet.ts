import { onCall, HttpsError } from "firebase-functions/v2/https";
import { defineSecret } from "firebase-functions/params";
import { logger } from "firebase-functions/v2";
import { getFirestore } from "firebase-admin/firestore";
import { serializeLead } from "./askPostIt.js";

// "Intake Support Sheet" — the calendar day card's personal sales assistant.
//
// The user clicks a day; the client sends that day's docket (lead ids plus
// what's happening for each: court appearance, motions deadline, follow-up
// due). This callable pulls each lead's FULL file (same serialization the
// Ask-a-question agent uses: complete contact timeline with per-call AI
// analyses, money state, court dates) and asks OpenAI to write a
// "let's make some money" coaching sheet: who to call first, why today is
// the day, the angle that fits THEIR file, an opener to say out loud, and a
// voicemail fallback. The client renders the returned JSON into a PDF that
// auto-downloads — nothing is stored server-side.

const OPENAI_API_KEY = defineSecret("OPENAI_API_KEY");

const MAX_LEADS = 30;

type Dict = Record<string, unknown>;
const str = (v: unknown): string => (v == null ? "" : String(v));

export interface SheetItem {
  name: string;
  phone: string;
  event: string;
  why_today: string;
  angle: string;
  opener: string;
  if_voicemail: string;
  watch_out?: string;
}

export interface IntakeSheet {
  headline: string;
  pep_talk: string;
  items: SheetItem[];
  closer: string;
}

// The coaching brief. The model sees each lead's full file and today's event
// and must produce working sales material, not summaries.
const SHEET_SYSTEM = `You are the personal sales assistant for the intake desk at Iron Rock Law Firm, a traffic-ticket defense firm working TVC (Truckers Voice in Court) referrals. Nearly every lead is an out-of-state CDL truck driver who does NOT want to travel back for court. Today's docket (below) lists leads with something happening TODAY: a court appearance, a motions-filing deadline (last day to file a Motion to Continue so the client doesn't have to travel), or a scheduled follow-up call.

Your job: write the intake person's "let's make some money" sheet for the day — a coach's game plan, not a report. For every lead, study their FULL file (call summaries, what they said, money state, court dates) and produce:
- why_today: one punchy sentence — why TODAY specifically is the day this lead can close (deadline pressure, court proximity, a promise they made, silence that needs breaking).
- angle: the specific sales angle that fits THEIR file — reference what they actually said on calls, their charge, their fee situation. The continuance pitch ("hire us and you don't travel") is the workhorse; warrant risk after a missed date is the hammer; a promise to pay is a collection, not a pitch.
- opener: the first 1-2 sentences to SAY OUT LOUD when they pick up. Natural, warm, specific to them — never "I'm calling to follow up."
- if_voicemail: one sentence to leave that earns a callback (tease the deadline/stakes, don't pitch the whole case).
- watch_out: OPTIONAL — only when the file shows a trap (they were upset, a payment dispute, a language barrier, wrong-number history, an existing-client flag).

Money facts you may use: retainer is typically $1,125 (TVC members get 25% off — that IS the discounted figure they're quoted); trial fee $750; half-down payment plans are common ($562/$563 halves).

Rules:
- Order items by likelihood of money TODAY: promised-unpaid collections first, then hot deadlines (court/motions today), then warm follow-ups, then cold chases.
- Ground EVERYTHING in the files provided. Never invent facts, amounts, or quotes. If a file is thin, say so in the angle and go with the universal continuance pitch.
- Voice: upbeat, confident, a little playful — a great sales manager before the morning shift. Short sentences. No corporate filler.
- pep_talk: 2-3 sentences reading the day as a whole (how much potential money is on this sheet, where the easy wins are).
- closer: one sentence to end the day on (what done looks like).
- Respond with ONLY a JSON object: {"headline": string, "pep_talk": string, "items": [{"name","phone","event","why_today","angle","opener","if_voicemail","watch_out"?}], "closer": string}. Include every lead from the docket exactly once.`;

export const intakeSheet = onCall(
  { secrets: [OPENAI_API_KEY], timeoutSeconds: 180 },
  async (req) => {
    if (!req.auth) throw new HttpsError("unauthenticated", "Sign in required.");
    const date = String(req.data?.date ?? "").trim();
    const docket = Array.isArray(req.data?.docket) ? (req.data.docket as Dict[]) : [];
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      throw new HttpsError("invalid-argument", "date must be yyyy-MM-dd.");
    }
    if (!docket.length) throw new HttpsError("invalid-argument", "docket is empty.");

    // leadId -> today's events on the day card (court / motions ddl / follow-ups).
    const events = new Map<string, string[]>();
    for (const d of docket.slice(0, MAX_LEADS * 3)) {
      const id = str(d.leadId);
      const ev = str(d.event);
      if (!id || !ev) continue;
      events.set(id, [...(events.get(id) ?? []), ev]);
    }
    const leadIds = [...events.keys()].slice(0, MAX_LEADS);
    if (!leadIds.length) throw new HttpsError("invalid-argument", "docket has no lead ids.");

    const db = getFirestore();
    const snaps = await db.getAll(...leadIds.map((id) => db.collection("leads").doc(id)));
    const parts: string[] = [];
    for (const s of snaps) {
      if (!s.exists) continue;
      const lead = s.data() as Dict;
      if (lead.deletedAt) continue;
      parts.push(
        `=== DOCKET LEAD ${s.id} ===`,
        `TODAY'S EVENT(S): ${(events.get(s.id) ?? []).join("; ")}`,
        serializeLead(lead),
        "",
      );
    }
    if (!parts.length) throw new HttpsError("not-found", "No leads found for this docket.");

    const human = new Date(`${date}T12:00:00-05:00`).toLocaleDateString("en-US", {
      weekday: "long",
      month: "long",
      day: "numeric",
      year: "numeric",
    });

    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${OPENAI_API_KEY.value()}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        temperature: 0.5,
        max_tokens: 4000,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: SHEET_SYSTEM },
          {
            role: "user",
            content: `Today is ${human}. Build the sheet for this docket.\n\n${parts.join("\n")}`,
          },
        ],
      }),
    });
    const json = (await res.json()) as {
      choices?: { message?: { content?: string } }[];
      error?: { message?: string };
    };
    if (!res.ok) {
      logger.error("intakeSheet OpenAI error", { error: json.error?.message, status: res.status });
      throw new HttpsError("internal", json.error?.message || `OpenAI ${res.status}`);
    }
    let sheet: IntakeSheet;
    try {
      sheet = JSON.parse(str(json.choices?.[0]?.message?.content)) as IntakeSheet;
    } catch {
      throw new HttpsError("internal", "Assistant returned malformed sheet JSON.");
    }
    if (!Array.isArray(sheet.items) || !sheet.items.length) {
      throw new HttpsError("internal", "Assistant returned an empty sheet.");
    }
    logger.info("intakeSheet built", { date, leads: leadIds.length, items: sheet.items.length });
    return { ok: true, sheet };
  },
);
