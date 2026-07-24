// Heard-name reconciliation backfill (2026-07-24).
//
// The transcript AI mishears names constantly ("Dewitt Dawid" for Dawit
// Mekebeb — the audit found roughly half wrong), while the TVC referral on
// the lead doc carries the EXACT legal name. New calls are now fixed at the
// source (the classifier prompt carries the legal spelling) and reconciled by
// functions/src/nameMatch.ts; this one-off applies the SAME reconciliation to
// every existing contactAttempt's ai map:
//   - ai.callerName that fuzzy-matches the lead's legal name → overwritten
//     with the legal spelling ("corrected").
//   - ai.callerName that clearly names a DIFFERENT person → left alone
//     ("different person" — wrong-person calls are signal).
//   - misheard spellings of the lead's name inside ai.summary → corrected in
//     place with the same span logic the live sync uses.
//   - attempts whose ai carries no callerName and no correctable name span →
//     "no name field".
//
// Logic is a straight port of functions/src/nameMatch.ts — keep in sync.
// Run with DRY=1 first to preview without writing.
import { execSync } from 'node:child_process';

const PROJECT = 'tvchub-f2401';
const BASE = `https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/(default)/documents`;
const DRY = process.env.DRY === '1';

const fsToken = execSync('gcloud auth print-access-token').toString().trim();
const fsHeaders = {
  Authorization: `Bearer ${fsToken}`,
  'x-goog-user-project': PROJECT,
  'Content-Type': 'application/json',
};

// --- Firestore value codecs -----------------------------------------------
function dec(v) {
  if (!v || 'nullValue' in v) return null;
  if ('booleanValue' in v) return v.booleanValue;
  if ('integerValue' in v) return Number(v.integerValue);
  if ('doubleValue' in v) return v.doubleValue;
  if ('stringValue' in v) return v.stringValue;
  if ('arrayValue' in v) return (v.arrayValue.values || []).map(dec);
  if ('mapValue' in v)
    return Object.fromEntries(Object.entries(v.mapValue.fields || {}).map(([k, x]) => [k, dec(x)]));
  return null;
}
function enc(v) {
  if (v === null || v === undefined) return { nullValue: null };
  if (typeof v === 'boolean') return { booleanValue: v };
  if (typeof v === 'number')
    return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
  if (typeof v === 'string') return { stringValue: v };
  if (Array.isArray(v)) return { arrayValue: { values: v.map(enc) } };
  if (typeof v === 'object') {
    const fields = {};
    for (const [k, x] of Object.entries(v)) if (x !== undefined) fields[k] = enc(x);
    return { mapValue: { fields } };
  }
  throw new Error(`unsupported value: ${typeof v}`);
}
async function patchDoc(docPath, patch) {
  if (DRY) {
    console.log(`    DRY: would patch ${docPath} — ${Object.keys(patch).join(', ')}`);
    return;
  }
  const mask = Object.keys(patch)
    .map((k) => `updateMask.fieldPaths=${encodeURIComponent(k)}`)
    .join('&');
  const fields = {};
  for (const [k, v] of Object.entries(patch)) fields[k] = enc(v);
  const res = await fetch(`${BASE}/${docPath}?${mask}&currentDocument.exists=true`, {
    method: 'PATCH',
    headers: fsHeaders,
    body: JSON.stringify({ fields }),
  });
  if (!res.ok) throw new Error(`PATCH ${docPath} ${res.status}: ${await res.text()}`);
}

// --- Name helpers (ported from functions/src/nameMatch.ts) -----------------
function levenshtein(a, b) {
  if (a === b) return 0;
  const m = a.length;
  const n = b.length;
  if (!m || !n) return m || n;
  let prev = Array.from({ length: n + 1 }, (_, i) => i);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[n];
}
const nameTokensOf = (name) =>
  String(name ?? '')
    .toLowerCase()
    .replace(/[^a-z\s]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length >= 2);
function tokensAlike(a, b) {
  if (a === b) return true;
  if (a.length >= 4 && b.length >= 4 && (a.startsWith(b) || b.startsWith(a))) return true;
  const maxLen = Math.max(a.length, b.length);
  const d = levenshtein(a, b);
  if (maxLen >= 6) return d <= 2;
  if (maxLen >= 4) return d <= 1;
  return false;
}
function matchedTokenCount(heardTokens, legalTokens) {
  const used = new Set();
  let matched = 0;
  for (const ht of heardTokens) {
    const idx = legalTokens.findIndex((lt, i) => !used.has(i) && tokensAlike(ht, lt));
    if (idx >= 0) {
      used.add(idx);
      matched++;
    }
  }
  return matched;
}
function nameVerdict(heard, legal) {
  const h = nameTokensOf(heard);
  const l = nameTokensOf(legal);
  if (!h.length || !l.length) return 'none';
  const matched = matchedTokenCount(h, l);
  return matched >= 1 && matched * 2 >= h.length ? 'match' : 'different';
}
const NAME_STOPWORDS = new Set([
  'agent', 'caller', 'member', 'client', 'lead', 'attorney', 'lawyer', 'firm',
  'the', 'a', 'an', 'i', 'he', 'she', 'they', 'we', 'it', 'his', 'her', 'their',
  'mr', 'mrs', 'ms', 'dr', 'jr', 'sr', 'ii', 'iii', 'iv',
  'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday',
  'january', 'february', 'march', 'april', 'may', 'june', 'july', 'august',
  'september', 'october', 'november', 'december',
  'tvc', 'cdl', 'llc', 'docusign', 'square', 'callrail', 'motion', 'court',
]);
function correctNameInText(text, legalName) {
  const src = String(text ?? '');
  const legalTokens = nameTokensOf(legalName);
  const legal = String(legalName ?? '').trim();
  if (!src || !legalTokens.length) return null;
  const words = [];
  const re = /[A-Za-z][A-Za-z'-]*/g;
  let m;
  while ((m = re.exec(src))) words.push({ word: m[0], start: m.index, end: m.index + m[0].length });
  const isNameLike = (w) =>
    /^[A-Z]/.test(w.word) && w.word.length >= 2 && !NAME_STOPWORDS.has(w.word.toLowerCase());
  const runs = [];
  for (let i = 0; i < words.length; i++) {
    if (!isNameLike(words[i])) continue;
    let j = i;
    while (
      j + 1 < words.length &&
      isNameLike(words[j + 1]) &&
      /^\s+$/.test(src.slice(words[j].end, words[j + 1].start))
    ) {
      j++;
    }
    runs.push({ start: i, end: j });
    i = j;
  }
  const candidates = [];
  for (const run of runs) {
    let lo = run.start;
    let hi = run.end;
    const resembles = (w) => legalTokens.some((lt) => tokensAlike(w.toLowerCase(), lt));
    while (lo <= hi && !resembles(words[lo].word)) lo++;
    while (hi >= lo && !resembles(words[hi].word)) hi--;
    if (lo > hi) continue;
    const heardOf = (a, b) => words.slice(a, b + 1).map((w) => w.word).join(' ');
    if (nameVerdict(heardOf(lo, hi), legal) !== 'match') continue;
    // Grow back over garbled adjacent name parts (see functions/src/nameMatch.ts).
    const sentenceStart = (i) => {
      const before = src.slice(0, words[i].start).trimEnd();
      return before === '' || /[.!?]$/.test(before);
    };
    while (lo - 1 >= run.start && !sentenceStart(lo - 1) && nameVerdict(heardOf(lo - 1, hi), legal) === 'match') lo--;
    while (hi + 1 <= run.end && nameVerdict(heardOf(lo, hi + 1), legal) === 'match') hi++;
    const span = words.slice(lo, hi + 1);
    const heard = heardOf(lo, hi);
    const spanTokens = nameTokensOf(heard);
    candidates.push({
      from: span[0].start,
      to: span[span.length - 1].end,
      matched: matchedTokenCount(spanTokens, legalTokens),
      pure: spanTokens.every((t) => legalTokens.some((lt) => tokensAlike(t, lt))),
      alreadyCorrect: spanTokens.every((t) => legalTokens.includes(t)),
    });
  }
  // Best-span rule (see functions/src/nameMatch.ts): a weaker span with a
  // FOREIGN name part beside a stronger span is a deliberately quoted OTHER
  // name and survives (even when the strong span is already spelled right);
  // weaker spans purely of the lead's own tokens are fixed.
  const best = Math.max(...candidates.map((c) => c.matched), 0);
  const replacements = candidates.filter((c) => !c.alreadyCorrect && (c.matched === best || c.pure));
  if (!replacements.length) return null;
  let out = '';
  let cursor = 0;
  for (const r of replacements) {
    out += src.slice(cursor, r.from) + legal;
    cursor = r.to;
  }
  out += src.slice(cursor);
  return out === src ? null : out;
}

// --- Walk every live lead's ai maps ----------------------------------------
const leadDocs = [];
let pageToken = '';
do {
  const url = `${BASE}/leads?pageSize=300${pageToken ? `&pageToken=${pageToken}` : ''}`;
  const res = await fetch(url, { headers: fsHeaders });
  const json = await res.json();
  (json.documents || []).forEach((d) =>
    leadDocs.push({
      id: d.name.split('/').pop(),
      d: Object.fromEntries(Object.entries(d.fields || {}).map(([k, v]) => [k, dec(v)])),
    }),
  );
  pageToken = json.nextPageToken || '';
} while (pageToken);
console.log(`Leads loaded: ${leadDocs.length}`);

let corrected = 0;
let differentPerson = 0;
let noNameField = 0;
let attemptsWithAi = 0;
const examples = { corrected: [], different: [] };

for (const { id, d } of leadDocs) {
  if (d.deletedAt) continue;
  const attempts = Array.isArray(d.contactAttempts) ? d.contactAttempts : [];
  let changed = false;
  const newAttempts = attempts.map((a) => {
    if (!a || !a.ai) return a;
    attemptsWithAi++;
    let touched = false;
    const ai = { ...a.ai };
    let sawName = false;

    if (ai.callerName) {
      sawName = true;
      const v = nameVerdict(ai.callerName, d.name);
      if (v === 'match') {
        if (ai.callerName !== d.name) {
          examples.corrected.push({ lead: d.name, from: ai.callerName, to: d.name, field: 'callerName' });
          ai.callerName = d.name;
          touched = true;
          corrected++;
        }
      } else if (v === 'different') {
        differentPerson++;
        if (examples.different.length < 20)
          examples.different.push({ lead: d.name, heard: ai.callerName, field: 'callerName' });
      }
    }

    const fixedSummary = correctNameInText(ai.summary, d.name);
    if (fixedSummary) {
      sawName = true;
      examples.corrected.push({ lead: d.name, from: ai.summary, to: fixedSummary, field: 'summary' });
      ai.summary = fixedSummary;
      touched = true;
      corrected++;
    }

    if (!sawName) noNameField++;
    if (touched) {
      changed = true;
      return { ...a, ai };
    }
    return a;
  });
  if (changed) {
    console.log(`\nPATCH ${d.name} (${id})`);
    await patchDoc(`leads/${id}`, { contactAttempts: newAttempts, updatedAt: Date.now() });
  }
}

// --- Report ------------------------------------------------------------------
console.log('\n================= CORRECTIONS =================');
for (const e of examples.corrected) {
  console.log(`\n${e.lead} [${e.field}]`);
  console.log(`  from: ${e.from}`);
  console.log(`  to:   ${e.to}`);
}
console.log('\n================= LEFT AS DIFFERENT PERSON =================');
for (const e of examples.different) {
  console.log(`${e.lead}: heard "${e.heard}" [${e.field}] — clearly someone else, kept`);
}
console.log(
  `\nTotals over ${attemptsWithAi} analyzed attempts: ${corrected} corrected, ` +
    `${differentPerson} left as different person, ${noNameField} with no name field/span.`,
);
console.log(DRY ? '\n(DRY RUN — nothing written)' : '\nDone.');
