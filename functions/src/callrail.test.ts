import { describe, expect, it } from "vitest";
import {
  type CallAnalysis,
  TRANSCRIPT_EXPECTED_MIN_SEC,
  autoStageMove,
  deferReason,
  lateAnalysisAttemptUpdate,
  saleRollup,
} from "./callrail.js";

const mkAnalysis = (over: Partial<CallAnalysis> = {}): CallAnalysis => ({
  connection: "conversation",
  pitched: true,
  pitchResult: "bought",
  summary: "Client agreed to the $1,125 fee and paid $562 on the call.",
  commitments: [],
  callbackAt: null,
  upset: false,
  saleStatus: "paid_partial",
  saleAmount: 1125,
  paymentPlan: "financed",
  paymentPromise: null,
  nonPaymentReason: null,
  existingClientInquiry: false,
  declineType: "none",
  declineReason: null,
  callerName: null,
  ...over,
});

describe("deferReason", () => {
  const NOW = Date.parse("2026-07-27T22:36:00Z");
  const startedMinAgo = (min: number) =>
    new Date(NOW - min * 60_000).toISOString();

  it("defers a just-ended call whose recording metadata hasn't published yet (the Harris hole)", () => {
    // Harris's call: processed 2 minutes after hangup — duration was already
    // 907s but recording_duration was still null, so the old
    // Boolean(recording_duration) gate let it through and it was logged bare.
    expect(
      deferReason(
        {
          answered: true,
          duration: 907,
          recording_duration: null,
          transcription: null,
          start_time: startedMinAgo(17),
        },
        NOW,
      ),
    ).toBe("transcript_pending");
  });

  it("defers an answered+recorded call whose transcript is still processing", () => {
    expect(
      deferReason(
        {
          answered: true,
          duration: 907,
          recording_duration: 907,
          transcription: "short",
          start_time: startedMinAgo(20),
        },
        NOW,
      ),
    ).toBe("transcript_pending");
  });

  it("defers a call still in progress (no duration yet)", () => {
    expect(
      deferReason(
        {
          answered: false,
          duration: null,
          recording_duration: null,
          transcription: null,
          start_time: startedMinAgo(5),
        },
        NOW,
      ),
    ).toBe("in_progress");
  });

  it("stops waiting past the 3h window — the call gets logged (bare, with analysisPending)", () => {
    expect(
      deferReason(
        {
          answered: true,
          duration: 907,
          recording_duration: null,
          transcription: null,
          start_time: startedMinAgo(200),
        },
        NOW,
      ),
    ).toBeNull();
  });

  it("processes short unrecorded answered calls immediately (no transcript expected)", () => {
    expect(
      deferReason(
        {
          answered: true,
          duration: TRANSCRIPT_EXPECTED_MIN_SEC - 1,
          recording_duration: null,
          transcription: null,
          start_time: startedMinAgo(2),
        },
        NOW,
      ),
    ).toBeNull();
  });

  it("processes a call whose transcript is ready", () => {
    expect(
      deferReason(
        {
          answered: true,
          duration: 907,
          recording_duration: 907,
          transcription: "x".repeat(500),
          start_time: startedMinAgo(10),
        },
        NOW,
      ),
    ).toBeNull();
  });
});

describe("lateAnalysisAttemptUpdate", () => {
  const call = {
    id: "CAL019fa5a8ca8f7220809e7a5f063e6b01",
    direction: "outbound" as const,
    answered: true,
    voicemail: false,
    duration: 907,
    customer_phone_number: "+16822050915",
    customer_name: "MICHAEL HARRIS",
    start_time: "2026-07-27T17:18:50.676-05:00",
    recording_player: "https://app.callrail.com/calls/CAL.../recording",
    recording_duration: 907,
    transcription: "…",
  };
  const bareAttempt = {
    ts: 1785190730676,
    outcome: "spoke",
    notes: "Outbound call via CallRail — 15m 7s.",
    by: "CallRail sync",
    via: "callrail",
    callId: call.id,
    recordingUrl: null,
    durationSec: 907,
  };

  it("attaches the ai map and upgrades the outcome to the classifier's read", () => {
    const { attempt, outcome } = lateAnalysisAttemptUpdate(
      { ...bareAttempt },
      call,
      mkAnalysis(),
    );
    expect(outcome).toBe("retained"); // pitched + bought + money moved
    expect(attempt.outcome).toBe("retained");
    expect(attempt.ai).toMatchObject({ saleStatus: "paid_partial", saleAmount: 1125 });
    expect(attempt.recordingUrl).toBe(call.recording_player);
    expect(attempt.durationSec).toBe(907);
    // Identity fields survive untouched.
    expect(attempt.ts).toBe(bareAttempt.ts);
    expect(attempt.callId).toBe(call.id);
    expect(attempt.via).toBe("callrail");
  });

  it("keeps a factual note and flags wrong numbers", () => {
    const { attempt } = lateAnalysisAttemptUpdate(
      { ...bareAttempt },
      call,
      mkAnalysis({ connection: "wrong_number", pitched: false, pitchResult: "not_pitched" }),
    );
    expect(attempt.notes).toContain("Outbound call via CallRail — 15m 7s.");
    expect(attempt.notes).toContain("wrong number");
  });
});

describe("late attach on a hand-corrected lead (the Harris safety seam)", () => {
  // Harris's card after the QA hand-fix: stage financed, paid_partial with
  // saleStatusAt at PAYMENT time (5:29 PM) — NEWER than the 5:18 PM call.
  const harris = {
    stage: "financed",
    saleStatus: "paid_partial",
    saleStatusAt: 1785191354488, // payment time
    saleAmount: 1125,
  };
  const callTs = 1785190730676; // the call started before the payment

  it("saleRollup refuses evidence older than the recorded sale state", () => {
    expect(saleRollup(harris, mkAnalysis(), callTs)).toBeNull();
  });

  it("autoStageMove never moves a lead off financed/intake_complete", () => {
    expect(autoStageMove(harris, mkAnalysis(), callTs)).toBeNull();
    expect(
      autoStageMove({ ...harris, stage: "intake_complete" }, mkAnalysis({ saleStatus: "paid_full" }), callTs),
    ).toBeNull();
  });

  it("but a working-board lead still gets the sanctioned move when analysis lands late", () => {
    const move = autoStageMove({ stage: "callback" }, mkAnalysis(), callTs);
    expect(move?.patch.stage).toBe("financed");
    expect(move?.patch.isFinanced).toBe(true);
  });
});
