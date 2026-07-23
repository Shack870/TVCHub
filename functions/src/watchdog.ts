import { onSchedule } from "firebase-functions/v2/scheduler";
import { defineSecret } from "firebase-functions/params";
import { logger } from "firebase-functions/v2";
import { getFirestore } from "firebase-admin/firestore";
import { createSign } from "node:crypto";

// Self-monitoring watchdog: the oversight engine checking its own pulse.
//
// Every scheduled sync in this project exists to make sure a human never has
// to notice that something silently stopped — but nothing watched the
// watchers. This daily sweep (7:30 AM Central, after the cadence sweep) checks
// four failure classes and puts ONE consolidated Action Item post-it on the
// desk only when something is genuinely broken:
//
//   1. SYNC FRESHNESS — syncState lastSyncAt stamps, the newest processed
//      CallRail call marker, and the newest lead createdAt (soft signal).
//   2. ERROR SIGNALS — PDF handoffs the retry sweep gave up on, and leads
//      stuck in Needs Review > 24h (extraction failures awaiting repair).
//   3. CREDENTIAL HEALTH — cheap no-LLM probes: CallRail 1-call list, Square
//      GET /v2/locations, a Gmail delegated token mint, and a PDF-app
//      datastore token mint + one-doc read.
//   4. SCHEDULED-JOB HEALTH — syncState/heartbeats.{fn} stamps written by
//      each scheduled function at the end of a successful run, checked
//      against each function's cadence (gcloud isn't available in the
//      runtime, so heartbeats + freshness stand in for scheduler state).
//
// Reporting rules (don't cry wolf — a Watchdog post-it must MEAN something):
//   - any RED -> one consolidated post-it; an existing unhandled watchdog
//     post-it is UPDATED (message + receivedAt) instead of stacking a new one.
//   - all green -> no post-it; log the details and stamp
//     syncState/watchdog.lastAllGreenAt.
//   - YELLOW-only (soft signals, e.g. no new leads in 72h) -> log-only;
//     yellows ride along in the post-it only when a red already justifies it.
//   - a check that THROWS counts as red with the error text — one check's
//     exception never kills the run.

const CALLRAIL_API_KEY = defineSecret("CALLRAIL_API_KEY");
const SQUARE_ACCESS_TOKEN = defineSecret("SQUARE_ACCESS_TOKEN");
const GMAIL_SA_KEY = defineSecret("GMAIL_SA_KEY");
const PDFAPP_SA_KEY = defineSecret("PDFAPP_SA_KEY");

// Mirrors callrail.ts / squaresync.ts / emailsync.ts / pdfhandoff.ts.
const CALLRAIL_ACCOUNT = "ACC0abdb2f39b9f45689f56e0e1eaea2ca3";
const SQUARE = "https://connect.squareup.com/v2";
const SQUARE_VERSION = "2026-06-18";
const MAILBOX = "office@ironrocklaw.com";
const PDF_FS_BASE =
  "https://firestore.googleapis.com/v1/projects/ironrockpdf/databases/(default)/documents";

const HOUR = 3600_000;
const DAY = 24 * HOUR;

// Heartbeat expectations: function -> (cadence label, max tolerated age).
const HEARTBEATS: { fn: string; cadence: string; maxAgeMs: number }[] = [
  { fn: "syncCallRail", cadence: "every 5 minutes", maxAgeMs: 1 * HOUR },
  { fn: "syncEmail", cadence: "every 15 minutes", maxAgeMs: 2 * HOUR },
  { fn: "syncSquare", cadence: "every 15 minutes", maxAgeMs: 2 * HOUR },
  { fn: "cadenceSweep", cadence: "daily at 7:00 AM", maxAgeMs: 26 * HOUR },
  { fn: "retryPdfHandoff", cadence: "hourly", maxAgeMs: 3 * HOUR },
];

type Level = "green" | "yellow" | "red";
interface Finding {
  check: string;
  level: Level;
  detail: string;
}

function ago(ms: number): string {
  const h = Math.floor(ms / HOUR);
  if (h < 1) return `${Math.max(1, Math.round(ms / 60_000))}m`;
  if (h < 48) return `${h}h`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

// Generic SA-key JWT -> OAuth token mint (the emailsync/pdfhandoff pattern;
// `sub` present = domain-wide delegation as that user).
async function mintToken(keyJson: string, scope: string, sub?: string): Promise<string> {
  const key = JSON.parse(keyJson) as { client_email: string; private_key: string };
  const now = Math.floor(Date.now() / 1000);
  const b64url = (s: string): string => Buffer.from(s).toString("base64url");
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = b64url(
    JSON.stringify({
      iss: key.client_email,
      ...(sub ? { sub } : {}),
      scope,
      aud: "https://oauth2.googleapis.com/token",
      iat: now,
      exp: now + 3600,
    }),
  );
  const signer = createSign("RSA-SHA256");
  signer.update(`${header}.${claims}`);
  const jwt = `${header}.${claims}.${signer.sign(key.private_key, "base64url")}`;

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: `grant_type=${encodeURIComponent("urn:ietf:params:oauth:grant-type:jwt-bearer")}&assertion=${jwt}`,
  });
  const json = (await res.json()) as {
    access_token?: string;
    error?: string;
    error_description?: string;
  };
  if (!res.ok || !json.access_token) {
    throw new Error(`token mint failed: ${json.error} ${json.error_description ?? ""}`.trim());
  }
  return json.access_token;
}

export const watchdog = onSchedule(
  {
    schedule: "30 7 * * *",
    timeZone: "America/Chicago",
    secrets: [CALLRAIL_API_KEY, SQUARE_ACCESS_TOKEN, GMAIL_SA_KEY, PDFAPP_SA_KEY],
    timeoutSeconds: 180,
  },
  async () => {
    const db = getFirestore();
    const now = Date.now();
    const findings: Finding[] = [];
    const add = (check: string, level: Level, detail: string): void => {
      findings.push({ check, level, detail });
    };
    // Each check runs in its own try/catch — an ERROR is itself a red finding
    // (the watchdog couldn't verify the thing, which is as bad as it failing).
    const guarded = async (check: string, fn: () => Promise<void>): Promise<void> => {
      try {
        await fn();
      } catch (e) {
        add(
          check,
          "red",
          `The "${check}" check itself errored (${e instanceof Error ? e.message : String(e)})` +
            ` — the watchdog couldn't verify this; treat it as failing.`,
        );
      }
    };

    // Weekends thin out calls and referrals: Sat/Sun/Mon get the wide window
    // (Monday morning looks back across the whole weekend).
    const dow = new Intl.DateTimeFormat("en-US", {
      weekday: "short",
      timeZone: "America/Chicago",
    }).format(new Date(now));
    const nearWeekend = dow === "Sat" || dow === "Sun" || dow === "Mon";

    // --- 1. SYNC FRESHNESS --------------------------------------------------

    await guarded("Email sync freshness", async () => {
      const at = (await db.collection("syncState").doc("emailSync").get()).data()
        ?.lastSyncAt as number | undefined;
      if (!at) {
        add(
          "Email sync freshness",
          "red",
          "The email sync has never recorded a completed run — emails to/from leads are not being logged. Check the Firebase console.",
        );
      } else if (now - at > 2 * HOUR) {
        add(
          "Email sync freshness",
          "red",
          `The email sync hasn't completed in ${ago(now - at)} (it runs every 15 minutes) — emails to/from leads are not being logged. Check the Firebase console.`,
        );
      } else {
        add("Email sync freshness", "green", `last completed ${ago(now - at)} ago`);
      }
    });

    await guarded("Square sync freshness", async () => {
      const at = (await db.collection("syncState").doc("squareSync").get()).data()
        ?.lastSyncAt as number | undefined;
      if (!at) {
        add(
          "Square sync freshness",
          "red",
          "The Square sync has never recorded a completed run — payments are not being reconciled onto leads. Check the Firebase console.",
        );
      } else if (now - at > 2 * HOUR) {
        add(
          "Square sync freshness",
          "red",
          `The Square sync hasn't completed in ${ago(now - at)} (it runs every 15 minutes) — payments are not being reconciled onto leads. Check the Firebase console.`,
        );
      } else {
        add("Square sync freshness", "green", `last completed ${ago(now - at)} ago`);
      }
    });

    await guarded("CallRail call flow", async () => {
      const snap = await db
        .collection("callrailCalls")
        .orderBy("processedAt", "desc")
        .limit(1)
        .get();
      const at = (snap.docs[0]?.data()?.processedAt as number | undefined) ?? 0;
      const maxAge = nearWeekend ? 72 * HOUR : 24 * HOUR;
      if (!at || now - at > maxAge) {
        add(
          "CallRail call flow",
          "red",
          `No CallRail call has been processed in ${at ? ago(now - at) : "ever"} — calls are not being logged (sync down, or the phones have gone completely silent). Check the Firebase console.`,
        );
      } else {
        add("CallRail call flow", "green", `newest processed call ${ago(now - at)} ago`);
      }
    });

    // Soft signal only: referrals arrive most weekdays, but a quiet stretch is
    // legitimately possible — warn, never alarm on its own.
    await guarded("New-lead flow", async () => {
      const snap = await db.collection("leads").orderBy("createdAt", "desc").limit(1).get();
      const at = (snap.docs[0]?.data()?.createdAt as number | undefined) ?? 0;
      const maxAge = nearWeekend ? 4 * DAY : 3 * DAY;
      if (!at || now - at > maxAge) {
        add(
          "New-lead flow",
          "yellow",
          `No new lead has arrived in ${at ? ago(now - at) : "ever"} — TVC referrals come most weekdays. Could be a quiet stretch, or the referral email pipeline (Apps Script → ingestEmail) may be stuck.`,
        );
      } else {
        add("New-lead flow", "green", `newest lead created ${ago(now - at)} ago`);
      }
    });

    // --- 2. ERROR SIGNALS ---------------------------------------------------

    await guarded("PDF handoff failures", async () => {
      const snap = await db.collection("leads").where("pdfAppSendAttempts", ">=", 3).get();
      const stuck = snap.docs.filter((d) => {
        const x = d.data();
        return x.pdfAppSendError && !x.pdfAppSentAt && !x.deletedAt;
      });
      if (stuck.length) {
        const names = stuck
          .slice(0, 5)
          .map((d) => (d.data().name as string) || d.id)
          .join(", ");
        add(
          "PDF handoff failures",
          "red",
          `${stuck.length} intake-complete case${stuck.length === 1 ? "" : "s"} failed to reach the PDF app after 3 attempts (${names}) — the retry has given up; the case${stuck.length === 1 ? "" : "s"} must be entered in the PDF app by hand.`,
        );
      } else {
        add("PDF handoff failures", "green", "no given-up handoffs");
      }
    });

    await guarded("Needs Review backlog", async () => {
      const snap = await db.collection("leads").where("needsReview", "==", true).get();
      const stuck = snap.docs.filter(
        (d) => !d.data().deletedAt && ((d.data().createdAt as number) ?? 0) < now - DAY,
      );
      if (stuck.length) {
        const names = stuck
          .slice(0, 5)
          .map((d) => (d.data().name as string) || d.id)
          .join(", ");
        add(
          "Needs Review backlog",
          "red",
          `${stuck.length} lead${stuck.length === 1 ? " has" : "s have"} sat in Needs Review for over 24h (${names}) — the referral couldn't be parsed and nobody has repaired the card. Open the lead and fill it in from the attached email/PDF.`,
        );
      } else {
        add("Needs Review backlog", "green", "no leads stuck in review");
      }
    });

    // --- 3. CREDENTIAL HEALTH (cheap probes, no LLM spend) -------------------

    await guarded("CallRail credential", async () => {
      const url = `https://api.callrail.com/v3/a/${CALLRAIL_ACCOUNT}/calls.json?per_page=1&fields=id`;
      const res = await fetch(url, {
        headers: { Authorization: `Token token="${CALLRAIL_API_KEY.value()}"` },
      });
      if (!res.ok) {
        add(
          "CallRail credential",
          "red",
          `The CallRail API rejected our key (HTTP ${res.status}) — call syncing is dead until the key is fixed; calls are not being logged.`,
        );
      } else {
        add("CallRail credential", "green", "API answered the 1-call probe");
      }
    });

    await guarded("Square credential", async () => {
      const res = await fetch(`${SQUARE}/locations`, {
        headers: {
          Authorization: `Bearer ${SQUARE_ACCESS_TOKEN.value()}`,
          "Square-Version": SQUARE_VERSION,
        },
      });
      if (!res.ok) {
        add(
          "Square credential",
          "red",
          `The Square API rejected our token (HTTP ${res.status}) — payment syncing is dead until the token is fixed; payments are not being reconciled.`,
        );
      } else {
        add("Square credential", "green", "GET /v2/locations answered");
      }
    });

    await guarded("Gmail credential", async () => {
      try {
        await mintToken(
          GMAIL_SA_KEY.value(),
          "https://www.googleapis.com/auth/gmail.readonly",
          MAILBOX,
        );
        add("Gmail credential", "green", `delegated token minted for ${MAILBOX}`);
      } catch (e) {
        add(
          "Gmail credential",
          "red",
          `Gmail delegated auth for ${MAILBOX} failed (${e instanceof Error ? e.message : String(e)}) — email syncing is dead until the service-account key/delegation is fixed.`,
        );
      }
    });

    await guarded("PDF-app credential", async () => {
      try {
        const token = await mintToken(
          PDFAPP_SA_KEY.value(),
          "https://www.googleapis.com/auth/datastore",
        );
        const res = await fetch(`${PDF_FS_BASE}/cases?pageSize=1`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!res.ok) throw new Error(`cases read HTTP ${res.status}`);
        add("PDF-app credential", "green", "datastore token minted, one-doc read OK");
      } catch (e) {
        add(
          "PDF-app credential",
          "red",
          `PDF-app Firestore access failed (${e instanceof Error ? e.message : String(e)}) — case handoffs to the PDF app will fail until the service account is fixed.`,
        );
      }
    });

    // --- 4. SCHEDULED-JOB HEALTH (heartbeats) --------------------------------

    await guarded("Scheduled-job heartbeats", async () => {
      const hb = (await db.collection("syncState").doc("heartbeats").get()).data() ?? {};
      for (const { fn, cadence, maxAgeMs } of HEARTBEATS) {
        const at = (hb[fn] as number | undefined) ?? 0;
        const check = `Heartbeat: ${fn}`;
        if (!at) {
          add(
            check,
            "red",
            `${fn} has never stamped a heartbeat — the scheduled job may not be running at all. Check Cloud Scheduler / the Firebase console.`,
          );
        } else if (now - at > maxAgeMs) {
          add(
            check,
            "red",
            `${fn} last completed ${ago(now - at)} ago (it runs ${cadence}) — the scheduled job looks stuck or failing. Check its logs in the Firebase console.`,
          );
        } else {
          add(check, "green", `last successful run ${ago(now - at)} ago`);
        }
      }
    });

    // --- REPORTING -----------------------------------------------------------

    const reds = findings.filter((f) => f.level === "red");
    const yellows = findings.filter((f) => f.level === "yellow");
    const summary = findings.map((f) => `[${f.level.toUpperCase()}] ${f.check}: ${f.detail}`);

    await db
      .collection("syncState")
      .doc("watchdog")
      .set(
        {
          lastRunAt: now,
          lastRedCount: reds.length,
          lastYellowCount: yellows.length,
          ...(reds.length === 0 && yellows.length === 0 ? { lastAllGreenAt: now } : {}),
        },
        { merge: true },
      );

    if (!reds.length) {
      // Yellow-only stays off the desk — a Watchdog post-it must always mean
      // something is genuinely broken.
      if (yellows.length) {
        logger.warn("Watchdog: soft signals only (log-only, no post-it)", { checks: summary });
      } else {
        logger.info("Watchdog: all systems green", { checks: summary });
      }
      return;
    }

    const subject = `SYSTEM HEALTH: ${reds.length} check${reds.length === 1 ? "" : "s"} failing`;
    const message =
      `The daily system self-check found ${reds.length} failing check${reds.length === 1 ? "" : "s"}:\n\n` +
      reds.map((f, i) => `${i + 1}. ${f.check}: ${f.detail}`).join("\n") +
      (yellows.length
        ? `\n\nAlso worth a look (soft signals):\n` +
          yellows.map((f) => `- ${f.check}: ${f.detail}`).join("\n")
        : "") +
      `\n\nFull check details are in the watchdog function logs (Firebase console).`;

    // Dedupe: one live watchdog post-it at a time — an unhandled one is
    // brought current instead of stacking a new note every morning.
    const open = await db
      .collection("messages")
      .where("kind", "==", "tvc_message")
      .where("from", "==", "Watchdog")
      .where("handled", "==", false)
      .get();
    const existing = open.docs.find((d) => !d.data().deletedAt);
    if (existing) {
      await existing.ref.update({ subject, message, receivedAt: now, updatedAt: now });
    } else {
      await db.collection("messages").add({
        kind: "tvc_message",
        source: "system",
        from: "Watchdog",
        fromName: "System Watchdog",
        subject,
        message,
        tvcCaseNumber: null,
        memberName: null,
        leadId: null,
        phone: null,
        email: null,
        gmailMessageId: null,
        receivedAt: now,
        handled: false,
        createdAt: now,
        updatedAt: now,
      });
    }

    logger.warn("Watchdog: red findings — post-it " + (existing ? "updated" : "created"), {
      reds: reds.length,
      yellows: yellows.length,
      checks: summary,
    });
  },
);
