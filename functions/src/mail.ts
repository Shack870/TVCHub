import { onSchedule } from "firebase-functions/v2/scheduler";
import { onCall, HttpsError } from "firebase-functions/v2/https";
import { defineSecret } from "firebase-functions/params";
import { logger } from "firebase-functions/v2";
import { getFirestore } from "firebase-admin/firestore";
import { motionsDeadlineFor } from "./motionsDeadline.js";
import { stampHeartbeat } from "./heartbeat.js";
import {
  FIRM_CONTACT,
  LETTER_LABEL,
  letterBlockReason,
  letterEditableText,
  letterPreviewText,
  parseMailAddress,
  previewFromEditable,
  proposeLetter,
  renderLetterFromText,
  titleCaseName,
  type LetterType,
  type LetterVars,
} from "./mailEngine.js";

// The physical-mail program (PostGrid).
//
// mailSweep (daily, 6:30 AM Central — before the 7:00 cadence sweep):
//   1. Re-checks every open PROPOSED letter against live lead state and
//      blocks the ones whose moment has passed (retained, court date moved,
//      resolved) — the queue can never hold a letter that is no longer true.
//   2. Proposes new letters into the `letters` collection (status
//      'proposed') for the Mail Room review queue. NOTHING mails without a
//      human clicking Approve — the sweep only ever suggests.
//   3. Polls PostGrid for status changes on recently-sent letters; a
//      returned-to-sender letter flags the lead (mailReturnedAt) and stops
//      that lead's mail track until the address is fixed.
//
// decideLetter (callable): approve → re-check eligibility from LIVE lead
// state, render final HTML, create the PostGrid letter, log a `via: 'mail'`
// contact attempt on the lead's timeline; skip → mark skipped. Test-mode
// API keys create sandbox letters (nothing physically mails) — the letter
// doc carries testMode so the UI can badge it.

const POSTGRID_API_KEY = defineSecret("POSTGRID_API_KEY");
const PG_BASE = "https://api.postgrid.com/print-mail/v1";

// The sweep proposes at most this many new letters per run — a safety
// throttle so a bad day can never dump 80 letters into the queue at once.
const MAX_PROPOSALS_PER_SWEEP = 25;

type Dict = Record<string, unknown>;
const str = (v: unknown): string => (v == null ? "" : String(v));

function chicagoDayISO(ms: number): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Chicago",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(ms));
}

function humanDate(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) return iso;
  return new Date(+m[1], +m[2] - 1, +m[3]).toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
  });
}

const STATE_NAMES: Record<string, string> = { AR: "Arkansas", MO: "Missouri" };

// Merge variables for the templates, straight off the lead doc.
export function varsForLead(d: Dict, ddlDate: string | null): LetterVars {
  const courtDate =
    typeof d.nextCourtDate === "string" && /^\d{4}-\d{2}-\d{2}$/.test(d.nextCourtDate)
      ? humanDate(d.nextCourtDate)
      : null;
  const stateAbbr = str(d.state).toUpperCase();
  return {
    name: str(d.name) || "Driver",
    tvcNumber: str(d.tvcCaseNumber) || null,
    courtDate,
    courtTime: str(d.nextCourtTime) || null,
    courtName: str(d.courtName) || null,
    county: str(d.county) || null,
    stateName: STATE_NAMES[stateAbbr] ?? "Arkansas",
    deadlineDate: ddlDate ? humanDate(ddlDate) : null,
  };
}

// ---------- PostGrid client ----------

async function pgFetch(apiKey: string, path: string, init?: RequestInit): Promise<Dict> {
  const res = await fetch(`${PG_BASE}${path}`, {
    ...init,
    headers: { "x-api-key": apiKey, "Content-Type": "application/json", ...init?.headers },
  });
  const json = (await res.json().catch(() => ({}))) as Dict;
  if (!res.ok) {
    const msg = str((json.error as Dict | undefined)?.message ?? json.error ?? res.status);
    throw new Error(`PostGrid ${res.status}: ${msg}`);
  }
  return json;
}

// ---------- The daily sweep ----------

export const mailSweep = onSchedule(
  {
    schedule: "30 6 * * *",
    timeZone: "America/Chicago",
    timeoutSeconds: 300,
    secrets: [POSTGRID_API_KEY],
  },
  async () => {
    const db = getFirestore();
    const now = Date.now();
    const todayISO = chicagoDayISO(now);

    // Every live lead, once — proposals and re-checks share the snapshot.
    const leadSnap = await db.collection("leads").get();
    const leadById = new Map(leadSnap.docs.map((s) => [s.id, s.data() as Dict]));

    // The full letter ledger (small collection: dozens, not thousands).
    const letterSnap = await db.collection("letters").get();

    // --- 1. Re-check open proposals against live state -----------------------
    let staled = 0;
    for (const ls of letterSnap.docs) {
      const L = ls.data() as Dict;
      if (L.status !== "proposed") continue;
      const lead = leadById.get(str(L.leadId));
      const reason = !lead
        ? "lead no longer exists"
        : letterBlockReason(lead, L.type as LetterType, todayISO) ??
          // Court date moved after this letter was proposed → its facts are stale.
          (str(L.courtDateAtProposal) &&
          str(lead.nextCourtDate ?? "") !== str(L.courtDateAtProposal)
            ? `court date changed (${str(L.courtDateAtProposal)} → ${str(lead.nextCourtDate ?? "none")})`
            : null);
      if (reason) {
        await ls.ref.update({ status: "blocked", blockedReason: reason, updatedAt: now });
        staled++;
      }
    }

    // Per-lead letter history for the trigger logic.
    const historyByLead = new Map<
      string,
      { introSentAt: number | null; sentCount: number; lastSentAt: number | null; sentKeys: Set<string> }
    >();
    for (const ls of letterSnap.docs) {
      const L = ls.data() as Dict;
      const id = str(L.leadId);
      if (!historyByLead.has(id)) {
        historyByLead.set(id, { introSentAt: null, sentCount: 0, lastSentAt: null, sentKeys: new Set() });
      }
      const h = historyByLead.get(id)!;
      const status = str(L.status);
      // Any key ever raised (whatever became of it) is never raised again —
      // a human's Skip is a decision, not a snooze.
      if (status !== "blocked") h.sentKeys.add(str(L.dedupeKey));
      if (status === "sent" || status === "delivered" || status === "returned") {
        h.sentCount++;
        const at = (L.sentAt as number) ?? 0;
        if (at > (h.lastSentAt ?? 0)) h.lastSentAt = at;
        if (str(L.type) === "intro") h.introSentAt = at || now;
      }
    }

    // --- 2. Propose new letters ----------------------------------------------
    let proposed = 0;
    for (const [leadId, d] of leadById) {
      if (proposed >= MAX_PROPOSALS_PER_SWEEP) break;
      const history =
        historyByLead.get(leadId) ??
        { introSentAt: null, sentCount: 0, lastSentAt: null, sentKeys: new Set<string>() };

      const ddl = motionsDeadlineFor(
        {
          nextCourtDate: (d.nextCourtDate as string) ?? null,
          state: d.state as string | undefined,
        },
        todayISO,
      );
      const proposal = proposeLetter(d, ddl, history, todayISO, now);
      if (!proposal) continue;
      // The global suppression gate (retained / resolved / no address / mail
      // physics). Triggers say "this letter would help"; this says "allowed".
      if (letterBlockReason(d, proposal.type, todayISO)) continue;

      const fullKey = `${leadId}:${proposal.dedupeKey}`;
      const existing = await db
        .collection("letters")
        .where("fullKey", "==", fullKey)
        .limit(1)
        .get();
      if (!existing.empty) continue;

      const vars = varsForLead(d, ddl && !ddl.passed ? ddl.date : null);
      const addr = parseMailAddress(d.address)!;
      await db.collection("letters").add({
        leadId,
        leadName: str(d.name),
        type: proposal.type,
        label: LETTER_LABEL[proposal.type],
        status: "proposed",
        reason: proposal.reason,
        dedupeKey: proposal.dedupeKey,
        fullKey,
        to: addr,
        vars,
        bodyText: letterEditableText(proposal.type, vars),
        preview: letterPreviewText(proposal.type, vars),
        courtDateAtProposal: (d.nextCourtDate as string) ?? null,
        proposedAt: now,
        createdAt: now,
        updatedAt: now,
      });
      proposed++;
    }

    // --- 3. Poll PostGrid for status changes on recent sends -----------------
    let statusUpdates = 0;
    const apiKey = POSTGRID_API_KEY.value();
    if (apiKey && !apiKey.startsWith("placeholder")) {
      const cutoff = now - 45 * 86400_000;
      for (const ls of letterSnap.docs) {
        const L = ls.data() as Dict;
        if (L.status !== "sent" || !L.postgridId) continue;
        if (((L.sentAt as number) ?? 0) < cutoff) continue;
        try {
          const pg = await pgFetch(apiKey, `/letters/${str(L.postgridId)}`);
          const pgStatus = str(pg.status);
          if (pgStatus && pgStatus !== str(L.postgridStatus)) {
            const patch: Dict = { postgridStatus: pgStatus, updatedAt: now };
            if (pgStatus === "returned_to_sender") {
              patch.status = "returned";
              // Bad address: stop this lead's mail track and put the problem
              // on the desk where a human can fix the address.
              await db.collection("leads").doc(str(L.leadId)).update({
                mailReturnedAt: now,
                updatedAt: now,
              });
              await db.collection("messages").add({
                kind: "tvc_message",
                source: "system",
                from: "TVCHub Mail",
                fromName: "Mail Program",
                subject: `Letter returned — bad address: ${str(L.leadName)}`,
                message:
                  `The "${str(L.label)}" letter to ${str(L.leadName)} came back undeliverable. ` +
                  `Their mail track is stopped until the address is corrected on the lead.`,
                leadId: str(L.leadId),
                memberName: str(L.leadName),
                receivedAt: now,
                handled: false,
                createdAt: now,
                updatedAt: now,
              });
            } else if (pgStatus === "completed") {
              patch.status = "delivered";
            }
            await ls.ref.update(patch);
            statusUpdates++;
          }
        } catch (e) {
          logger.warn("mailSweep status poll failed", { letter: ls.id, error: String(e) });
        }
      }
    }

    logger.info("Mail sweep complete", { proposed, staledProposals: staled, statusUpdates });
    await stampHeartbeat("mailSweep");
  },
);

// ---------- Approve / skip ----------

export const decideLetter = onCall(
  { secrets: [POSTGRID_API_KEY], timeoutSeconds: 60 },
  async (req) => {
    if (!req.auth) throw new HttpsError("unauthenticated", "Sign in required.");
    const letterId = str(req.data?.letterId).trim();
    const action = str(req.data?.action).trim();
    if (!letterId) throw new HttpsError("invalid-argument", "letterId is required.");
    if (action !== "approve" && action !== "skip") {
      throw new HttpsError("invalid-argument", 'action must be "approve" or "skip".');
    }

    const db = getFirestore();
    const ref = db.collection("letters").doc(letterId);
    const snap = await ref.get();
    if (!snap.exists) throw new HttpsError("not-found", "Letter not found.");
    const L = snap.data() as Dict;
    if (L.status !== "proposed") {
      throw new HttpsError("failed-precondition", `Letter is already ${str(L.status)}.`);
    }
    const now = Date.now();
    const decidedBy = req.auth.token.email ?? req.auth.uid;

    if (action === "skip") {
      await ref.update({ status: "skipped", decidedAt: now, decidedBy, updatedAt: now });
      return { ok: true, status: "skipped" };
    }

    // APPROVE — the live-state re-check is the whole ballgame: whatever was
    // true at 6:30 AM may not be true now.
    const leadSnap = await db.collection("leads").doc(str(L.leadId)).get();
    if (!leadSnap.exists) throw new HttpsError("failed-precondition", "Lead no longer exists.");
    const lead = leadSnap.data() as Dict;
    const type = L.type as LetterType;
    const block =
      letterBlockReason(lead, type, chicagoDayISO(now)) ??
      (str(lead.nextCourtDate ?? "") !== str(L.courtDateAtProposal)
        ? `court date changed (${str(L.courtDateAtProposal)} → ${str(lead.nextCourtDate ?? "none")})`
        : null);
    if (block) {
      await ref.update({ status: "blocked", blockedReason: block, updatedAt: now });
      throw new HttpsError("failed-precondition", `Not mailed — ${block}.`);
    }

    const apiKey = POSTGRID_API_KEY.value();
    if (!apiKey || apiKey.startsWith("placeholder")) {
      throw new HttpsError(
        "failed-precondition",
        "PostGrid API key is not configured yet (Settings → secrets).",
      );
    }

    const addr = parseMailAddress(lead.address)!;
    const vars = L.vars as LetterVars;
    // The letter's editable text is what mails — reviewer edits included.
    // Letters proposed before the edit feature lack bodyText; regenerate.
    const bodyText = str(L.bodyText) || letterEditableText(type, vars);
    const html = renderLetterFromText(bodyText, type, vars, humanDate(chicagoDayISO(now)));
    let pg: Dict;
    try {
      pg = await pgFetch(apiKey, "/letters", {
        method: "POST",
        body: JSON.stringify({
          to: {
            firstName: titleCaseName(str(lead.name)),
            addressLine1: addr.line1,
            city: addr.city,
            provinceOrState: addr.provinceOrState,
            postalOrZip: addr.postalOrZip,
            country: "US",
          },
          from: FIRM_CONTACT,
          html,
          color: false,
          doubleSided: false,
          // The letterhead image owns the top of page one, so the recipient
          // address gets its own PostGrid-inserted address page (this is
          // what shows through the envelope window).
          addressPlacement: "insert_blank_page",
          description: `${LETTER_LABEL[type]} — ${str(lead.name)} [${str(L.leadId)}]`,
        }),
      });
    } catch (e) {
      logger.error("decideLetter PostGrid create failed", { letterId, error: String(e) });
      throw new HttpsError("internal", e instanceof Error ? e.message : "PostGrid send failed");
    }

    const testMode = apiKey.startsWith("test_") || Boolean((pg.live as boolean) === false);
    await ref.update({
      status: "sent",
      sentAt: now,
      decidedAt: now,
      decidedBy,
      postgridId: str(pg.id),
      postgridStatus: str(pg.status) || "ready",
      previewUrl: str(pg.url) || null,
      testMode,
      updatedAt: now,
    });

    // The timeline entry — mail touches sit beside calls, emails, and Square
    // credits. outcome no_answer: a letter never fakes a conversation.
    const attempts = Array.isArray(lead.contactAttempts) ? (lead.contactAttempts as Dict[]) : [];
    await leadSnap.ref.update({
      contactAttempts: [
        ...attempts,
        {
          ts: now,
          outcome: "no_answer",
          via: "mail",
          by: "Mail program",
          letterId,
          notes: `Letter mailed: ${LETTER_LABEL[type]}${testMode ? " (TEST MODE — not physically sent)" : ""}`,
        },
      ],
      updatedAt: now,
    });

    logger.info("Letter mailed", { letterId, leadId: str(L.leadId), type, testMode });
    return { ok: true, status: "sent", testMode, previewUrl: str(pg.url) || null };
  },
);

// ---------- Preview / edit ----------

const MAX_BODY_TEXT = 20_000;

// Renders a letter's final HTML for the Mail Room's preview modal — the
// exact same renderer approval uses, so the preview IS the letter. An
// optional bodyText lets the UI preview unsaved edits.
export const previewLetter = onCall({ timeoutSeconds: 30 }, async (req) => {
  if (!req.auth) throw new HttpsError("unauthenticated", "Sign in required.");
  const letterId = str(req.data?.letterId).trim();
  if (!letterId) throw new HttpsError("invalid-argument", "letterId is required.");
  const override = req.data?.bodyText != null ? str(req.data.bodyText) : null;
  if (override && override.length > MAX_BODY_TEXT) {
    throw new HttpsError("invalid-argument", "Letter text is too long.");
  }

  const snap = await getFirestore().collection("letters").doc(letterId).get();
  if (!snap.exists) throw new HttpsError("not-found", "Letter not found.");
  const L = snap.data() as Dict;
  const type = L.type as LetterType;
  const vars = L.vars as LetterVars;
  const bodyText = override ?? (str(L.bodyText) || letterEditableText(type, vars));
  const html = renderLetterFromText(bodyText, type, vars, humanDate(chicagoDayISO(Date.now())));
  return { ok: true, html, bodyText };
});

// Clears the Mail Room's Skipped / Blocked history by deleting those letter
// docs. Note the semantics: a deleted skip is a forgotten decision — the
// sweep may legitimately re-propose that letter type for the lead later
// (back into the review queue; nothing mails without approval).
export const clearLetterHistory = onCall({ timeoutSeconds: 60 }, async (req) => {
  if (!req.auth) throw new HttpsError("unauthenticated", "Sign in required.");
  const db = getFirestore();
  const snap = await db
    .collection("letters")
    .where("status", "in", ["skipped", "blocked"])
    .get();
  let deleted = 0;
  // Firestore batches cap at 500 writes; the history list is far smaller,
  // but chunk anyway so a big backlog can't fail the call.
  const docs = snap.docs;
  for (let i = 0; i < docs.length; i += 400) {
    const batch = db.batch();
    for (const d of docs.slice(i, i + 400)) {
      batch.delete(d.ref);
      deleted++;
    }
    await batch.commit();
  }
  logger.info("Letter history cleared", { deleted, by: req.auth.token.email ?? req.auth.uid });
  return { ok: true, deleted };
});

// Saves reviewer edits to a proposed letter's text. Approval renders from
// this text, so a saved edit is exactly what mails.
export const saveLetterText = onCall({ timeoutSeconds: 30 }, async (req) => {
  if (!req.auth) throw new HttpsError("unauthenticated", "Sign in required.");
  const letterId = str(req.data?.letterId).trim();
  const bodyText = str(req.data?.bodyText).trim();
  if (!letterId) throw new HttpsError("invalid-argument", "letterId is required.");
  if (!bodyText) throw new HttpsError("invalid-argument", "The letter text cannot be empty.");
  if (bodyText.length > MAX_BODY_TEXT) {
    throw new HttpsError("invalid-argument", "Letter text is too long.");
  }

  const ref = getFirestore().collection("letters").doc(letterId);
  const snap = await ref.get();
  if (!snap.exists) throw new HttpsError("not-found", "Letter not found.");
  const L = snap.data() as Dict;
  if (L.status !== "proposed") {
    throw new HttpsError("failed-precondition", `Letter is already ${str(L.status)} — text is locked.`);
  }

  const now = Date.now();
  await ref.update({
    bodyText,
    preview: previewFromEditable(bodyText, L.type as LetterType, L.vars as LetterVars),
    editedBy: req.auth.token.email ?? req.auth.uid,
    editedAt: now,
    updatedAt: now,
  });
  return { ok: true };
});
