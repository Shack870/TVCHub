// Heard-name reconciliation (pure logic, no Firebase imports — testable).
//
// The transcript AI mishears names constantly ("Dewitt Dawid" for Dawit
// Mekebeb — the July audit found roughly half wrong), but the TVC referral on
// the lead doc carries the EXACT legal name. These helpers decide whether a
// name the AI heard on a call is the lead under a garbled spelling (fix it)
// or genuinely a different person (leave it — wrong-person calls are signal).
//
// Used by functions/src/callrail.ts on every new analysis and ported into
// scripts/reconcileHeardNames-2026-07-24.mjs for the historical backfill —
// keep the two copies in sync.

export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  const m = a.length;
  const n = b.length;
  if (!m || !n) return m || n;
  let prev = Array.from({ length: n + 1 }, (_, i) => i);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(
        prev[j] + 1,
        cur[j - 1] + 1,
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    prev = cur;
  }
  return prev[n];
}

// Lowercase name tokens, punctuation stripped, 2+ chars.
export function nameTokensOf(name: unknown): string[] {
  return String(name ?? "")
    .toLowerCase()
    .replace(/[^a-z\s]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length >= 2);
}

// Do two name TOKENS plausibly refer to the same spoken name? Exact match,
// a 4+-char prefix relationship (Sam/Samer), or a small edit distance scaled
// to token length — mishearings garble a letter or two, not the whole word
// ("dewitt"/"dawit" = 2 edits, "dawid"/"dawit" = 1).
export function tokensAlike(a: string, b: string): boolean {
  if (a === b) return true;
  if (a.length >= 4 && b.length >= 4 && (a.startsWith(b) || b.startsWith(a))) return true;
  const maxLen = Math.max(a.length, b.length);
  const d = levenshtein(a, b);
  if (maxLen >= 6) return d <= 2;
  if (maxLen >= 4) return d <= 1;
  return false; // 2-3 char tokens must match exactly
}

export type NameVerdict = "match" | "different" | "none";

// How many heard tokens fuzzy-match DISTINCT legal tokens (greedy).
function matchedTokenCount(heardTokens: string[], legalTokens: string[]): number {
  const used = new Set<number>();
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

// Is the HEARD name the LEGAL name under a mangled spelling?
//   'match'     — at least half the heard tokens fuzzy-match distinct legal
//                 tokens (a caller identified by first name only still
//                 matches; "Dewitt Dawid" matches "Dawit Mekebeb" on the one
//                 recoverable token).
//   'different' — name-shaped but foreign to the legal name: that's a real
//                 signal (wrong-person call), never "corrected".
//   'none'      — one side is empty/unusable; nothing to reason about.
export function nameVerdict(heard: unknown, legal: unknown): NameVerdict {
  const h = nameTokensOf(heard);
  const l = nameTokensOf(legal);
  if (!h.length || !l.length) return "none";
  const matched = matchedTokenCount(h, l);
  return matched >= 1 && matched * 2 >= h.length ? "match" : "different";
}

// Words that look like names (capitalized, mid-sentence) but never are —
// breaks capitalized-run detection so "Agent Dewitt Dawid" doesn't swallow
// "Agent" into the replacement span.
const NAME_STOPWORDS = new Set([
  "agent", "caller", "member", "client", "lead", "attorney", "lawyer", "firm",
  "the", "a", "an", "i", "he", "she", "they", "we", "it", "his", "her", "their",
  "mr", "mrs", "ms", "dr", "jr", "sr", "ii", "iii", "iv",
  "monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday",
  "january", "february", "march", "april", "may", "june", "july", "august",
  "september", "october", "november", "december",
  "tvc", "cdl", "llc", "docusign", "square", "callrail", "motion", "court",
]);

// Fix a misheard spelling of the lead's legal name inside free text (the
// classifier's summary). Finds runs of capitalized words, trims tokens that
// don't resemble any legal-name token, and — when the surviving span reads as
// the lead under a wrong spelling — swaps in the legal spelling. Returns the
// corrected text, or null when nothing needed changing. Spans that name a
// clearly different person never match and are left alone.
export function correctNameInText(text: unknown, legalName: unknown): string | null {
  const src = String(text ?? "");
  const legalTokens = nameTokensOf(legalName);
  const legal = String(legalName ?? "").trim();
  if (!src || !legalTokens.length) return null;

  // Capitalized word tokens with positions.
  const words: { word: string; start: number; end: number }[] = [];
  const re = /[A-Za-z][A-Za-z'-]*/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    words.push({ word: m[0], start: m.index, end: m.index + m[0].length });
  }

  const isNameLike = (w: { word: string }) =>
    /^[A-Z]/.test(w.word) &&
    w.word.length >= 2 &&
    !NAME_STOPWORDS.has(w.word.toLowerCase());

  // Maximal runs of adjacent (whitespace-separated) name-like words.
  const runs: { start: number; end: number; tokens: string[] }[] = [];
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
    runs.push({ start: i, end: j, tokens: words.slice(i, j + 1).map((w) => w.word) });
    i = j;
  }

  const candidates: {
    from: number;
    to: number;
    matched: number;
    pure: boolean;
    alreadyCorrect: boolean;
  }[] = [];
  for (const run of runs) {
    // Trim edge tokens that resemble no legal token ("Called Dawit Tuesday"
    // must shrink to just "Dawit" before any verdict is taken).
    let lo = run.start;
    let hi = run.end;
    const resembles = (w: string) =>
      legalTokens.some((lt) => tokensAlike(w.toLowerCase(), lt));
    while (lo <= hi && !resembles(words[lo].word)) lo++;
    while (hi >= lo && !resembles(words[hi].word)) hi--;
    if (lo > hi) continue;
    const heardOf = (a: number, b: number) =>
      words.slice(a, b + 1).map((w) => w.word).join(" ");
    if (nameVerdict(heardOf(lo, hi), legal) !== "match") continue;
    // Grow the span back over adjacent run words that the trim cut, as long
    // as the whole span still reads as the lead — a badly garbled SECOND name
    // part ("Awev Award" for Awet Hayle, "Ahmad Yar" for Malyar Ahmadyar)
    // must be replaced along with the recoverable one, not left dangling
    // next to the correction. Never grow left onto a sentence-start word —
    // that capitalization ("Spoke with Dawid...") is grammar, not identity.
    const sentenceStart = (i: number) => {
      const before = src.slice(0, words[i].start).trimEnd();
      return before === "" || /[.!?]$/.test(before);
    };
    while (
      lo - 1 >= run.start &&
      !sentenceStart(lo - 1) &&
      nameVerdict(heardOf(lo - 1, hi), legal) === "match"
    ) {
      lo--;
    }
    while (hi + 1 <= run.end && nameVerdict(heardOf(lo, hi + 1), legal) === "match") hi++;
    const span = words.slice(lo, hi + 1);
    const heard = heardOf(lo, hi);
    const spanTokens = nameTokensOf(heard);
    candidates.push({
      from: span[0].start,
      to: span[span.length - 1].end,
      matched: matchedTokenCount(spanTokens, legalTokens),
      // Every heard token resembles SOME legal token — no foreign name parts.
      pure: spanTokens.every((t) => legalTokens.some((lt) => tokensAlike(t, lt))),
      // Already the correct spelling (a subset of the legal tokens): never
      // rewritten, but still counted for the best-span shield below.
      alreadyCorrect: spanTokens.every((t) => legalTokens.includes(t)),
    });
  }
  // Best-span rule: when a text carries SEVERAL name-ish spans, a weaker
  // span carrying a FOREIGN name part next to a stronger span is usually a
  // deliberately quoted OTHER name ("his name was incorrectly listed as
  // Pedro Munoz" on Antonio Carlos Munhoz's card must survive — including
  // when the strong span is ALREADY spelled right). Weaker spans made purely
  // of the lead's own (garbled) tokens are still fixed.
  const best = Math.max(...candidates.map((c) => c.matched), 0);
  const replacements = candidates.filter(
    (c) => !c.alreadyCorrect && (c.matched === best || c.pure),
  );
  if (!replacements.length) return null;

  let out = "";
  let cursor = 0;
  for (const r of replacements) {
    out += src.slice(cursor, r.from) + legal;
    cursor = r.to;
  }
  out += src.slice(cursor);
  return out === src ? null : out;
}
