// On-demand inbox scan. The Gmail puller lives in the intake@ Apps Script
// (deployed as a Web App); this hits its /exec URL so a user can pull new TVC
// leads immediately instead of waiting for the every-minute trigger. New leads
// stream into the board automatically via the Firestore listener.

const URL = import.meta.env.VITE_INBOX_CHECK_URL as string | undefined;
const TOKEN = import.meta.env.VITE_INBOX_CHECK_TOKEN as string | undefined;

export const inboxCheckConfigured = Boolean(URL && TOKEN);

export type InboxCheckResult = {
  ok: boolean;
  /** Number of new leads ingested this scan, when the response is readable. */
  ran?: number;
  /** True when the request was sent but the response couldn't be read (CORS). */
  unknown?: boolean;
  error?: string;
};

export async function checkInboxNow(): Promise<InboxCheckResult> {
  if (!URL || !TOKEN) {
    return { ok: false, error: 'not configured' };
  }
  const endpoint = `${URL}?token=${encodeURIComponent(TOKEN)}`;
  try {
    const res = await fetch(endpoint, { method: 'GET' });
    const data = (await res.json()) as InboxCheckResult;
    return data;
  } catch {
    // The browser may block reading the Apps Script response (cross-origin
    // redirect), but the scan itself still ran on the server. Treat as success
    // with an unknown count; the board will update as leads land.
    return { ok: true, unknown: true };
  }
}
