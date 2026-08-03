import { describe, it, expect } from "vitest";
import { summarizeBulkResult } from "@/lib/ui/bulk-result";

const stop = { verb: "stop", past: "stopped" };

describe("summarizeBulkResult", () => {
  it("reports success only when nothing failed", () => {
    expect(summarizeBulkResult({ ...stop, total: 3, failed: [] })).toEqual({
      tone: "success",
      message: "All apps stopped",
    });
  });

  it("reports total failure as an error and names the apps", () => {
    const outcome = summarizeBulkResult({ ...stop, total: 2, failed: ["Vardo", "Loki"] });
    expect(outcome.tone).toBe("error");
    expect(outcome.message).toBe("Could not stop any apps");
    expect(outcome.description).toBe("Vardo and Loki");
  });

  it("names the single app when it is the only one", () => {
    const outcome = summarizeBulkResult({ ...stop, total: 1, failed: ["Vardo"] });
    expect(outcome.tone).toBe("error");
    expect(outcome.message).toBe("Could not stop Vardo");
  });

  it("reports a partial run as a warning with the counts and the failures", () => {
    const outcome = summarizeBulkResult({ ...stop, total: 4, failed: ["Vardo"] });
    expect(outcome.tone).toBe("warning");
    expect(outcome.message).toBe("3 of 4 apps stopped");
    expect(outcome.description).toBe("Failed: Vardo");
  });

  it("truncates long failure lists", () => {
    const outcome = summarizeBulkResult({
      ...stop,
      total: 9,
      failed: ["a", "b", "c", "d", "e"],
    });
    expect(outcome.description).toBe("Failed: a, b, c and 2 more");
  });

  it("uses the past tense supplied for the verb", () => {
    const outcome = summarizeBulkResult({
      verb: "restart",
      past: "restarted",
      total: 2,
      failed: [],
    });
    expect(outcome.message).toBe("All apps restarted");
  });
});
