import { jsPDF } from 'jspdf';

// Renders the intakeSheet callable's JSON into the "Let's make some money"
// PDF and triggers the browser download. Loaded on demand from CalendarView
// (dynamic import) so jsPDF stays out of the main bundle.

export interface SheetItem {
  lead_id?: string;
  name: string;
  phone: string;
  event: string;
  why_today: string;
  angle: string;
  opener: string;
  if_voicemail: string;
  watch_out?: string;
}

export interface IntakeSheet {
  headline: string;
  pep_talk: string;
  items: SheetItem[];
  closer: string;
}

// Letter-size coordinates (points).
const PAGE_W = 612;
const PAGE_H = 792;
const MARGIN = 54;
const CONTENT_W = PAGE_W - MARGIN * 2;
const BOTTOM = PAGE_H - 64;

const INK: [number, number, number] = [31, 41, 55]; // near-black
const SOFT: [number, number, number] = [107, 114, 128]; // gray
const MONEY: [number, number, number] = [22, 101, 52]; // deep green

export function downloadIntakeSheet(dateKey: string, sheet: IntakeSheet): void {
  const doc = new jsPDF({ unit: 'pt', format: 'letter' });
  let y = 0;

  const human = new Date(`${dateKey}T12:00:00`).toLocaleDateString('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  });

  const newPageIfNeeded = (needed: number) => {
    if (y + needed <= BOTTOM) return;
    doc.addPage();
    y = MARGIN;
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(9);
    doc.setTextColor(...SOFT);
    doc.text(`LET'S MAKE SOME MONEY — ${human.toUpperCase()}`, MARGIN, y);
    y += 18;
  };

  // Writes a labeled paragraph ("Why today: ...") with wrapping; returns used height.
  const para = (label: string, text: string, opts?: { italic?: boolean; color?: [number, number, number] }) => {
    const size = 10.5;
    const lineH = 14;
    doc.setFontSize(size);
    const labelW = doc.getTextWidth(`${label}  `) + 2;
    const lines = doc.splitTextToSize(text, CONTENT_W - labelW - 14) as string[];
    newPageIfNeeded(lines.length * lineH + 4);
    doc.setFont('helvetica', 'bold');
    doc.setTextColor(...(opts?.color ?? SOFT));
    doc.text(label, MARGIN + 14, y);
    doc.setFont('helvetica', opts?.italic ? 'italic' : 'normal');
    doc.setTextColor(...INK);
    lines.forEach((ln, i) => doc.text(ln, MARGIN + 14 + labelW, y + i * lineH));
    y += lines.length * lineH + 4;
  };

  // --- Header band ---
  y = MARGIN + 8;
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(26);
  doc.setTextColor(...MONEY);
  doc.text("LET'S MAKE SOME MONEY", MARGIN, y);
  y += 20;
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(11);
  doc.setTextColor(...SOFT);
  doc.text(`Intake Support Sheet — ${human} — Iron Rock Law Firm`, MARGIN, y);
  y += 12;
  doc.setDrawColor(...MONEY);
  doc.setLineWidth(1.5);
  doc.line(MARGIN, y, PAGE_W - MARGIN, y);
  y += 22;

  // --- Pep talk ---
  doc.setFont('helvetica', 'italic');
  doc.setFontSize(11.5);
  doc.setTextColor(...INK);
  const pep = doc.splitTextToSize(sheet.pep_talk, CONTENT_W) as string[];
  pep.forEach((ln, i) => doc.text(ln, MARGIN, y + i * 15));
  y += pep.length * 15 + 18;

  // --- Items ---
  sheet.items.forEach((item, idx) => {
    newPageIfNeeded(96);
    // checkbox
    doc.setDrawColor(...MONEY);
    doc.setLineWidth(1.2);
    doc.rect(MARGIN - 2, y - 9, 11, 11);
    // name + phone
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(13);
    doc.setTextColor(...INK);
    const title = `${idx + 1}.  ${item.name}`;
    doc.text(title, MARGIN + 16, y);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(11);
    doc.setTextColor(...MONEY);
    doc.text(item.phone || '', PAGE_W - MARGIN, y, { align: 'right' });
    y += 14;
    // event tag — wrapped so long motions notes can't run off the page edge
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(8.5);
    doc.setTextColor(...SOFT);
    const tag = doc.splitTextToSize(item.event.toUpperCase(), CONTENT_W - 16) as string[];
    tag.slice(0, 2).forEach((ln, i) => doc.text(ln, MARGIN + 16, y + i * 11));
    y += Math.min(tag.length, 2) * 11 + 6;

    para('Why today:', item.why_today);
    para('The angle:', item.angle);
    para('Say this:', `\u201C${item.opener}\u201D`, { italic: true, color: MONEY });
    para('Voicemail:', item.if_voicemail);
    if (item.watch_out) para('Watch out:', item.watch_out, { color: [180, 83, 9] });

    y += 6;
    if (idx < sheet.items.length - 1) {
      newPageIfNeeded(10);
      doc.setDrawColor(229, 231, 235);
      doc.setLineWidth(0.75);
      doc.line(MARGIN, y, PAGE_W - MARGIN, y);
      y += 16;
    }
  });

  // --- Closer ---
  newPageIfNeeded(40);
  y += 10;
  doc.setDrawColor(...MONEY);
  doc.setLineWidth(1.5);
  doc.line(MARGIN, y, PAGE_W - MARGIN, y);
  y += 18;
  doc.setFont('helvetica', 'bolditalic');
  doc.setFontSize(12);
  doc.setTextColor(...MONEY);
  const closer = doc.splitTextToSize(sheet.closer, CONTENT_W) as string[];
  closer.forEach((ln, i) => doc.text(ln, MARGIN, y + i * 16));

  // --- Page numbers ---
  const pages = doc.getNumberOfPages();
  for (let p = 1; p <= pages; p++) {
    doc.setPage(p);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(8.5);
    doc.setTextColor(...SOFT);
    doc.text(`Page ${p} of ${pages}`, PAGE_W - MARGIN, PAGE_H - 36, { align: 'right' });
    doc.text('TVCHub Intake Support Sheet', MARGIN, PAGE_H - 36);
  }

  doc.save(`intake-support-sheet-${dateKey}.pdf`);
}
