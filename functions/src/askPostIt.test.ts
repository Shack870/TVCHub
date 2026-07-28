import { describe, expect, it } from "vitest";
import {
  MAX_WINDOW_DAYS,
  buildContext,
  fmtChicago,
  historyMessages,
  invoiceRow,
  paymentAttribution,
  paymentRow,
  resolvePaymentWindow,
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

// ---------- Live Square tool seams ----------

describe("resolvePaymentWindow", () => {
  it("accepts a valid range and normalizes to ISO", () => {
    const w = resolvePaymentWindow("2026-07-24T00:00:00-05:00", "2026-07-25T00:00:00-05:00");
    expect(w).toEqual({
      beginIso: "2026-07-24T05:00:00.000Z",
      endIso: "2026-07-25T05:00:00.000Z",
      clampNote: null,
    });
  });
  it("rejects missing or unparseable bounds", () => {
    expect(resolvePaymentWindow(undefined, "2026-07-25")).toHaveProperty("error");
    expect(resolvePaymentWindow("2026-07-24", undefined)).toHaveProperty("error");
    expect(resolvePaymentWindow("not a date", "also not")).toHaveProperty("error");
  });
  it("tolerates a swapped range", () => {
    const w = resolvePaymentWindow("2026-07-25T00:00:00Z", "2026-07-24T00:00:00Z");
    expect(w).toMatchObject({
      beginIso: "2026-07-24T00:00:00.000Z",
      endIso: "2026-07-25T00:00:00.000Z",
    });
  });
  it(`clamps windows wider than ${MAX_WINDOW_DAYS} days`, () => {
    const w = resolvePaymentWindow("2026-01-01T00:00:00Z", "2026-12-31T00:00:00Z");
    if ("error" in w) throw new Error("unexpected error");
    expect(w.beginIso).toBe("2026-01-01T00:00:00.000Z");
    expect(Date.parse(w.endIso) - Date.parse(w.beginIso)).toBe(MAX_WINDOW_DAYS * 86400_000);
    expect(w.clampNote).toContain(`${MAX_WINDOW_DAYS} days`);
  });
});

describe("paymentAttribution", () => {
  const names = new Map([["lead1", "Saddam Saleh"]]);
  it("names the matched lead with the match method", () => {
    expect(paymentAttribution({ leadId: "lead1", matchedBy: "phone" }, names)).toBe(
      "matched to lead Saddam Saleh [lead1] by phone",
    );
  });
  it("survives a matched lead whose doc is gone", () => {
    expect(paymentAttribution({ leadId: "gone" }, names)).toBe(
      "matched to lead (name unknown) [gone]",
    );
  });
  it("maps unmatched and ignored markers to unattributed", () => {
    expect(paymentAttribution({ leadId: null, action: "unmatched" }, names)).toBe("unattributed");
    expect(paymentAttribution({ action: "ignored_unrelated" }, names)).toBe("unattributed");
  });
  it("flags payments the sync never saw", () => {
    expect(paymentAttribution(null, names)).toBe("never processed by sync");
  });
});

describe("paymentRow", () => {
  // 2026-07-10 14:30:00 UTC = 9:30 AM Chicago.
  const payment = {
    id: "pay_1",
    status: "COMPLETED",
    created_at: "2026-07-10T14:30:00Z",
    amount_money: { amount: 112500, currency: "USD" },
    note: "Khup Sum Retainer Payment",
    buyer_email_address: "buyer@example.com",
  };
  it("serializes Chicago time, dollars, note, marker-cached payer, attribution", () => {
    const row = paymentRow(
      payment,
      {
        leadId: null,
        action: "ignored_unrelated",
        payerName: "Khup Sum",
        payerEmail: "khup@example.com",
        payerPhone: "+15015550142",
      },
      new Map(),
    );
    expect(row).toEqual({
      id: "pay_1",
      created: "Jul 10, 2026, 9:30 AM",
      status: "COMPLETED",
      dollars: 1125,
      note: "Khup Sum Retainer Payment",
      payer_name: "Khup Sum",
      payer_email: "khup@example.com",
      payer_phone: "+15015550142",
      attribution: "unattributed",
    });
  });
  it("falls back to the payment's buyer email and omits empty fields", () => {
    const row = paymentRow({ ...payment, note: undefined }, null, new Map());
    expect(row.payer_email).toBe("buyer@example.com");
    expect(row).not.toHaveProperty("note");
    expect(row).not.toHaveProperty("payer_name");
    expect(row.attribution).toBe("never processed by sync");
  });
  it("tolerates a payment with no amount", () => {
    const row = paymentRow({ id: "p2", status: "COMPLETED", created_at: "bad" }, null, new Map());
    expect(row.dollars).toBe(0);
    expect(row.created).toBe("unknown");
  });
});

describe("invoiceRow", () => {
  it("serializes number, status, amount, recipient, times, and matched lead", () => {
    const row = invoiceRow(
      {
        id: "inv_1",
        invoice_number: "42",
        status: "UNPAID",
        created_at: "2026-07-10T14:30:00Z",
        updated_at: "2026-07-10T14:30:00Z",
        primary_recipient: {
          given_name: "Saddam",
          family_name: "Saleh",
          email_address: "saddam@example.com",
        },
        payment_requests: [{ computed_amount_money: { amount: 112500 } }],
      },
      { leadId: "lead1", status: "UNPAID" },
      new Map([["lead1", "Saddam Saleh"]]),
    );
    expect(row).toEqual({
      number: "42",
      status: "UNPAID",
      dollars: 1125,
      recipient: "Saddam Saleh",
      recipient_email: "saddam@example.com",
      sent: "Jul 10, 2026, 9:30 AM",
      updated: "Jul 10, 2026, 9:30 AM",
      matched_lead: "Saddam Saleh [lead1]",
    });
  });
  it("handles no marker / no recipient / no amount", () => {
    const row = invoiceRow({ id: "inv_2" }, null, new Map());
    expect(row).toEqual({
      number: "inv_2",
      status: "UNKNOWN",
      dollars: 0,
      sent: "unknown",
      updated: "unknown",
      matched_lead: "no lead matched",
    });
  });
});
