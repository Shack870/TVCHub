import { createSign } from "node:crypto";

// Delegated Gmail OAuth token mint (factored out of emailsync.ts so the
// TVC-thread sync shares the exact same path; watchdog.ts keeps its generic
// multi-scope twin for credential probes — keep the two in sync).
//
// Sign an RS256 JWT with the service-account private key (sub = the mailbox
// we impersonate, scope gmail.readonly) and exchange it at Google's token
// endpoint. Fails with unauthorized_client until domain-wide delegation is
// granted for the SA client ID in the Workspace Admin Console.

const b64url = (s: string | Buffer): string => Buffer.from(s).toString("base64url");

export async function delegatedGmailToken(keyJson: string, mailbox: string): Promise<string> {
  const key = JSON.parse(keyJson) as { client_email: string; private_key: string };
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = b64url(
    JSON.stringify({
      iss: key.client_email,
      sub: mailbox,
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
  const json = (await res.json()) as {
    access_token?: string;
    error?: string;
    error_description?: string;
  };
  if (!res.ok || !json.access_token) {
    throw new Error(`Gmail delegation failed: ${json.error} ${json.error_description ?? ""}`.trim());
  }
  return json.access_token;
}
