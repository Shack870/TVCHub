import { onSchedule } from "firebase-functions/v2/scheduler";
import { defineSecret } from "firebase-functions/params";
import { logger } from "firebase-functions/v2";
import { getFirestore } from "firebase-admin/firestore";
import { stampHeartbeat } from "./heartbeat.js";
import { delegatedGmailToken } from "./gmailAuth.js";
import {
  buildNameIndex,
  classifyReply,
  extractBareCaseNumbers,
  extractCaseNumbers,
  findNamedLeads,
  payloadText,
  planLeadWrites,
  stripQuotedHistory,
  excerptOf,
  type GmailPayloadPart,
  type NameIndexEntry,
} from "./tvcThreadRules.js";

// TVC thread → TVCHub disposition sync.
//
// The firm's dispositions and negotiations happen in email threads WITH TVC
// (prodriver.com), not with the client — the app was blind to them until the
// July 2026 audit found 8+ misfiled leads (retained clients chased, declined
// leads sitting live, a covered-case fee negotiation invisible). Every 15
// minutes this reads office@ironrocklaw.com's correspondence to prodriver.com
// (the office's replies FROM ironrocklaw@gmail.com to TVC also land in this
// mailbox — one mailbox covers both senders) and, for each OFFICE REPLY:
//   - extracts the TVC case number(s) from subject + body (all known formats,
//     including the dashed one a manual audit's regex missed),
//   - matches the lead by tvcCaseNumber (whole collection, deleted skipped;
//     a duplicate non-deleted pair refuses to match — human post-it),
//   - classifies the fresh reply text with PHRASE-ANCHORED rules (100%
//     precise on 733 audited replies — see tvcThreadRules.ts), and
//   - acts per the plan in tvcThreadRules.planLeadWrites:
//       DECLINED   -> route to No Sale (mirrors noSaleRouting.ts semantics)
//       RETAINED   -> pause chase (possibleExistingClientAt) + post-it; the
//                     Square matcher or a human settles the money
//       NOT-VIABLE -> needsReview flag + post-it (never auto-closed)
//       CORRECTION / ambiguous / names-another-lead -> post-it only
//   - appends a timeline entry for EVERY matched office reply (negotiation
//     traffic included) so cards reflect ground truth.
//
// SAFETY mirrors the other syncs: marker docs (tvcThreadMessages/{id}) make
// re-runs harmless, post-its are deduped by leadId + subject, deleted leads
// are never touched, human-set terminal states are never overridden, and a
// first run with no cursor backfills from 2026-06-01 (the audited corpus —
// state that already matches gets markers + missing timeline entries only).

const GMAIL_SA_KEY = defineSecret("GMAIL_SA_KEY");
const MAILBOX = "office@ironrocklaw.com";
const GMAIL = "https://gmail.googleapis.com/gmail/v1/users/me";
const TVC_DOMAIN = "prodriver.com";
// Where the backfill starts when no cursor exists — the manually audited
// corpus begins here.
const BACKFILL_START = new Date("2026-06-01T00:00:00-05:00").getTime();

const lc = (s: unknown): string => String(s ?? "").toLowerCase().trim();

// All addresses in a To/Cc/From header ("Name <a@b.com>, c@d.com" -> emails).
const addressesIn = (header: string): string[] =>
  (header.match(/[\w.+-]+@[\w-]+\.[\w.-]+/g) ?? []).map(lc);

interface GmailFullMessage {
  id: string;
  internalDate: string;
  payload?: GmailPayloadPart & { headers?: { name: string; value: string }[] };
}

const headerOf = (m: GmailFullMessage, name: string): string =>
  m.payload?.headers?.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? "";

async function listMessages(token: string, q: string): Promise<string[]> {
  const ids: string[] = [];
  let pageToken = "";
  do {
    const url = `${GMAIL}/messages?q=${encodeURIComponent(q)}&maxResults=100${pageToken ? `&pageToken=${pageToken}` : ""}`;
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) throw new Error(`Gmail list ${res.status}: ${await res.text()}`);
    const json = (await res.json()) as { messages?: { id: string }[]; nextPageToken?: string };
    ids.push(...(json.messages ?? []).map((m) => m.id));
    pageToken = json.nextPageToken ?? "";
  } while (pageToken);
  return ids;
}

async function getFull(token: string, id: string): Promise<GmailFullMessage> {
  const res = await fetch(`${GMAIL}/messages/${id}?format=full`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`Gmail get ${res.status}: ${await res.text()}`);
  return (await res.json()) as GmailFullMessage;
}

interface LeadLite {
  id: string;
  name: string;
  deleted: boolean;
  phone: string | null;
  email: string | null;
}

// The WHOLE leads collection (paginated) — TVC threads reference cases far
// older than the recent-1000 window the other syncs use.
async function loadLeadIndexes(db: FirebaseFirestore.Firestore): Promise<{
  byCase: Map<string, LeadLite[]>;
  nameIndex: NameIndexEntry[];
}> {
  const byCase = new Map<string, LeadLite[]>();
  const named: { id: string; name: string }[] = [];
  let last: FirebaseFirestore.QueryDocumentSnapshot | null = null;
  for (;;) {
    let q = db
      .collection("leads")
      .orderBy("__name__")
      .limit(500)
      .select("name", "tvcCaseNumber", "deletedAt", "phone", "email");
    if (last) q = q.startAfter(last);
    const snap = await q.get();
    for (const doc of snap.docs) {
      const d = doc.data();
      const lead: LeadLite = {
        id: doc.id,
        name: (d.name as string) || "(unnamed)",
        deleted: Boolean(d.deletedAt),
        phone: (d.phone as string) || null,
        email: (d.email as string) || null,
      };
      const caseNo = String(d.tvcCaseNumber ?? "").trim();
      if (/^\d{7}$/.test(caseNo)) byCase.set(caseNo, [...(byCase.get(caseNo) ?? []), lead]);
      if (!lead.deleted) named.push({ id: lead.id, name: lead.name });
    }
    if (snap.size < 500) break;
    last = snap.docs[snap.size - 1];
  }
  return { byCase, nameIndex: buildNameIndex(named) };
}

// One live post-it per lead + subject, ever — the dedupe the other syncs use
// (squarePaymentId / squareInvoiceId) keyed on the deterministic subject.
async function postItOnce(
  db: FirebaseFirestore.Firestore,
  opts: {
    leadId: string | null;
    subject: string;
    message: string;
    caseNumber: string | null;
    memberName: string | null;
    phone: string | null;
    email: string | null;
    gmailMessageId: string;
    receivedAt: number;
  },
): Promise<boolean> {
  const existing = await db
    .collection("messages")
    .where("leadId", "==", opts.leadId)
    .where("subject", "==", opts.subject)
    .limit(1)
    .get();
  if (!existing.empty) return false;
  await db.collection("messages").add({
    kind: "tvc_message",
    source: "system",
    from: "TVC Thread Sync",
    fromName: "TVC Thread Sync",
    subject: opts.subject,
    message: opts.message,
    tvcCaseNumber: opts.caseNumber,
    memberName: opts.memberName,
    leadId: opts.leadId,
    phone: opts.phone,
    email: opts.email,
    gmailMessageId: opts.gmailMessageId,
    receivedAt: opts.receivedAt,
    handled: false,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });
  return true;
}

export const tvcThreadSync = onSchedule(
  { schedule: "every 15 minutes", secrets: [GMAIL_SA_KEY], timeoutSeconds: 540 },
  async () => {
    const db = getFirestore();
    let token: string;
    try {
      token = await delegatedGmailToken(GMAIL_SA_KEY.value(), MAILBOX);
    } catch (e) {
      // Same posture as emailsync: delegation problems surface via the
      // watchdog's credential probe, not a crash loop here.
      logger.warn(String(e));
      return;
    }

    // Overlapping lookback window; message markers make the overlap
    // harmless. First run (no cursor) backfills the audited corpus.
    const stateRef = db.collection("syncState").doc("tvcThreadSync");
    const state = await stateRef.get();
    const lastSyncAt = (state.data()?.lastSyncAt as number) ?? 0;
    const after = Math.floor((lastSyncAt ? lastSyncAt - 6 * 3600_000 : BACKFILL_START) / 1000);

    const q = `(to:${TVC_DOMAIN} OR cc:${TVC_DOMAIN}) -in:draft after:${after}`;
    const ids = await listMessages(token, q);

    const { byCase, nameIndex } = await loadLeadIndexes(db);

    let processed = 0;
    let attemptsLogged = 0;
    let postIts = 0;
    let routedLost = 0;
    let flagged = 0;

    // Oldest first, so multi-message threads act in business order.
    const pending: GmailFullMessage[] = [];
    for (const id of ids) {
      if ((await db.collection("tvcThreadMessages").doc(id).get()).exists) continue;
      pending.push(await getFull(token, id));
    }
    pending.sort((a, b) => Number(a.internalDate) - Number(b.internalDate));

    for (const meta of pending) {
      const marker = db.collection("tvcThreadMessages").doc(meta.id);
      const ts = Number(meta.internalDate) || Date.now();
      const subject = headerOf(meta, "Subject");
      const from = addressesIn(headerOf(meta, "From"));
      const rcpts = addressesIn(`${headerOf(meta, "To")},${headerOf(meta, "Cc")}`);

      // Office replies only — messages the FIRM sent into a TVC thread.
      const fromFirm = from.some(
        (a) => a.endsWith("@ironrocklaw.com") || a === "ironrocklaw@gmail.com",
      );
      const toTvc = rcpts.some((a) => a.endsWith(`@${TVC_DOMAIN}`));
      if (!fromFirm || !toTvc) {
        await marker.set({ processedAt: Date.now(), ts, leadId: null, action: "ignored_not_office_reply" });
        continue;
      }

      const fullText = payloadText(meta.payload);
      const replyText = stripQuotedHistory(fullText);
      const classification = classifyReply(replyText);

      // Case number: the subject names the thread's case; the fresh reply is
      // next; the quoted history (which carries TVC's original) is last. When
      // keyword-anchored extraction finds nothing at a level, a bare 7-digit
      // number that exactly matches a KNOWN lead's case number counts too
      // (real subjects like "Alberta King - 1525899" carry no "case"/"TVC").
      const casesIn = (text: string): string[] => {
        const anchoredHits = extractCaseNumbers(text);
        if (anchoredHits.length) return anchoredHits;
        return extractBareCaseNumbers(text).filter((c) => byCase.has(c));
      };
      const subjectCases = casesIn(subject);
      const replyCases = casesIn(replyText);
      const allCases = casesIn(`${subject}\n${fullText}`);
      const candidates = subjectCases.length
        ? subjectCases
        : replyCases.length
          ? replyCases
          : allCases;

      const baseMarker = {
        processedAt: Date.now(),
        ts,
        subject,
        caseNumbers: candidates,
        classification: classification.kind,
        anchor: classification.anchor,
      };
      const anchored = ["declined", "retained", "correction", "not_viable"].includes(
        classification.kind,
      );

      if (candidates.length === 0) {
        // No case number anywhere — nothing to tie the reply to. Threads
        // about cases the app never carried are TVC history, not misfilings;
        // log anchored dispositions so a human CAN look, but don't flood the
        // desk (the backfill found dozens of pre-app threads like this).
        if (anchored) {
          logger.warn("TVC thread disposition with no case number (marker only)", {
            gmailMessageId: meta.id,
            subject,
            classification: classification.kind,
          });
        }
        await marker.set({ ...baseMarker, leadId: null, action: "no_case_number" });
        processed++;
        continue;
      }

      if (candidates.length > 1) {
        // Several case numbers with no clear primary — human sorts it out.
        const added = await postItOnce(db, {
          leadId: null,
          subject: `TVC thread names several cases — ${candidates.join(", ")}`,
          message:
            `A firm reply to TVC references several case numbers ` +
            `(${candidates.join(", ")}) with no clear primary — no automatic action.\n` +
            `Classifier read: ${classification.kind}` +
            `${classification.anchor ? ` ("${classification.anchor}")` : ""}.\n` +
            `Subject: "${subject}"\nThe reply: "${excerptOf(replyText)}"`,
          caseNumber: null,
          memberName: null,
          phone: null,
          email: null,
          gmailMessageId: meta.id,
          receivedAt: ts,
        });
        if (added) postIts++;
        await marker.set({ ...baseMarker, leadId: null, action: "multi_case_review" });
        processed++;
        continue;
      }

      const caseNo = candidates[0];
      const sharing = byCase.get(caseNo) ?? [];
      const live = sharing.filter((l) => !l.deleted);

      if (sharing.length === 0 || live.length === 0) {
        // No lead (or only soft-deleted ones) carries this case number.
        // Pre-app cases and deliberately archived cards are TVC history —
        // marker + log only; the app can't be misfiled about a lead it
        // doesn't have.
        if (anchored) {
          logger.info("TVC thread disposition for a case the app doesn't carry (marker only)", {
            gmailMessageId: meta.id,
            caseNumber: caseNo,
            classification: classification.kind,
            deletedLeadOnly: sharing.length > 0,
          });
        }
        await marker.set({
          ...baseMarker,
          leadId: null,
          action: sharing.length ? "lead_deleted" : "case_no_lead",
        });
        processed++;
        continue;
      }

      if (live.length > 1) {
        // Two NON-DELETED leads share the number — never guess which card
        // the disposition belongs to.
        const names = live.map((l) => l.name).join(", ");
        const added = await postItOnce(db, {
          leadId: null,
          subject: `Duplicate leads share TVC case ${caseNo}`,
          message:
            `A firm reply to TVC concerns case ${caseNo}, but ${live.length} non-deleted ` +
            `leads share that case number (${names}) — no automatic action.\n` +
            `Classifier read: ${classification.kind}` +
            `${classification.anchor ? ` ("${classification.anchor}")` : ""}.\n` +
            `Subject: "${subject}"\nThe reply: "${excerptOf(replyText)}"\n` +
            `Merge/clean up the duplicates, then settle the disposition by hand.`,
          caseNumber: caseNo,
          memberName: names,
          phone: null,
          email: null,
          gmailMessageId: meta.id,
          receivedAt: ts,
        });
        if (added) postIts++;
        await marker.set({ ...baseMarker, leadId: null, action: "duplicate_leads_review" });
        processed++;
        continue;
      }

      const lead = live[0];

      // Other leads named in the FRESH reply (by case number or by name) —
      // the disposition may belong to the other thread.
      const otherNames = new Set<string>();
      for (const c of replyCases) {
        if (c === caseNo) continue;
        const others = (byCase.get(c) ?? []).filter((l) => !l.deleted);
        for (const o of others) if (o.id !== lead.id) otherNames.add(`${o.name} (case ${c})`);
        if (!others.length) otherNames.add(`case ${c}`);
      }
      for (const [, named] of findNamedLeads(replyText, nameIndex)) {
        if (named.id !== lead.id) otherNames.add(named.name);
      }

      const facts = {
        gmailMessageId: meta.id,
        ts,
        subject,
        replyText,
        caseNumber: caseNo,
        classification,
        otherLeadNames: [...otherNames],
      };

      // Plan + apply inside a transaction against the FRESH lead doc.
      // (Counting happens AFTER the transaction — retries must not double.)
      let action = "lead_missing";
      let attemptAdded = false;
      let plannedPostIt: { subject: string; message: string } | null = null;
      await db.runTransaction(async (tx) => {
        const ref = db.collection("leads").doc(lead.id);
        const snap = await tx.get(ref);
        if (!snap.exists) return;
        const d = snap.data()!;
        if (d.deletedAt) {
          action = "lead_deleted";
          return;
        }
        const plan = planLeadWrites(d, facts);
        action = plan.action;
        attemptAdded = Boolean(plan.attempt);
        plannedPostIt = plan.postIt;
        if (!plan.patch && !plan.attempt) return;
        const patch: Record<string, unknown> = { ...(plan.patch ?? {}), updatedAt: Date.now() };
        if (plan.attempt) {
          const attempts = Array.isArray(d.contactAttempts) ? d.contactAttempts : [];
          patch.contactAttempts = [...attempts, plan.attempt];
        }
        tx.update(ref, patch);
      });
      if (attemptAdded) attemptsLogged++;
      if (action === "declined_routed_lost") routedLost++;
      if (action === "retained_flagged" || action === "not_viable_flagged") flagged++;

      if (plannedPostIt) {
        const p = plannedPostIt as { subject: string; message: string };
        const added = await postItOnce(db, {
          leadId: lead.id,
          subject: p.subject,
          message: p.message,
          caseNumber: caseNo,
          memberName: lead.name,
          phone: lead.phone,
          email: lead.email,
          gmailMessageId: meta.id,
          receivedAt: ts,
        });
        if (added) postIts++;
      }

      await marker.set({ ...baseMarker, leadId: lead.id, action });
      processed++;
      if (action === "declined_routed_lost") {
        logger.info("TVC thread decline routed to No Sale", {
          leadId: lead.id,
          name: lead.name,
          caseNumber: caseNo,
          gmailMessageId: meta.id,
        });
      }
    }

    await stateRef.set({ lastSyncAt: Date.now() }, { merge: true });
    logger.info("TVC thread sync complete", {
      listed: ids.length,
      processed,
      attemptsLogged,
      postIts,
      routedLost,
      flagged,
    });
    await stampHeartbeat("tvcThreadSync");
  },
);
