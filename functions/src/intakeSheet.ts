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
  lead_id: string;
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

// Leads per OpenAI call. One giant prompt made gpt-4o-mini silently drop
// leads (15 in, 9 out in live testing) — small chunks + exact lead_id
// coverage checks make every docket lead land on the sheet.
const CHUNK_SIZE = 8;

// Deterministic order of the final sheet: likeliest money first. The model
// orders within a chunk, but the day-wide order is ours to guarantee.
export function eventPriority(event: string): number {
  const e = event.toLowerCase();
  if (/collect|billing|promised/.test(e)) return 0;
  if (/court appearance/.test(e)) return 1;
  if (/motions/.test(e)) return 2;
  if (/day[ _-]before/.test(e)) return 3;
  if (/week[ _-]before/.test(e)) return 4;
  if (/chase/.test(e)) return 5;
  return 6;
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
- Ground EVERYTHING in the files provided. Never invent facts, amounts, quotes, promises, or prior conversations. Before you write "they said/agreed/promised X", it must literally appear in that lead's file.
- If a lead's file shows NO conversation ever (only no-answers/voicemails/emails, or no attempts at all), you MUST treat them as never spoken to: why_today is about reaching them for the FIRST time before their deadline, the angle is the universal continuance pitch, and the opener introduces the firm. Do not imply any prior discussion.
- Voice: upbeat, confident, a little playful — a great sales manager before the morning shift. Short sentences. No corporate filler.
- Respond with ONLY a JSON object: {"items": [{"lead_id","name","phone","event","why_today","angle","opener","if_voicemail","watch_out"?}]}. lead_id is the id from the "=== DOCKET LEAD <id> ===" header, copied EXACTLY. Include every docket lead exactly once — no lead may be skipped.`;

// Second, tiny call: read the finished item list and write the day's
// framing. Cheap, and it sees the WHOLE day (the item calls are chunked).
const SUMMARY_SYSTEM = `You write the framing for an intake desk's daily "let's make some money" call sheet at a traffic-ticket defense firm. You get the day's finished call list (name, event, why today matters). Respond with ONLY a JSON object: {"headline": string, "pep_talk": string, "closer": string}.
- headline: short and punchy, money-flavored, mentions the day.
- pep_talk: 2-3 sentences reading the day as a whole — where the easy wins are, what to hit first. Upbeat sales-manager voice, no corporate filler.
- closer: one sentence to end the day on (what done looks like).
- Use only the facts in the list. Never invent names or amounts.`;

// One JSON-mode chat completion.
async function completeJson(apiKey: string, system: string, user: string, maxTokens: number): Promise<Dict> {
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      temperature: 0.3,
      max_tokens: maxTokens,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
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
  try {
    return JSON.parse(str(json.choices?.[0]?.message?.content)) as Dict;
  } catch {
    throw new HttpsError("internal", "Assistant returned malformed JSON.");
  }
}

// Ask for items covering the given serialized lead blocks; keep only items
// whose lead_id is real and expected.
async function itemsForChunk(
  apiKey: string,
  human: string,
  blocks: { id: string; text: string }[],
): Promise<SheetItem[]> {
  const body =
    `Today is ${human}. Write the call-sheet items for these ${blocks.length} docket lead(s).\n\n` +
    blocks.map((b) => b.text).join("\n");
  const out = await completeJson(apiKey, SHEET_SYSTEM, body, 3500);
  const wanted = new Set(blocks.map((b) => b.id));
  return (Array.isArray(out.items) ? (out.items as SheetItem[]) : []).filter(
    (it) => it && wanted.has(str(it.lead_id)),
  );
}

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
    const blocks: { id: string; text: string }[] = [];
    for (const s of snaps) {
      if (!s.exists) continue;
      const lead = s.data() as Dict;
      if (lead.deletedAt) continue;
      blocks.push({
        id: s.id,
        text: [
          `=== DOCKET LEAD ${s.id} ===`,
          `TODAY'S EVENT(S): ${(events.get(s.id) ?? []).join("; ")}`,
          serializeLead(lead),
          "",
        ].join("\n"),
      });
    }
    if (!blocks.length) throw new HttpsError("not-found", "No leads found for this docket.");

    const human = new Date(`${date}T12:00:00-05:00`).toLocaleDateString("en-US", {
      weekday: "long",
      month: "long",
      day: "numeric",
      year: "numeric",
    });
    const apiKey = OPENAI_API_KEY.value();

    // Items, chunked and in parallel — every chunk small enough that the
    // model can't lose leads in the middle.
    const chunks: { id: string; text: string }[][] = [];
    for (let i = 0; i < blocks.length; i += CHUNK_SIZE) chunks.push(blocks.slice(i, i + CHUNK_SIZE));
    const chunkResults = await Promise.all(chunks.map((c) => itemsForChunk(apiKey, human, c)));
    const byLead = new Map<string, SheetItem>();
    for (const it of chunkResults.flat()) {
      if (!byLead.has(str(it.lead_id))) byLead.set(str(it.lead_id), it);
    }

    // Coverage check: anyone the model still skipped gets one repair call.
    const missing = blocks.filter((b) => !byLead.has(b.id));
    if (missing.length) {
      logger.warn("intakeSheet repair pass", { date, missing: missing.map((m) => m.id) });
      for (const it of await itemsForChunk(apiKey, human, missing)) {
        if (!byLead.has(str(it.lead_id))) byLead.set(str(it.lead_id), it);
      }
    }
    const stillMissing = blocks.filter((b) => !byLead.has(b.id)).map((b) => b.id);
    if (stillMissing.length) {
      logger.error("intakeSheet leads dropped after repair", { date, stillMissing });
    }

    // Day-wide order is deterministic: collections, court, motions, then the
    // rest. Within a bucket, docket order (client sends courts first).
    const items = blocks
      .map((b) => byLead.get(b.id))
      .filter((it): it is SheetItem => !!it)
      .sort(
        (a, b) =>
          eventPriority((events.get(a.lead_id) ?? []).join("; ")) -
          eventPriority((events.get(b.lead_id) ?? []).join("; ")),
      );
    if (!items.length) throw new HttpsError("internal", "Assistant returned an empty sheet.");

    // Day framing from a summary of the finished list.
    const digest = items
      .map((it, i) => `${i + 1}. ${it.name} — ${it.event} — ${it.why_today}`)
      .join("\n");
    const framing = await completeJson(
      apiKey,
      SUMMARY_SYSTEM,
      `Today is ${human}. The finished call list:\n${digest}`,
      400,
    );

    const sheet: IntakeSheet = {
      headline: str(framing.headline) || `Let's make some money — ${human}`,
      pep_talk: str(framing.pep_talk),
      items,
      closer: str(framing.closer),
    };
    logger.info("intakeSheet built", {
      date,
      leads: blocks.length,
      items: items.length,
      chunks: chunks.length,
      repaired: missing.length,
      dropped: stillMissing.length,
    });
    return { ok: true, sheet };
  },
);
