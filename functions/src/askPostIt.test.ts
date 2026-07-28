import { describe, expect, it } from "vitest";
import {
  buildContext,
  fmtChicago,
  historyMessages,
  serializeAttempt,
  serializeLead,
  serializeMessage,
} from "./askPostIt.js";

// 2026-07-10 14:30:00 UTC = 9:30 AM Chicago (CDT).
const TS = Date.UTC(2026, 6, 10, 14, 30, 0);

describe("fmtChicago", () => {
  it("renders epoch ms in Chicago time", () => {
    expect(fmtChicago(TS)).toBe("Jul 10, 2026, 9:30 AM");
  });
  it("tolerates garbage", () => {
    expect(fmtChicago(undefined)).toBe("unknown");
    expect(fmtChicago("nope")).toBe("unknown");
    expect(fmtChicago(0)).toBe("unknown");
  });
});

describe("serializeAttempt", () => {
  it("carries timestamp, outcome, via, notes and the full AI analysis", () => {
    const s = serializeAttempt({
      ts: TS,
      outcome: "verbal_yes",
      via: "callrail",
      by: "CallRail sync",
      notes: "Outbound call via CallRail — 12m 4s.",
      durationSec: 724,
      ai: {
        connection: "conversation",
        pitched: true,
        pitchResult: "bought",
        summary: "Agreed to retain; will pay Friday.",
        saleStatus: "promised_unpaid",
        saleAmount: 1125,
        paymentPromise: "will pay Friday after payday",
        nonPaymentReason: "Gets paid Friday and will call back then.",
        commitments: ["Caller to pay Friday"],
        declineType: "none",
      },
    });
    expect(s).toContain("Jul 10, 2026, 9:30 AM");
    expect(s).toContain("verbal_yes (via callrail) by CallRail sync");
    expect(s).toContain("AI summary: Agreed to retain; will pay Friday.");
    expect(s).toContain("pitched: yes → bought");
    expect(s).toContain("sale status on this call: promised_unpaid");
    expect(s).toContain("amount discussed: $1125");
    expect(s).toContain("payment promise: will pay Friday after payday");
    expect(s).toContain("commitments: Caller to pay Friday");
  });
});

describe("serializeLead", () => {
  it("includes identity, money state, court dates, flags, attempts and follow-ups", () => {
    const s = serializeLead({
      name: "Saddam Saleh",
      tvcCaseNumber: "1612345",
      stage: "pitched",
      phone: "(501) 555-0142",
      email: "saddam@example.com",
      charge: "Speeding 85/70",
      county: "PULASKI",
      saleStatus: "promised_unpaid",
      saleStatusAt: TS,
      saleAmount: 1125,
      squarePaidTotal: 562,
      squareInvoice: {
        id: "inv_1",
        number: "42",
        amountCents: 112500,
        status: "UNPAID",
        sentAt: TS,
        updatedAt: TS,
      },
      nextCourtDate: "2026-08-14",
      nextCourtTime: "9:00 AM",
      nextCourtType: "Arraignment",
      courtDateHistory: [{ date: "2026-07-01", type: "Arraignment", reason: "continued" }],
      lostReason: undefined,
      tvcNotes: "Member called TVC upset about delay.",
      receivedAt: TS,
      contactAttempts: [{ ts: TS, outcome: "no_answer", via: "callrail" }],
      followUps: [
        { type: "billing", dueAt: TS, done: false, note: "Collect payment" },
        { type: "callback", dueAt: TS, done: true, doneAt: TS },
      ],
    });
    expect(s).toContain("Name: Saddam Saleh");
    expect(s).toContain("TVC case number: 1612345");
    expect(s).toContain("Sale status: promised_unpaid");
    expect(s).toContain("Quoted/collected fee: $1125");
    expect(s).toContain("Collected via Square so far: $562");
    expect(s).toContain("Latest Square invoice: #42 — $1125, status UNPAID, sent Jul 10, 2026, 9:30 AM");
    expect(s).toContain("Next court date: 2026-08-14 at 9:00 AM (Arraignment)");
    expect(s).toContain("Court date history: 2026-07-01 (Arraignment) — continued");
    expect(s).toContain("Contact attempts (1, oldest first):");
    expect(s).toContain("[PENDING] billing due Jul 10, 2026, 9:30 AM — Collect payment");
    expect(s).toContain("[done] callback");
  });
});

describe("serializeMessage", () => {
  it("carries kind, source, handled state and the classifier reason", () => {
    const s = serializeMessage({
      kind: "billing_escalation",
      from: "TVCHub Cadence",
      fromName: "Square Sync",
      subject: "Transcript says PAID but no Square charge — Saddam Saleh",
      message: "Verify the money actually moved.",
      memberName: "Saddam Saleh",
      receivedAt: TS,
      nonPaymentReason: "Agent never asked for payment.",
      noPursuit: true,
      handled: false,
    });
    expect(s).toContain("Kind: billing_escalation");
    expect(s).toContain("Raised by: Square Sync");
    expect(s).toContain("Raised at: Jul 10, 2026, 9:30 AM");
    expect(s).toContain("Why no payment (classifier): Agent never asked for payment.");
    expect(s).toContain("No-pursuit alarm: yes");
    expect(s).toContain("Handled: no — still open");
  });
});

describe("buildContext", () => {
  it("assembles post-it, lead, and referenced Square invoice marker", () => {
    const ctx = buildContext({
      msg: {
        kind: "tvc_message",
        fromName: "Square Sync",
        from: "Square Sync",
        subject: "Invoice out, unpaid — Saddam Saleh",
        message: "Chase it.",
        receivedAt: TS,
        handled: false,
        squareInvoiceId: "inv:123",
      },
      lead: { name: "Saddam Saleh", stage: "pitched", contactAttempts: [], receivedAt: TS },
      leadId: "lead1",
      squareInvoice: {
        id: "inv:123",
        marker: {
          status: "UNPAID",
          amountCents: 112500,
          invoiceNumber: "42",
          recipientName: "Saddam Saleh",
          sentAt: TS,
          leadId: "lead1",
          matchedBy: "email",
        },
      },
    });
    expect(ctx).toContain("=== THE POST-IT NOTE ===");
    expect(ctx).toContain("=== THE LINKED LEAD (lead1) ===");
    expect(ctx).toContain("=== REFERENCED SQUARE INVOICE ===");
    expect(ctx).toContain("amount: $1125");
    expect(ctx).toContain("status: UNPAID");
    expect(ctx).toContain("matched to lead: lead1 (by email)");
  });

  it("says plainly when no lead is linked", () => {
    const ctx = buildContext({
      msg: { message: "x", receivedAt: TS, handled: false, tvcCaseNumber: "1600000" },
      lead: null,
      leadId: null,
    });
    expect(ctx).toContain("No lead in the app is linked to this post-it (no lead found for TVC case #1600000).");
  });
});

describe("historyMessages", () => {
  it("caps replayed history at the last 20 turns and maps roles", () => {
    const qa = Array.from({ length: 30 }, (_, i) => ({
      role: i % 2 === 0 ? "user" : "assistant",
      text: `turn ${i}`,
      ts: TS + i,
    }));
    const msgs = historyMessages(qa);
    expect(msgs).toHaveLength(20);
    expect(msgs[0]).toEqual({ role: "user", content: "turn 10" });
    expect(msgs[19]).toEqual({ role: "assistant", content: "turn 29" });
  });
  it("drops malformed turns and tolerates a missing array", () => {
    expect(historyMessages(undefined)).toEqual([]);
    expect(historyMessages([{ role: "system", text: "x" }, { role: "user" }])).toEqual([]);
  });
});
