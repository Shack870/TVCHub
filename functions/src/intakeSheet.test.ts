import { describe, expect, it } from "vitest";
import { eventPriority } from "./intakeSheet.js";

// The final sheet's day-wide order is deterministic — likeliest money first.
describe("eventPriority", () => {
  it("collections beat everything", () => {
    expect(eventPriority('Follow-up due: Collect payment — said YES ($1125 promised)')).toBe(0);
  });

  it("court today beats motions, motions beat the chase", () => {
    const court = eventPriority("Court appearance today at 9:00 AM — Benton District Court");
    const motions = eventPriority("Motions-filing deadline today — last day to file the Motion to Continue");
    const chase = eventPriority("Follow-up due: Chase call — Chase touch #4");
    expect(court).toBeLessThan(motions);
    expect(motions).toBeLessThan(chase);
  });

  it("prep reminders sit between deadlines and cold calls", () => {
    const dayBefore = eventPriority("Follow-up due: Day before court");
    const weekBefore = eventPriority("Follow-up due: Week before court — free reminder");
    const callback = eventPriority("Follow-up due: Call back — Auto cadence — attempt #1");
    expect(dayBefore).toBeLessThan(weekBefore);
    expect(weekBefore).toBeLessThan(callback);
    expect(callback).toBe(6);
  });

  it('a chase call whose note mentions "deadline framing" is still a chase', () => {
    expect(eventPriority("Follow-up due: Chase call — Deadline framing: we need time to file")).toBe(5);
  });

  it("raw follow-up type strings (underscored) rank the same as labels", () => {
    expect(eventPriority("Follow-up due: week_before — free reminder")).toBe(4);
    expect(eventPriority("Follow-up due: day_before")).toBe(3);
  });
});
