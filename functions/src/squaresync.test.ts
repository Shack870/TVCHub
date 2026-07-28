import { describe, expect, it } from "vitest";
import {
  MATCHER_VERSION,
  classifyVerifyCandidate,
  isConnectedCallAttempt,
  nameNeedles,
} from "./squaresync.js";

describe("MATCHER_VERSION", () => {
  it("is v4 — the connected-calls-only interval index generation", () => {
    expect(MATCHER_VERSION).toBe(4);
  });
});

describe("isConnectedCallAttempt", () => {
  it("excludes no-answer and voicemail attempts (the Jones/Bohdan false veto)", () => {
    // Bohdan Tsymbalyuk's 1:40 PM attempt: nobody picked up — it must never
    // become a concurrent-call candidate for Matthew Jones's 2:11 PM charge.
    expect(isConnectedCallAttempt({ outcome: "no_answer" })).toBe(false);
    expect(isConnectedCallAttempt({ outcome: "voicemail" })).toBe(false);
  });

  it("includes attempts whose outcome shows a conversation", () => {
    for (const outcome of ["spoke", "thinking", "declined", "retained", "verbal_yes"]) {
      expect(isConnectedCallAttempt({ outcome })).toBe(true);
    }
  });

  it("trusts the transcript classifier's connection verdict when it has one", () => {
    // conversation/brief = somebody ANSWERED — a card could have been keyed
    // mid-call, whatever the derived outcome says (brief maps to no_answer).
    expect(
      isConnectedCallAttempt({ outcome: "no_answer", ai: { connection: "brief" } }),
    ).toBe(true);
    expect(
      isConnectedCallAttempt({ outcome: "no_answer", ai: { connection: "conversation" } }),
    ).toBe(true);
    // voicemail/wrong_number = NOT a call with the lead, whatever the flags said.
    expect(
      isConnectedCallAttempt({ outcome: "spoke", ai: { connection: "voicemail" } }),
    ).toBe(false);
    expect(
      isConnectedCallAttempt({ outcome: "spoke", ai: { connection: "wrong_number" } }),
    ).toBe(false);
  });

  it("falls back to the outcome when the classifier is unclear or absent", () => {
    expect(
      isConnectedCallAttempt({ outcome: "spoke", ai: { connection: "unclear" } }),
    ).toBe(true);
    expect(
      isConnectedCallAttempt({ outcome: "no_answer", ai: { connection: "unclear" } }),
    ).toBe(false);
    expect(isConnectedCallAttempt({ outcome: "spoke", ai: null })).toBe(true);
    expect(isConnectedCallAttempt({})).toBe(true); // no signals — keep it
  });
});

describe("nameNeedles", () => {
  it("produces the full, reversed, and middle-name-skipping variants", () => {
    expect(nameNeedles("MATTHEW WILLIAM JONES")).toEqual(
      expect.arrayContaining([
        "matthew william jones",
        "jones william matthew",
        "matthew jones",
        "jones matthew",
      ]),
    );
  });

  it("keeps a long single name, drops short junk", () => {
    expect(nameNeedles("Bartholomew")).toEqual(["bartholomew"]);
    expect(nameNeedles("Al Bo")).toEqual([]); // under the 6-char floor
    expect(nameNeedles(null)).toEqual([]);
  });
});

describe("classifyVerifyCandidate", () => {
  // The live case this scanner exists for: Matthew William Jones claimed
  // $1,125 paid on his call; an unmatched $1,125 charge with note
  // "Matthew Jones Retainer Payment" sat in the markers the whole time.
  const jones = { leadName: "MATTHEW WILLIAM JONES", feeDollars: 1125 };

  it("strong: note names the lead and the amount matches the claim", () => {
    expect(
      classifyVerifyCandidate({
        ...jones,
        paymentDollars: 1125,
        note: "Matthew Jones Retainer Payment",
      }),
    ).toBe("strong");
  });

  it("strong: customer-record name counts, and half-payments count", () => {
    expect(
      classifyVerifyCandidate({
        ...jones,
        paymentDollars: 1125,
        note: null,
        payerName: "Matthew Jones",
      }),
    ).toBe("strong");
    expect(
      classifyVerifyCandidate({
        ...jones,
        paymentDollars: 562.5,
        note: "Jones Matthew first half",
      }),
    ).toBe("strong");
  });

  it("strong: a name hit with no recorded fee is unconstrained, like the matcher", () => {
    expect(
      classifyVerifyCandidate({
        leadName: "MATTHEW WILLIAM JONES",
        feeDollars: null,
        paymentDollars: 400,
        note: "Matthew Jones payment",
      }),
    ).toBe("strong");
  });

  it("strong: amount tolerance mirrors the concurrent-call matcher's $5", () => {
    expect(
      classifyVerifyCandidate({
        ...jones,
        paymentDollars: 1127,
        note: "matthew jones retainer",
      }),
    ).toBe("strong");
  });

  it("weak: amount matches but nothing names the lead", () => {
    expect(
      classifyVerifyCandidate({ ...jones, paymentDollars: 1125, note: "Retainer payment" }),
    ).toBe("weak");
    // ...even when the charge names somebody ELSE — a human decides.
    expect(
      classifyVerifyCandidate({
        ...jones,
        paymentDollars: 1125,
        note: "Bohdan Tsymbalyuk retainer",
      }),
    ).toBe("weak");
  });

  it("weak: name hit with an inconsistent amount", () => {
    expect(
      classifyVerifyCandidate({
        ...jones,
        paymentDollars: 400,
        note: "Matthew Jones Retainer Payment",
      }),
    ).toBe("weak");
  });

  it("none: nothing connects the charge to the lead", () => {
    expect(
      classifyVerifyCandidate({ ...jones, paymentDollars: 300, note: "Ali Janneh retainer" }),
    ).toBe("none");
    // No fee on file means a bare amount is not evidence either.
    expect(
      classifyVerifyCandidate({
        leadName: "MATTHEW WILLIAM JONES",
        feeDollars: null,
        paymentDollars: 500,
        note: "Retainer payment",
      }),
    ).toBe("none");
  });
});
