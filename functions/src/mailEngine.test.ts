import { describe, expect, it } from "vitest";
import {
  COURT_DATE_BOX_TOKEN,
  leadMailFacts,
  letterBlockReason,
  letterEditableText,
  letterPreviewText,
  lostReasonIsResolved,
  parseMailAddress,
  proposeLetter,
  renderLetterFromText,
  renderLetterHtml,
  titleCaseName,
  type LetterHistoryFacts,
} from "./mailEngine.js";

const TODAY = "2026-07-30";
const NOW = new Date(`${TODAY}T12:00:00-05:00`).getTime();
const DAY = 86400_000;

const freshHistory = (): LetterHistoryFacts => ({
  introSentAt: null,
  sentCount: 0,
  lastSentAt: null,
  sentKeys: new Set(),
});

// A mail-eligible baseline lead: active, addressed, never conversed.
const lead = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  name: "VISHUN PAL",
  stage: "callback",
  address: "400 W. Gettysburg Ave Apt 223A, Clovis, CA 93612",
  receivedAt: NOW - 5 * DAY,
  contactAttempts: [{ ts: NOW - 4 * DAY, outcome: "voicemail" }],
  followUps: [],
  ...over,
});

// ---------- Address parsing ----------

describe("parseMailAddress", () => {
  it("parses the standard TVC one-line shape", () => {
    expect(parseMailAddress("5245 LEXMARK CIR SW, ATLANTA, GA 30331")).toEqual({
      line1: "5245 LEXMARK CIR SW",
      city: "ATLANTA",
      provinceOrState: "GA",
      postalOrZip: "30331",
    });
  });

  it("handles apartment suffixes and zip+4", () => {
    expect(parseMailAddress("10300 Devonshire Circle Apt E223, Bloomington, MN 55431-1234")).toEqual({
      line1: "10300 Devonshire Circle Apt E223",
      city: "Bloomington",
      provinceOrState: "MN",
      postalOrZip: "55431-1234",
    });
  });

  it("rejects junk — a half address is a dollar mailed to nowhere", () => {
    expect(parseMailAddress("")).toBeNull();
    expect(parseMailAddress(undefined)).toBeNull();
    expect(parseMailAddress("Clovis CA")).toBeNull();
    expect(parseMailAddress("no address given")).toBeNull();
  });
});

// ---------- Lost-reason triage ----------

describe("lostReasonIsResolved", () => {
  it("hired counsel / paid it / handled it → permanent stop", () => {
    expect(lostReasonIsResolved("Hired another attorney")).toBe(true);
    expect(lostReasonIsResolved("says he already paid the citation")).toBe(true);
    expect(lostReasonIsResolved("took care of it himself")).toBe(true);
    expect(lostReasonIsResolved("case dismissed")).toBe(true);
    expect(lostReasonIsResolved("do not contact")).toBe(true);
  });

  it("a plain decline keeps the free-reminder door open", () => {
    expect(lostReasonIsResolved("not interested")).toBe(false);
    expect(lostReasonIsResolved("too expensive")).toBe(false);
    expect(lostReasonIsResolved("")).toBe(false);
    expect(lostReasonIsResolved(undefined)).toBe(false);
  });
});

// ---------- Suppression ----------

describe("letterBlockReason", () => {
  it("clean active lead is mailable", () => {
    expect(letterBlockReason(lead(), "intro", TODAY)).toBeNull();
  });

  it("retained clients are never mailed a pitch", () => {
    expect(letterBlockReason(lead({ saleStatus: "paid_full" }), "intro", TODAY)).toMatch(/retained/);
    expect(letterBlockReason(lead({ stage: "financed" }), "court_week", TODAY)).toMatch(/retained/);
    expect(letterBlockReason(lead({ stage: "intake_complete" }), "motions", TODAY)).toMatch(/retained/);
    expect(letterBlockReason(lead({ retainedAt: NOW }), "intro", TODAY)).toMatch(/retained/);
  });

  it("promised money is a phone job", () => {
    expect(letterBlockReason(lead({ saleStatus: "promised_unpaid" }), "intro", TODAY)).toMatch(/phone/);
  });

  it("resolved/represented lost leads are silent forever; plain declines get reminders only", () => {
    const hired = lead({ stage: "lost", lostReason: "hired another attorney" });
    expect(letterBlockReason(hired, "court_week", TODAY)).toMatch(/resolved or represented/);
    const declined = lead({ stage: "lost", lostReason: "not interested" });
    expect(letterBlockReason(declined, "court_week", TODAY)).toBeNull();
    expect(letterBlockReason(declined, "intro", TODAY)).toMatch(/reminders only/);
    expect(letterBlockReason(declined, "motions", TODAY)).toMatch(/reminders only/);
  });

  it("identity, existing-client, opt-out, and returned-mail flags all stop mail", () => {
    expect(letterBlockReason(lead({ needsReview: true }), "intro", TODAY)).toMatch(/unverified/);
    expect(letterBlockReason(lead({ possibleExistingClientAt: NOW }), "intro", TODAY)).toMatch(/existing client/);
    expect(letterBlockReason(lead({ mailOptOut: true }), "intro", TODAY)).toMatch(/do-not-mail/);
    expect(letterBlockReason(lead({ mailReturnedAt: NOW }), "intro", TODAY)).toMatch(/bad address/);
    expect(letterBlockReason(lead({ caseDismissed: true }), "intro", TODAY)).toMatch(/dismissed/);
    expect(letterBlockReason(lead({ stage: "attorney_call" }), "intro", TODAY)).toMatch(/attorney/);
  });

  it("no parseable address blocks everything", () => {
    expect(letterBlockReason(lead({ address: "" }), "intro", TODAY)).toMatch(/no mailable address/);
  });

  it("mail physics: court too close blocks slow letters but not court_passed", () => {
    const close = lead({ nextCourtDate: "2026-08-04" }); // 5 days out
    expect(letterBlockReason(close, "intro", TODAY)).toMatch(/too close for mail/);
    expect(letterBlockReason(close, "court_week", TODAY)).toMatch(/too close for mail/);
    const passed = lead({ nextCourtDate: "2026-07-25" });
    expect(letterBlockReason(passed, "court_passed", TODAY)).toBeNull();
  });
});

// ---------- Triggers ----------

describe("proposeLetter", () => {
  it("never-conversed lead with a failed attempt gets the intro letter", () => {
    const p = proposeLetter(lead(), null, freshHistory(), TODAY, NOW);
    expect(p?.type).toBe("intro");
    expect(p?.dedupeKey).toBe("intro:once");
  });

  it("second chase fires 12+ days after the intro mailed, never before", () => {
    const early = { ...freshHistory(), introSentAt: NOW - 5 * DAY, sentCount: 1, lastSentAt: NOW - 5 * DAY, sentKeys: new Set(["intro:once"]) };
    expect(proposeLetter(lead(), null, early, TODAY, NOW)).toBeNull();
    const ripe = { ...early, introSentAt: NOW - 13 * DAY, lastSentAt: NOW - 13 * DAY };
    expect(proposeLetter(lead(), null, ripe, TODAY, NOW)?.type).toBe("second_chase");
  });

  it("a thinking conversation two days quiet gets the recap letter", () => {
    const l = lead({
      contactAttempts: [{ ts: NOW - 3 * DAY, outcome: "thinking" }],
    });
    const p = proposeLetter(l, null, freshHistory(), TODAY, NOW);
    expect(p?.type).toBe("thinking");
    // Keyed to the conversation day — a NEW thinking call re-arms a new letter.
    expect(p?.dedupeKey).toMatch(/^thinking:2026-07-27$/);
  });

  it("motions letter fires in the send window before the deadline", () => {
    const l = lead({ nextCourtDate: "2026-09-15" });
    const ddl = { date: "2026-08-11", passed: false }; // 12 days out
    expect(proposeLetter(l, ddl, freshHistory(), TODAY, NOW)?.type).toBe("motions");
    // Too far out: not yet.
    const far = { date: "2026-08-30", passed: false };
    expect(proposeLetter(l, far, freshHistory(), TODAY, NOW)?.type).not.toBe("motions");
  });

  it("deadline passed + court still mailable = the late-continuance variant", () => {
    const l = lead({ nextCourtDate: "2026-08-14" }); // 15 days out
    const ddl = { date: "2026-07-25", passed: true };
    const p = proposeLetter(l, ddl, freshHistory(), TODAY, NOW);
    expect(p?.type).toBe("motions_late");
    expect(p?.dedupeKey).toBe("motions_late:2026-08-14");
  });

  it("court_week fires ~14 days out, and for exposed lost leads too", () => {
    const l = lead({
      stage: "lost",
      lostReason: "not interested",
      nextCourtDate: "2026-08-13", // 14 days
      contactAttempts: [{ ts: NOW - 20 * DAY, outcome: "declined" }],
    });
    expect(proposeLetter(l, null, freshHistory(), TODAY, NOW)?.type).toBe("court_week");
  });

  it("court passed 2+ days ago beats everything else", () => {
    const l = lead({ nextCourtDate: "2026-07-27" }); // 3 days ago
    const p = proposeLetter(l, null, freshHistory(), TODAY, NOW);
    expect(p?.type).toBe("court_passed");
  });

  it("frequency caps: weekly gap and lifetime maximum", () => {
    const recent = { ...freshHistory(), sentCount: 1, lastSentAt: NOW - 2 * DAY };
    expect(proposeLetter(lead(), null, recent, TODAY, NOW)).toBeNull();
    const capped = { ...freshHistory(), sentCount: 6, lastSentAt: NOW - 30 * DAY };
    expect(proposeLetter(lead(), null, capped, TODAY, NOW)).toBeNull();
  });

  it("a dedupe key already raised is never raised again", () => {
    const h = { ...freshHistory(), sentKeys: new Set(["intro:once"]) };
    expect(proposeLetter(lead(), null, h, TODAY, NOW)).toBeNull();
  });

  it("a court date change re-arms milestone letters via new keys", () => {
    const h = { ...freshHistory(), sentKeys: new Set(["court_week:2026-08-13"]) };
    const moved = lead({
      nextCourtDate: "2026-08-12", // 13 days out — inside the window, new date
      contactAttempts: [{ ts: NOW - 20 * DAY, outcome: "spoke" }],
    });
    const p = proposeLetter(moved, null, h, TODAY, NOW);
    expect(p?.type).toBe("court_week");
    expect(p?.dedupeKey).toBe("court_week:2026-08-12");
  });
});

// ---------- Facts + rendering ----------

describe("leadMailFacts", () => {
  it("a voicemail is not a conversation", () => {
    const f = leadMailFacts(lead());
    expect(f.hadConversation).toBe(false);
    expect(f.attemptCount).toBe(1);
  });

  it("reads thinking from the outcome or the call AI", () => {
    const viaAi = leadMailFacts(
      lead({ contactAttempts: [{ ts: NOW - DAY, outcome: "spoke", ai: { pitchResult: "thinking" } }] }),
    );
    expect(viaAi.lastConversationWasThinking).toBe(true);
  });
});

describe("rendering", () => {
  it("title-cases shouting names for the salutation", () => {
    expect(titleCaseName("VISHUN PAL")).toBe("Vishun Pal");
    expect(titleCaseName("Au'Quincy Davis")).toBe("Au'quincy Davis");
  });

  it("every letter renders with the compliance footer and the phone number", () => {
    const vars = {
      name: "MARKO WACIBA",
      tvcNumber: "1565395",
      courtDate: "Monday, August 24, 2026",
      courtTime: "9:00 AM",
      courtName: "Benton District Court",
      county: "Saline",
      stateName: "Arkansas",
      deadlineDate: "Friday, August 14, 2026",
    };
    for (const t of ["intro", "second_chase", "thinking", "motions", "motions_late", "court_week", "court_passed"] as const) {
      const html = renderLetterHtml(t, vars, "Thursday, July 30, 2026");
      expect(html).toContain("ADVERTISING MATERIAL");
      // The no-relationship-until-retained statement rides on every letter.
      expect(html).toContain("No attorney&ndash;client relationship");
      expect(html).toContain("870-399-1440");
      expect(html).toContain("Warm hello Marko Waciba");
      // Every letter names the referral source and their TVC number.
      expect(html).toContain("TVC Pro-Driver");
      expect(html).not.toContain("Truckers Voice");
      expect(html).toContain("#1565395");
      // The design contract: letterhead image (15% wider than the text
      // column), US Letter with 1in margins, half-inch first-line indents,
      // serif web font, signature block at the 4in mark, and a situation-
      // tuned P.S. as the last words.
      expect(html).toContain("letterhead.png");
      expect(html).toContain("width:7in");
      // 0.5in hard page margin + 0.5in body padding = true 1in text margins,
      // with only the letterhead allowed into the extra half inch.
      expect(html).toContain("size: letter; margin: 0.5in");
      expect(html).toContain("padding: 0.5in 0.5in 0 0.5in");
      expect(html).toContain("text-indent:0.5in");
      expect(html).toContain("PT+Serif");
      expect(html).toContain("margin:14px 0 0 3.75in");
      expect(html).toContain("P.S.");
      const preview = letterPreviewText(t, vars);
      expect(preview.length).toBeGreaterThan(100);
      expect(preview).not.toContain("<");
    }
  });

  it("the warrant letter only ever says MAY have issued", () => {
    const html = renderLetterHtml("court_passed", { name: "X Y", stateName: "Arkansas" }, "Jul 30");
    expect(html).toMatch(/may have issued/);
    expect(html).not.toMatch(/warrant (was|has been) issued/i);
  });

  it("editable text round-trips: box token where the box belongs, markers render bold", () => {
    const vars = {
      name: "MARKO WACIBA",
      courtDate: "Monday, August 24, 2026",
      stateName: "Arkansas",
    };
    const introText = letterEditableText("intro", vars);
    expect(introText).toContain(COURT_DATE_BOX_TOKEN);
    expect(introText).toContain("**TVC Pro-Driver**");
    // Thinking letter deliberately has no box (runs past one page with it).
    expect(letterEditableText("thinking", vars)).not.toContain(COURT_DATE_BOX_TOKEN);
    // The stock render IS the rendered editable text.
    expect(renderLetterHtml("intro", vars, "Jul 30")).toBe(
      renderLetterFromText(introText, "intro", vars, "Jul 30"),
    );
  });

  it("renders reviewer-edited text: custom words, bold, P.S. below signature, box honored", () => {
    const vars = { name: "X Y", courtDate: "Monday, August 24, 2026", stateName: "Arkansas" };
    const edited = [
      "Totally custom opener with a **bold promise**.",
      COURT_DATE_BOX_TOKEN,
      "P.S. Custom postscript.",
    ].join("\n\n");
    const html = renderLetterFromText(edited, "intro", vars, "Jul 30");
    expect(html).toContain("Totally custom opener with a <b>bold promise</b>.");
    expect(html).toContain("border:3px solid"); // the box rendered
    // The P.S. sits after the signature block.
    expect(html.indexOf("Custom postscript")).toBeGreaterThan(html.indexOf("Sincerely,"));
    // Deleting the box token removes the box entirely.
    expect(renderLetterFromText("Just words.", "intro", vars, "Jul 30")).not.toContain(
      "border:3px solid",
    );
    // HTML in edited text is escaped, never injected.
    expect(renderLetterFromText("<script>alert(1)</script>", "intro", vars, "Jul 30")).not.toContain(
      "<script>",
    );
  });

  it("free reminders shout that we are NOT retained; pitch letters don't", () => {
    const vars = { name: "X Y", stateName: "Arkansas", courtDate: "Monday, August 24, 2026" };
    expect(renderLetterHtml("court_week", vars, "Jul 30")).toContain(
      "WE HAVE NOT BEEN RETAINED ON YOUR CASE YET, AND WE WILL NOT APPEAR ON YOUR BEHALF ON MONDAY, AUGUST 24, 2026",
    );
    expect(renderLetterHtml("court_passed", vars, "Jul 30")).toContain(
      "We have not been retained on your case, and we will not take any action on your behalf unless properly retained.",
    );
    expect(renderLetterHtml("intro", vars, "Jul 30")).not.toContain("WE HAVE NOT BEEN RETAINED");
  });
});
