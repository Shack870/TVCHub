import { onSchedule } from "firebase-functions/v2/scheduler";
import { defineSecret } from "firebase-functions/params";
import { logger } from "firebase-functions/v2";
import { getFirestore } from "firebase-admin/firestore";
import { createSign } from "node:crypto";

// office@ Gmail → TVCHub email-activity sync.
//
// Every 15 minutes this reads office@ironrocklaw.com's recent mail via a
// domain-wide-delegated service account (read-only Gmail scope) and, for any
// message to/from an address matching a lead:
//   - outbound (sent to the lead)   -> appends an "email sent" contact attempt
//   - inbound  (reply from the lead)-> appends a "replied" attempt (outcome
//                                      spoke) and stamps lastConnectedAt, so
//                                      the cadence nudges instead of chasing
//
// Mirrors the CallRail sync's safety rules: never changes a lead's sales
// stage, and marker docs (emailTouches/{gmailMessageId}) make re-runs
// harmless. Requires the SA client ID to be authorized for scope
// gmail.readonly in the Workspace Admin Console (domain-wide delegation).

const GMAIL_SA_KEY = defineSecret("GMAIL_SA_KEY");
const MAILBOX = "office@ironrocklaw.com";
const GMAIL = "https://gmail.googleapis.com/gmail/v1/users/me";

const lc = (s: unknown): string => String(s ?? "").toLowerCase().trim();

// All addresses in a To/Cc/From header ("Name <a@b.com>, c@d.com" -> emails).
function addressesIn(header: string): string[] {
  return (header.match(/[\w.+-]+@[\w-]+\.[\w.-]+/g) ?? []).map(lc);
}

const b64url = (s: string | Buffer): string =>
  Buffer.from(s).toString("base64url");

// OAuth token for the delegated mailbox: sign a JWT with the SA private key
// (sub = the mailbox we impersonate) and exchange it at Google's token
// endpoint. Fails with unauthorized_client until DWD is granted in the
// Admin Console.
async function delegatedToken(keyJson: string): Promise<string> {
  const key = JSON.parse(keyJson) as { client_email: string; private_key: string };
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = b64url(
    JSON.stringify({
      iss: key.client_email,
      sub: MAILBOX,
      scope: "https://www.googleapis.com/auth/gmail.readonly",
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
  const json = (await res.json()) as { access_token?: string; error?: string; error_description?: string };
  if (!res.ok || !json.access_token) {
    throw new Error(`Gmail delegation failed: ${json.error} ${json.error_description ?? ""}`.trim());
  }
  return json.access_token;
}

interface GmailMessageMeta {
  id: string;
  internalDate: string;
  payload?: { headers?: { name: string; value: string }[] };
}

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
  } while (pageToken && ids.length < 500);
  return ids;
}

async function getMeta(token: string, id: string): Promise<GmailMessageMeta> {
  const url = `${GMAIL}/messages/${id}?format=metadata&metadataHeaders=To&metadataHeaders=Cc&metadataHeaders=From&metadataHeaders=Subject`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`Gmail get ${res.status}: ${await res.text()}`);
  return (await res.json()) as GmailMessageMeta;
}

const header = (m: GmailMessageMeta, name: string): string =>
  m.payload?.headers?.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? "";

export const syncEmail = onSchedule(
  { schedule: "every 15 minutes", secrets: [GMAIL_SA_KEY], timeoutSeconds: 300 },
  async () => {
    const db = getFirestore();
    let token: string;
    try {
      token = await delegatedToken(GMAIL_SA_KEY.value());
    } catch (e) {
      // Expected until domain-wide delegation is authorized in Admin Console.
      logger.warn(String(e));
      return;
    }

    // Email -> lead index (newest lead wins a shared address).
    const leadSnap = await db
      .collection("leads")
      .orderBy("createdAt", "desc")
      .limit(1000)
      .select("name", "email", "deletedAt", "lastConnectedAt")
      .get();
    const byEmail = new Map<string, { id: string; name: string }>();
    for (const doc of leadSnap.docs) {
      const d = doc.data();
      if (d.deletedAt) continue;
      const key = lc(d.email);
      if (key && !byEmail.has(key)) byEmail.set(key, { id: doc.id, name: d.name });
    }

    // Overlapping lookback window; message markers make the overlap harmless.
    const stateRef = db.collection("syncState").doc("emailSync");
    const state = await stateRef.get();
    const lastSyncAt = (state.data()?.lastSyncAt as number) ?? Date.now() - 3 * 86400_000;
    const after = Math.floor((lastSyncAt - 6 * 3600_000) / 1000);

    let sentLogged = 0;
    let repliesLogged = 0;

    for (const box of ["sent", "inbox"] as const) {
      const q = box === "sent" ? `in:sent after:${after}` : `in:inbox after:${after}`;
      const ids = await listMessages(token, q);
      for (const id of ids) {
        const marker = db.collection("emailTouches").doc(id);
        if ((await marker.get()).exists) continue;

        const meta = await getMeta(token, id);
        const ts = Number(meta.internalDate) || Date.now();
        const subject = header(meta, "Subject");

        let lead: { id: string; name: string } | undefined;
        if (box === "sent") {
          for (const addr of addressesIn(`${header(meta, "To")},${header(meta, "Cc")}`)) {
            lead = byEmail.get(addr);
            if (lead) break;
          }
        } else {
          lead = addressesIn(header(meta, "From"))
            .map((a) => byEmail.get(a))
            .find(Boolean);
        }

        if (!lead) {
          await marker.set({ processedAt: Date.now(), leadId: null, action: "ignored" });
          continue;
        }

        const isReply = box === "inbox";
        const attempt = {
          ts,
          outcome: isReply ? "spoke" : "no_answer",
          notes: isReply
            ? `Email REPLY received from lead${subject ? ` — "${subject}"` : ""}.`
            : `Outreach email sent from ${MAILBOX}${subject ? ` — "${subject}"` : ""}.`,
          by: "Email sync",
          via: "email",
        };
        await db.runTransaction(async (tx) => {
          const ref = db.collection("leads").doc(lead!.id);
          const snap = await tx.get(ref);
          if (!snap.exists) return;
          const d = snap.data()!;
          const attempts = Array.isArray(d.contactAttempts) ? d.contactAttempts : [];
          const patch: Record<string, unknown> = {
            contactAttempts: [...attempts, attempt],
            updatedAt: Date.now(),
          };
          if (isReply && ts > ((d.lastConnectedAt as number) ?? 0)) patch.lastConnectedAt = ts;
          tx.update(ref, patch);
        });
        await marker.set({
          processedAt: Date.now(),
          leadId: lead.id,
          action: isReply ? "reply" : "sent",
        });
        if (isReply) repliesLogged++;
        else sentLogged++;
      }
    }

    await stateRef.set({ lastSyncAt: Date.now() }, { merge: true });
    logger.info("Email sync complete", { sentLogged, repliesLogged });
  },
);
