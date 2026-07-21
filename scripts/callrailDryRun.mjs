// Dry run of the CallRail sync matching logic: pulls the last N days of calls
// from CallRail, matches customer numbers against lead phone numbers in
// Firestore, and prints what the sync WOULD do. Writes nothing anywhere.
// Requires CALLRAIL_API_KEY in .env.local and gcloud auth.
//
// Usage: node scripts/callrailDryRun.mjs [days]   (default 7)

import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const DAYS = Number(process.argv[2] || 7);
const PROJECT = 'tvchub-f2401';
const ACCOUNT = 'ACC0abdb2f39b9f45689f56e0e1eaea2ca3';
const BASE = `https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/(default)/documents`;

const API_KEY = readFileSync('.env.local', 'utf8').match(/^CALLRAIL_API_KEY=(.+)$/m)?.[1]?.trim();
if (!API_KEY) throw new Error('CALLRAIL_API_KEY not found in .env.local');
const gtoken = execSync('gcloud auth print-access-token').toString().trim();
const fsHeaders = { Authorization: `Bearer ${gtoken}`, 'x-goog-user-project': PROJECT };

const last10 = (s) => String(s ?? '').replace(/\D/g, '').slice(-10);

// --- leads ---
const docs = [];
let pt = '';
do {
  const r = await fetch(`${BASE}/leads?pageSize=300${pt ? `&pageToken=${pt}` : ''}`, { headers: fsHeaders });
  const j = await r.json();
  (j.documents || []).forEach((d) => docs.push(d));
  pt = j.nextPageToken || '';
} while (pt);

const byPhone = new Map();
for (const d of docs) {
  const f = d.fields || {};
  if (f.deletedAt?.integerValue) continue;
  for (const k of ['phone', 'altPhone']) {
    const key = last10(f[k]?.stringValue);
    if (key.length === 10 && !byPhone.has(key)) {
      byPhone.set(key, f.name?.stringValue || '(unnamed)');
    }
  }
}
console.log(`Leads: ${docs.length} · distinct lead phone numbers: ${byPhone.size}\n`);

// --- calls ---
const startDate = new Date(Date.now() - DAYS * 86400_000).toISOString();
const fields = 'id,direction,answered,voicemail,duration,customer_phone_number,customer_name,start_time,recording_player';
const calls = [];
let page = 1;
for (;;) {
  const url = `https://api.callrail.com/v3/a/${ACCOUNT}/calls.json?start_date=${encodeURIComponent(startDate)}&per_page=250&page=${page}&fields=${fields}`;
  const res = await fetch(url, { headers: { Authorization: `Token token="${API_KEY}"` } });
  if (!res.ok) throw new Error(`CallRail ${res.status}: ${await res.text()}`);
  const json = await res.json();
  calls.push(...(json.calls || []));
  if (page >= (json.total_pages || 1)) break;
  page++;
}
console.log(`CallRail calls in the last ${DAYS} day(s): ${calls.length}\n`);

const fmt = (c) =>
  `${new Date(c.start_time).toLocaleString('en-US', { timeZone: 'America/Chicago' })} · ${c.direction} · ` +
  `${c.customer_phone_number} (${(c.customer_name || '').trim() || '?'}) · ` +
  `${c.answered ? 'answered' : 'missed'}${c.voicemail ? '+vm' : ''}${c.duration ? ` · ${c.duration}s` : ''}`;

let attempts = 0, missed = 0, ignored = 0;
for (const c of calls.sort((a, b) => a.start_time.localeCompare(b.start_time))) {
  const lead = byPhone.get(last10(c.customer_phone_number));
  if (!lead) { ignored++; continue; }
  const missedInbound = c.direction === 'inbound' && (!c.answered || c.voicemail);
  if (missedInbound) {
    missed++;
    console.log(`POST-IT   ${fmt(c)}  ->  lead "${lead}"`);
  } else {
    attempts++;
    const outcome = c.voicemail ? 'voicemail' : c.answered ? 'spoke' : 'no_answer';
    console.log(`ATTEMPT   ${fmt(c)}  ->  lead "${lead}" [${outcome}]`);
  }
}
console.log(`\nWould log: ${attempts} contact attempt(s), ${missed} missed-call post-it(s); ${ignored} call(s) don't match any lead (ignored).`);
