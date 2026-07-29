// src/lib/intakeSheetPdf.ts
import { jsPDF } from "jspdf";
var PAGE_W = 612;
var PAGE_H = 792;
var MARGIN = 54;
var CONTENT_W = PAGE_W - MARGIN * 2;
var BOTTOM = PAGE_H - 64;
var INK = [31, 41, 55];
var SOFT = [107, 114, 128];
var MONEY = [22, 101, 52];
function downloadIntakeSheet(dateKey, sheet) {
  const doc = new jsPDF({ unit: "pt", format: "letter" });
  let y = 0;
  const human = (/* @__PURE__ */ new Date(`${dateKey}T12:00:00`)).toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric"
  });
  const newPageIfNeeded = (needed) => {
    if (y + needed <= BOTTOM) return;
    doc.addPage();
    y = MARGIN;
    doc.setFont("helvetica", "bold");
    doc.setFontSize(9);
    doc.setTextColor(...SOFT);
    doc.text(`LET'S MAKE SOME MONEY \u2014 ${human.toUpperCase()}`, MARGIN, y);
    y += 18;
  };
  const para = (label, text, opts) => {
    const size = 10.5;
    const lineH = 14;
    doc.setFontSize(size);
    const labelW = doc.getTextWidth(`${label}  `) + 2;
    const lines = doc.splitTextToSize(text, CONTENT_W - labelW - 14);
    newPageIfNeeded(lines.length * lineH + 4);
    doc.setFont("helvetica", "bold");
    doc.setTextColor(...opts?.color ?? SOFT);
    doc.text(label, MARGIN + 14, y);
    doc.setFont("helvetica", opts?.italic ? "italic" : "normal");
    doc.setTextColor(...INK);
    lines.forEach((ln, i) => doc.text(ln, MARGIN + 14 + labelW, y + i * lineH));
    y += lines.length * lineH + 4;
  };
  y = MARGIN + 8;
  doc.setFont("helvetica", "bold");
  doc.setFontSize(26);
  doc.setTextColor(...MONEY);
  doc.text("LET'S MAKE SOME MONEY", MARGIN, y);
  y += 20;
  doc.setFont("helvetica", "normal");
  doc.setFontSize(11);
  doc.setTextColor(...SOFT);
  doc.text(`Intake Support Sheet \u2014 ${human} \u2014 Iron Rock Law Firm`, MARGIN, y);
  y += 12;
  doc.setDrawColor(...MONEY);
  doc.setLineWidth(1.5);
  doc.line(MARGIN, y, PAGE_W - MARGIN, y);
  y += 22;
  doc.setFont("helvetica", "italic");
  doc.setFontSize(11.5);
  doc.setTextColor(...INK);
  const pep = doc.splitTextToSize(sheet.pep_talk, CONTENT_W);
  pep.forEach((ln, i) => doc.text(ln, MARGIN, y + i * 15));
  y += pep.length * 15 + 18;
  sheet.items.forEach((item, idx) => {
    newPageIfNeeded(96);
    doc.setDrawColor(...MONEY);
    doc.setLineWidth(1.2);
    doc.rect(MARGIN - 2, y - 9, 11, 11);
    doc.setFont("helvetica", "bold");
    doc.setFontSize(13);
    doc.setTextColor(...INK);
    const title = `${idx + 1}.  ${item.name}`;
    doc.text(title, MARGIN + 16, y);
    doc.setFont("helvetica", "normal");
    doc.setFontSize(11);
    doc.setTextColor(...MONEY);
    doc.text(item.phone || "", PAGE_W - MARGIN, y, { align: "right" });
    y += 14;
    doc.setFont("helvetica", "bold");
    doc.setFontSize(8.5);
    doc.setTextColor(...SOFT);
    const tag = doc.splitTextToSize(item.event.toUpperCase(), CONTENT_W - 16);
    tag.slice(0, 2).forEach((ln, i) => doc.text(ln, MARGIN + 16, y + i * 11));
    y += Math.min(tag.length, 2) * 11 + 6;
    para("Why today:", item.why_today);
    para("The angle:", item.angle);
    para("Say this:", `\u201C${item.opener}\u201D`, { italic: true, color: MONEY });
    para("Voicemail:", item.if_voicemail);
    if (item.watch_out) para("Watch out:", item.watch_out, { color: [180, 83, 9] });
    y += 6;
    if (idx < sheet.items.length - 1) {
      newPageIfNeeded(10);
      doc.setDrawColor(229, 231, 235);
      doc.setLineWidth(0.75);
      doc.line(MARGIN, y, PAGE_W - MARGIN, y);
      y += 16;
    }
  });
  newPageIfNeeded(40);
  y += 10;
  doc.setDrawColor(...MONEY);
  doc.setLineWidth(1.5);
  doc.line(MARGIN, y, PAGE_W - MARGIN, y);
  y += 18;
  doc.setFont("helvetica", "bolditalic");
  doc.setFontSize(12);
  doc.setTextColor(...MONEY);
  const closer = doc.splitTextToSize(sheet.closer, CONTENT_W);
  closer.forEach((ln, i) => doc.text(ln, MARGIN, y + i * 16));
  const pages = doc.getNumberOfPages();
  for (let p = 1; p <= pages; p++) {
    doc.setPage(p);
    doc.setFont("helvetica", "normal");
    doc.setFontSize(8.5);
    doc.setTextColor(...SOFT);
    doc.text(`Page ${p} of ${pages}`, PAGE_W - MARGIN, PAGE_H - 36, { align: "right" });
    doc.text("TVCHub Intake Support Sheet", MARGIN, PAGE_H - 36);
  }
  doc.save(`intake-support-sheet-${dateKey}.pdf`);
}
export {
  downloadIntakeSheet
};
