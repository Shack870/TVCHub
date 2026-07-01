// TVC referral parser (server copy, kept in sync with src/lib/tvcParser.ts).
// Tokenizes the document by known labels so it works on both pasted email text
// and glued PDF text layers, and selects the correct occurrence of each field.

export interface Ticket {
  type?: string;
  number?: string;
  violation?: string;
  code?: string;
}

export interface ParsedLead {
  tvcCaseNumber?: string;
  name?: string;
  phone?: string;
  email?: string;
  address?: string;
  birthdate?: string;
  language?: string;
  driversLicense?: string;
  driversLicenseState?: string;
  driversLicenseType?: string;
  vehicleType?: string;
  violationDate?: string;
  caseOpenedOn?: string;
  tickets?: Ticket[];
  charge?: string;
  courtName?: string;
  courtPhone?: string;
  courtAddress?: string;
  courtCity?: string;
  county?: string;
  state?: string;
  courtZip?: string;
  nextCourtDate?: string | null;
  nextCourtTime?: string;
  nextCourtType?: string;
}

interface LabelDef {
  key: string;
  re: string;
}

const LABELS: LabelDef[] = [
  { key: "examReport", re: "Examination\\s*Report\\s*Received" },
  { key: "accident", re: "Accident\\s*Involved" },
  { key: "preExisting", re: "Pre-?\\s*Existing" },
  { key: "movingViolation", re: "Moving\\s*Violation" },
  { key: "courtDates", re: "Court\\s*Dates" },
  { key: "courtName", re: "Court\\s*Name" },
  { key: "courtInfo", re: "Court\\s*Info" },
  { key: "driverInfo", re: "Driver\\s*Info" },
  { key: "coverage", re: "Case\\s*Coverage\\s*Type" },
  { key: "caseOpened", re: "Case\\s*Opened\\s*on" },
  { key: "vehicleType", re: "Vehicle\\s*Type" },
  { key: "famName", re: "Family\\s*Member\\s*Name" },
  { key: "famRel", re: "Family\\s*Member\\s*Relationship" },
  { key: "dlType", re: "Driver'?s\\s*License\\s*Type" },
  { key: "dlState", re: "Driver'?s\\s*License\\s*State" },
  { key: "dl", re: "Driver'?s\\s*License" },
  { key: "language", re: "Preferred\\s*Language" },
  { key: "emailAddr", re: "E-?mail\\s*Address" },
  { key: "violationDate", re: "Violation\\s*Date" },
  { key: "birthdate", re: "Birthdate" },
  { key: "zip", re: "Zip\\s*Code" },
  { key: "lawType", re: "Law\\s*Type" },
  { key: "memberInfo", re: "Member\\s*Info" },
  { key: "attorneyInfo", re: "Attorney\\s*Info" },
  { key: "ticketInfo", re: "Ticket\\s*Info" },
  { key: "tickets", re: "Tickets" },
  { key: "phone", re: "Phone" },
  { key: "mobile", re: "Mobile" },
  { key: "fax", re: "Fax" },
  { key: "firm", re: "Firm" },
  { key: "attorney", re: "Attorney" },
  { key: "member", re: "Member" },
  { key: "address", re: "Address" },
  { key: "city", re: "City" },
  { key: "county", re: "County" },
  { key: "state", re: "State" },
  { key: "description", re: "Description" },
];

interface Token {
  key: string;
  value: string;
}

function stripNoise(raw: string): string {
  let t = raw
    .replace(/https?:\/\/[^\s…]+/gi, " ")
    .replace(/This message's attachments[\s\S]*?by phone\.?/i, " ")
    .replace(/\d{1,2}\/\d{1,2}\/\d{2,4},\s*\d{1,2}:\d{2}\s*[AP]M/gi, " ")
    .replace(/ironrocklaw\.com Mail/gi, " ")
    .replace(/--\s*\d+\s*of\s*\d+\s*--/gi, " ")
    .replace(/…?\s*\d\/\d\b/g, " ");
  t = t.split(/Description\s*Entry/i)[0];
  return t.replace(/\s+/g, " ").trim();
}

function canonical(matchText: string): string {
  for (const l of LABELS) {
    if (new RegExp(`^(?:${l.re})$`, "i").test(matchText)) return l.key;
  }
  return "unknown";
}

function tokenize(text: string): Token[] {
  const alternation = LABELS.map((l) => l.re).join("|");
  const re = new RegExp(`(${alternation})`, "gi");
  const matches = [...text.matchAll(re)];
  const tokens: Token[] = [];
  for (let i = 0; i < matches.length; i++) {
    const m = matches[i];
    const matchText = m[0];
    const start = (m.index ?? 0) + matchText.length;
    const end = i + 1 < matches.length ? matches[i + 1].index ?? text.length : text.length;
    tokens.push({ key: canonical(matchText), value: text.slice(start, end).trim() });
  }
  return tokens;
}

function deglue(s: string): string {
  return s
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/,([A-Za-z])/g, ", $1")
    .replace(/([A-Za-z])(\d)/g, "$1 $2")
    .replace(/##:?/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function toISO(d?: string): string | undefined {
  if (!d) return undefined;
  const m = d.match(/(\d{1,2})\/(\d{1,2})\/(\d{2,4})/);
  if (!m) return undefined;
  const [, mo, da, rawYr] = m;
  const yr = rawYr.length === 2 ? "20" + rawYr : rawYr;
  return `${yr}-${mo.padStart(2, "0")}-${da.padStart(2, "0")}`;
}

function parseTickets(coverageValue: string): Ticket[] {
  const tickets: Ticket[] = [];
  const re =
    /([0-9][0-9A]{5,11})\s*(.+?)\s*(\d{2}-\d{2,3}-\d{2,3}|\d{3}\.\d+[A-Za-z0-9().]*)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(coverageValue)) !== null) {
    const violation = deglue(m[2]);
    if (!violation || violation.length > 70) continue;
    tickets.push({ number: m[1], violation, code: m[3] });
    if (tickets.length >= 6) break;
  }
  return tickets;
}

export function parseTvc(raw: string): { fields: ParsedLead; matchedCount: number } {
  const text = stripNoise(raw);
  const tokens = tokenize(text);
  const f: ParsedLead = {};

  const first = (key: string): string | undefined => {
    const v = tokens.find((t) => t.key === key && t.value)?.value;
    return v ? v.trim() : undefined;
  };
  const idxOf = (key: string) => tokens.findIndex((t) => t.key === key);

  const caseM = text.match(/TVC\s*Legal\s*Case:?\s*(\d+)/i);
  if (caseM) f.tvcCaseNumber = caseM[1];

  const bi = idxOf("birthdate");
  if (bi >= 0) {
    f.birthdate = tokens[bi].value.match(/[\d/]+/)?.[0];
    for (let i = bi - 1; i >= 0; i--) {
      if (tokens[i].key === "address" && !f.address) f.address = deglue(tokens[i].value);
      if (tokens[i].key === "member" && tokens[i].value) {
        f.name = tokens[i].value.replace(/\s+/g, " ").trim();
        break;
      }
    }
  }
  if (!f.name) f.name = first("member") || "Unknown";

  f.language = first("language")?.match(/[A-Za-z]+/)?.[0];
  f.driversLicense = first("dl")?.match(/[A-Za-z0-9]+/)?.[0];
  f.driversLicenseState = first("dlState")?.match(/[A-Z]{2}/)?.[0];
  f.driversLicenseType = first("dlType")?.replace(/\s+/g, " ").trim().slice(0, 12);
  f.email = first("emailAddr")?.match(/[\w.-]+@[\w.-]+/)?.[0];

  const memberMobile = tokens
    .filter((t) => t.key === "mobile")
    .map((t) => t.value)
    .find((v) => !/DO NOT/i.test(v));
  f.phone = (memberMobile || "").match(/\d{3}-\d{3}-\d{4}/)?.[0];

  f.vehicleType = first("vehicleType")?.match(/[A-Za-z]+/)?.[0];
  f.violationDate = first("violationDate")?.match(/[\d/]+/)?.[0];
  f.caseOpenedOn = first("caseOpened")?.match(/[\d/]+/)?.[0];

  f.courtName = text.match(/Court\s*Name\s*(.+?)\s*Phone/i)?.[1]?.replace(/\s+/g, " ").trim();
  f.courtPhone = text.match(/Court\s*Name.+?Phone\s*([\d-]{7,})/i)?.[1];
  const caddr = text.match(/Phone\s*[\d-]{7,}\s*Address\s*(.+?)\s*City/i)?.[1];
  if (caddr) f.courtAddress = deglue(caddr);
  f.courtCity = text
    .match(/City\s*(.+?)\s*County/i)?.[1]
    ?.replace(/^FLEET[\s-]+/i, "")
    .replace(/\s+/g, " ")
    .trim();
  const cs = text.match(/County\s*([A-Z][A-Za-z .]*?)\s*State\s*([A-Z]{2})/i);
  if (cs) {
    f.county = cs[1].trim();
    f.state = cs[2];
  }
  f.courtZip = text.match(/Zip\s*Code\s*(\d{5})/i)?.[1];

  const cd = first("courtDates");
  if (cd) {
    const dm = cd.match(
      /(\d{1,2}\/\d{1,2}\/\d{2,4})\s*(\d{1,2}:\d{2}\s*[AP]M)?\s*([A-Za-z][A-Za-z\- ]*)?/,
    );
    if (dm) {
      f.nextCourtDate = toISO(dm[1]);
      if (dm[2]) f.nextCourtTime = dm[2].replace(/\s+/g, " ").trim();
      if (dm[3]) f.nextCourtType = deglue(dm[3]).split(" ").slice(0, 3).join(" ");
    }
  }

  const cov = first("coverage");
  if (cov) {
    const tickets = parseTickets(cov);
    if (tickets.length) {
      f.tickets = tickets;
      f.charge = tickets.map((t) => t.violation).filter(Boolean).join("; ");
    }
  }

  const matchedCount = Object.values(f).filter(
    (v) => v !== undefined && v !== null && v !== "",
  ).length;

  return { fields: f, matchedCount };
}

// A TVC referral either has "TVC" in the subject, or comes from the TVC sender
// domain (e.g. tvc@prodriver.com) — some are forwarded with subjects like
// "Forwarded email". The LLM low-confidence check is a second safety net for
// stray emails that slip through.
export function isTvcReferral(subject: string, from = ""): boolean {
  return /\bTVC\b/i.test(subject) || /@prodriver\.com/i.test(from);
}
