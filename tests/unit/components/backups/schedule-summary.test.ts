import { describe, it, expect } from "vitest";

import { describeSchedule } from "@/components/backups/schedule-summary";

describe("describeSchedule", () => {
  it("describes a daily schedule", () => {
    expect(describeSchedule("0 3 * * *")).toBe("Daily at 3am");
    expect(describeSchedule("30 14 * * *")).toBe("Daily at 2:30pm");
  });

  it("describes a weekly schedule by day name", () => {
    expect(describeSchedule("0 4 * * 0")).toBe("Weekly on Sunday at 4am");
    expect(describeSchedule("0 4 * * 3")).toBe("Weekly on Wednesday at 4am");
  });

  it("describes a monthly schedule", () => {
    expect(describeSchedule("0 5 1 * *")).toBe("Monthly on day 1 at 5am");
  });

  it("handles midnight and noon", () => {
    expect(describeSchedule("0 0 * * *")).toBe("Daily at 12am");
    expect(describeSchedule("0 12 * * *")).toBe("Daily at 12pm");
  });

  // Guessing at an expression the scheduler never writes would be worse than
  // showing it verbatim.
  it("falls back to the raw expression when it can't be summarized", () => {
    expect(describeSchedule("*/15 * * * *")).toBe("*/15 * * * *");
    expect(describeSchedule("0 3 * * 1-5")).toBe("0 3 * * 1-5");
    expect(describeSchedule("nonsense")).toBe("nonsense");
  });

  it("handles a missing schedule", () => {
    expect(describeSchedule(null)).toBe("No schedule");
    expect(describeSchedule(undefined)).toBe("No schedule");
    expect(describeSchedule("")).toBe("No schedule");
  });
});
