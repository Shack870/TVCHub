import type { Lead, Ticket } from '../types';

// Pure spatial-reconstruction logic for TVC referral PDFs. Kept free of any
// pdf.js import so it can be unit-tested in Node. `pdfParse.ts` feeds it the
// extracted text cells.

export interface Cell {
  page: number;
  x: number; // left edge
  y: number; // baseline (higher = nearer top)
  w: number;
  str: string;
}

interface Anchor {
  key: string;
  page: number;
  x: number;
  yTop: number;
  yBot: number;
}

const LABELS: { key: string; re: RegExp }[] = [
  { key: 'examinationReport', re: /^Examination Report Received$/i },
  { key: 'accidentInvolved', re: /^Accident Involved$/i },
  { key: 'preExisting', re: /^Pre-?\s?Existing$/i },
  { key: 'movingViolation', re: /^Moving Violation$/i },
  { key: 'caseOpenedOn', re: /^Case Opened on$/i },
  { key: 'violationDate', re: /^Violation Date$/i },
  { key: 'vehicleType', re: /^Vehicle Type$/i },
  { key: 'coverage', re: /^Case Coverage Type$/i },
  { key: 'famName', re: /^Family Member Name$/i },
  { key: 'famRel', re: /^Family Member Relationship$/i },
  { key: 'famMember', re: /^Family Member$/i },
  { key: 'dlType', re: /^Driver'?s License Type$/i },
  { key: 'dlState', re: /^Driver'?s License State$/i },
  { key: 'dl', re: /^Driver'?s License$/i },
  { key: 'language', re: /^Preferred Language$/i },
  { key: 'email', re: /^E-?mail Address$/i },
  { key: 'attorneyEmail', re: /^E-?mail$/i },
  { key: 'birthdate', re: /^Birthdate$/i },
  { key: 'courtZip', re: /^Zip Code$/i },
  { key: 'courtName', re: /^Court Name$/i },
  { key: 'lawType', re: /^Law Type$/i },
  { key: 'phone', re: /^Phone$/i },
  { key: 'mobile', re: /^Mobile$/i },
  { key: 'fax', re: /^Fax$/i },
  { key: 'firm', re: /^Firm$/i },
  { key: 'attorney', re: /^Attorney$/i },
  { key: 'member', re: /^Member$/i },
  { key: 'address', re: /^Address$/i },
  { key: 'city', re: /^City$/i },
  { key: 'county', re: /^County$/i },
  { key: 'state', re: /^State$/i },
];

const FIELD_KEYS = new Set([
  'examinationReport', 'accidentInvolved', 'preExisting', 'movingViolation',
  'caseOpenedOn', 'violationDate', 'vehicleType', 'dlType', 'dlState', 'dl',
  'language', 'email', 'birthdate', 'courtZip', 'courtName', 'phone', 'mobile',
  'member', 'address', 'city', 'county', 'state',
  // Attorney Info + Ticket Info + notes
  'attorney', 'firm', 'fax', 'lawType', 'attorneyEmail', 'famName', 'famRel',
]);

const NOISE = /mail\.google|ironrocklaw\.com Mail|attachments contains|^https?:|^\d\/\d$|prodriver\.com|\.pdf$|^\d+K$/i;

function labelKey(text: string): string | null {
  const t = text.replace(/\s+/g, ' ').trim();
  for (const l of LABELS) if (l.re.test(t)) return l.key;
  return null;
}

function deglue(s: string): string {
  return s.replace(/##:?/g, '').replace(/\s+/g, ' ').trim();
}

function toISO(d?: string): string | undefined {
  if (!d) return undefined;
  const m = d.match(/(\d{1,2})\/(\d{1,2})\/(\d{2,4})/);
  if (!m) return undefined;
  const [, mo, da, rawYr] = m;
  const yr = rawYr.length === 2 ? '20' + rawYr : rawYr;
  return `${yr}-${mo.padStart(2, '0')}-${da.padStart(2, '0')}`;
}

interface PairResult {
  key: string;
  page: number;
  y: number;
  value: string;
}

function pairFields(cells: Cell[]): PairResult[] {
  const results: PairResult[] = [];
  const pages = [...new Set(cells.map((c) => c.page))];

  for (const pg of pages) {
    const pageCells = cells
      .filter((c) => c.page === pg && c.str.length <= 45 && !NOISE.test(c.str))
      .sort((a, b) => b.y - a.y || a.x - b.x);

    const consumed = new Set<Cell>();
    const anchors: Anchor[] = [];

    for (let i = 0; i < pageCells.length; i++) {
      const c = pageCells[i];
      if (consumed.has(c)) continue;
      const below = pageCells.find(
        (d) =>
          !consumed.has(d) &&
          d !== c &&
          Math.abs(d.x - c.x) <= 10 &&
          c.y - d.y > 4 &&
          c.y - d.y <= 16,
      );
      if (below) {
        const merged = labelKey(`${c.str} ${below.str}`);
        if (merged) {
          anchors.push({ key: merged, page: pg, x: c.x, yTop: c.y, yBot: below.y });
          consumed.add(c);
          consumed.add(below);
          continue;
        }
      }
      const solo = labelKey(c.str);
      if (solo) {
        anchors.push({ key: solo, page: pg, x: c.x, yTop: c.y, yBot: c.y });
        consumed.add(c);
      }
    }

    const valueCells = pageCells.filter((c) => !consumed.has(c));
    const paired = new Map<Cell, Anchor>();
    for (const v of valueCells) {
      let best: Anchor | null = null;
      for (const a of anchors) {
        const yc = (a.yTop + a.yBot) / 2;
        // Value must be to the right of its label, on the same row, and within
        // the same column block (cap prevents the ticket table from binding to
        // a far-left label across the page gap).
        if (a.x < v.x && v.x - a.x <= 160 && Math.abs(yc - v.y) <= 12) {
          if (!best || a.x > best.x) best = a;
        }
      }
      if (best) paired.set(v, best);
    }
    // Continuation rows (e.g. the 2nd line of an address): group the still
    // unpaired value cells into rows and attach each row to the anchor of the
    // paired value directly above the row's column.
    const unpaired = valueCells.filter((c) => !paired.has(c));
    const rows: Cell[][] = [];
    for (const v of unpaired.sort((a, b) => b.y - a.y || a.x - b.x)) {
      let row = rows.find((r) => Math.abs(r[0].y - v.y) <= 3);
      if (!row) {
        row = [];
        rows.push(row);
      }
      row.push(v);
    }
    for (const row of rows) {
      const colX = Math.min(...row.map((c) => c.x));
      const above = valueCells
        .filter(
          (d) => paired.has(d) && Math.abs(d.x - colX) <= 20 && d.y > row[0].y && d.y - row[0].y <= 40,
        )
        .sort((a, b) => a.y - b.y)[0];
      if (above) for (const c of row) paired.set(c, paired.get(above)!);
    }

    const byAnchor = new Map<Anchor, Cell[]>();
    for (const [v, a] of paired) {
      if (!FIELD_KEYS.has(a.key)) continue;
      const arr = byAnchor.get(a) ?? [];
      arr.push(v);
      byAnchor.set(a, arr);
    }
    for (const [a, vs] of byAnchor) {
      vs.sort((x, y) => y.y - x.y || x.x - y.x);
      results.push({
        key: a.key,
        page: a.page,
        y: a.yTop,
        value: deglue(vs.map((v) => v.str).join(' ')),
      });
    }
  }
  return results;
}

function extractTickets(cells: Cell[]): Ticket[] {
  const header = (re: RegExp, fb: number) => cells.find((c) => re.test(c.str))?.x ?? fb;
  const numberX = header(/^Number$/i, 334);
  const violationX = header(/^Violation$/i, 412);
  const codeX = header(/^Code$/i, 503);

  const numbers = cells
    .filter((c) => /^[0-9][0-9A]{5,11}$/.test(c.str) && Math.abs(c.x - numberX) <= 30)
    .sort((a, b) => b.y - a.y);

  const near = (page: number, xCenter: number, xTol: number, y: number) =>
    cells
      .filter(
        (c) => c.page === page && Math.abs(c.x - xCenter) <= xTol && Math.abs(c.y - y) <= 18,
      )
      .sort((a, b) => b.y - a.y)
      .map((c) => c.str)
      .join(' ');

  const tickets: Ticket[] = [];
  for (const n of numbers) {
    const violation = deglue(near(n.page, violationX + 20, 60, n.y));
    const code = deglue(near(n.page, codeX, 30, n.y)).replace(/\s+/g, '');
    tickets.push({ number: n.str, violation: violation || undefined, code: code || undefined });
    if (tickets.length >= 6) break;
  }
  return tickets;
}

function extractCourtDate(cells: Cell[]): { date?: string; time?: string; type?: string } {
  for (const c of cells) {
    if (!/^\d{1,2}\/\d{1,2}\/\d{4}$/.test(c.str)) continue;
    const row = cells
      .filter((d) => d.page === c.page && Math.abs(d.y - c.y) <= 4)
      .sort((a, b) => a.x - b.x);
    const timeCell = row.find((d) => /^\d{1,2}:\d{2}\s*[AP]M$/i.test(d.str));
    if (!timeCell) continue;
    const typeCell = row.find((d) => d.x > timeCell.x && /[A-Za-z]/.test(d.str));
    return {
      date: toISO(c.str),
      time: timeCell.str.replace(/\s+/g, ' '),
      type: typeCell?.str.replace(/\s+/g, ' '),
    };
  }
  return {};
}

const NOTE_STOP =
  /\[Quoted text hidden\]|^3 attachments|^From:|^To:|^Sent:|^Subject:|^Cc:|John McGinnes <|Jody Shackelford <|Thank you|Fleet Legal Admin|North May Avenue|^\d+K$|\.pdf$/i;

// Reconstructs the "Description / Entry / Date" activity log into readable lines.
function extractNotes(cells: Cell[]): string {
  const desc = cells.find((c) => /^Description$/i.test(c.str));
  if (!desc) return '';
  const pages = [...new Set(cells.map((c) => c.page))].filter((p) => p >= desc.page).sort((a, b) => a - b);
  const out: string[] = [];

  for (const pg of pages) {
    const rel = cells.filter(
      (c) =>
        c.page === pg &&
        !NOISE.test(c.str) &&
        (pg > desc.page || c.y < desc.y - 5),
    );
    // group into rows
    const rows: Cell[][] = [];
    for (const c of rel.sort((a, b) => b.y - a.y || a.x - b.x)) {
      let row = rows.find((r) => Math.abs(r[0].y - c.y) <= 3);
      if (!row) {
        row = [];
        rows.push(row);
      }
      row.push(c);
    }
    for (const row of rows) {
      const text = row
        .sort((a, b) => a.x - b.x)
        .map((c) => c.str)
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim();
      if (!text || /^(Description|Entry|Date)$/i.test(text)) continue;
      if (/^\d{1,2}\/\d{1,2}\/\d{2,4},?\s*\d{1,2}:\d{2}\s*[AP]M/i.test(text)) continue;
      if (NOTE_STOP.test(text)) return out.join('\n').trim();
      out.push(text);
    }
  }
  return out.join('\n').trim();
}

export interface ParseResult {
  fields: Partial<Lead>;
  matchedCount: number;
  rawText: string;
}

export function assembleFields(cells: Cell[]): ParseResult {
  const pairs = pairFields(cells);
  const f: Partial<Lead> = {};

  const pick = (key: string, page?: number) =>
    pairs.find((p) => p.key === key && (page === undefined || p.page === page))?.value;
  const all = (key: string) => pairs.filter((p) => p.key === key);

  const joined = cells.map((c) => c.str).join(' ');
  const caseM = joined.match(/TVC\s*Legal\s*Case:?\s*(\d+)/i);
  if (caseM) f.tvcCaseNumber = caseM[1];

  const birth = pairs.find((p) => p.key === 'birthdate');
  const memberPage = birth?.page;
  f.birthdate = birth?.value.match(/[\d/]+/)?.[0];
  f.name = pick('member', memberPage) || pick('member');
  f.address = pick('address', memberPage);
  f.language = pick('language', memberPage)?.match(/[A-Za-z]+/)?.[0];
  f.driversLicense = pick('dl', memberPage)?.match(/[A-Za-z0-9]+/)?.[0];
  f.driversLicenseState = pick('dlState', memberPage)?.match(/[A-Z]{2}/)?.[0];
  f.driversLicenseType = pick('dlType', memberPage);
  f.email = pick('email', memberPage)?.match(/[\w.-]+@[\w.-]+/)?.[0];
  f.vehicleType = pick('vehicleType')?.match(/[A-Za-z]+/)?.[0];
  f.violationDate = pick('violationDate')?.match(/[\d/]+/)?.[0];
  f.caseOpenedOn = pick('caseOpenedOn')?.match(/[\d/]+/)?.[0];

  const mobile = all('mobile').find((m) => !/DO NOT/i.test(m.value))?.value;
  f.phone = mobile?.match(/\d{3}-\d{3}-\d{4}/)?.[0];

  // Ticket Info (referral metadata).
  f.familyMemberName = pick('famName');
  f.familyMemberRelationship = pick('famRel');

  // Attorney Info (our firm) lives on the page containing "Firm".
  const firmP = pairs.find((p) => p.key === 'firm');
  const attorneyPage = firmP?.page;
  f.attorneyNames = pick('attorney', attorneyPage);
  f.firmName = firmP?.value;
  f.firmAddress = pick('address', attorneyPage);
  f.firmPhone = pick('phone', attorneyPage)?.match(/\d{3}-\d{3}-\d{4}/)?.[0];
  f.firmFax = pick('fax', attorneyPage)?.match(/\d{3}-\d{3}-\d{4}/)?.[0];
  f.attorneyMobile = all('mobile').find((m) => /DO NOT/i.test(m.value))?.value.match(/\d{3}-\d{3}-\d{4}/)?.[0];
  f.attorneyEmail = pick('attorneyEmail', attorneyPage);
  f.lawType = pick('lawType', attorneyPage)?.match(/[A-Za-z]+/)?.[0];

  const courtNameP = pairs.find((p) => p.key === 'courtName');
  const courtPage = courtNameP?.page;
  f.courtName = courtNameP?.value;
  f.courtPhone = pick('phone', courtPage)?.match(/\d{3}-\d{3}-\d{4}/)?.[0];
  f.courtAddress = pick('address', courtPage);
  f.courtCity = pick('city', courtPage)?.replace(/^FLEET[\s-]+/i, '');
  f.county = pick('county', courtPage)?.match(/[A-Za-z .]+/)?.[0].trim();
  f.state = pick('state', courtPage)?.match(/[A-Z]{2}/)?.[0];
  f.courtZip = pick('courtZip', courtPage)?.match(/\d{5}/)?.[0];

  f.movingViolation = pick('movingViolation', courtPage);
  f.preExisting = pick('preExisting', courtPage);
  f.accidentInvolved = pick('accidentInvolved', courtPage);
  f.examinationReport = pick('examinationReport', courtPage);

  const cd = extractCourtDate(cells);
  if (cd.date) {
    f.nextCourtDate = cd.date;
    f.nextCourtTime = cd.time;
    f.nextCourtType = cd.type;
  }

  const tickets = extractTickets(cells);
  if (tickets.length) {
    f.tickets = tickets;
    f.charge = tickets.map((t) => t.violation).filter(Boolean).join('; ');
  }

  const notes = extractNotes(cells);
  if (notes) f.tvcNotes = notes;

  const matchedCount = Object.values(f).filter(
    (v) => v !== undefined && v !== null && v !== '',
  ).length;

  return { fields: f, matchedCount, rawText: joined };
}
