import { describe, expect, it } from "vitest";
import { chipLabel, systemProblems, workerLines } from "@/lib/ui/system-status";

const worker = { since: "2026-10-14T16:12:00Z", queued: 3, queuedInstance: null };
const updating = { name: "Updating Vardo to 9462a35…", href: "/admin/settings/maintenance#updates" };

describe("systemProblems", () => {
  it("is empty when healthy and puts a missing worker before an update", () => {
    expect(systemProblems(null, null)).toEqual([]);
    expect(systemProblems(worker, updating).map((p) => p.kind)).toEqual(["worker", "updating"]);
    expect(systemProblems(null, updating).map((p) => p.kind)).toEqual(["updating"]);
  });
});

describe("chipLabel", () => {
  it("names the worker and the org's queue, short on a phone", () => {
    const [p] = systemProblems(worker, null);
    expect(chipLabel(p)).toEqual({ full: "Worker offline · 3 queued", short: "Worker offline" });
    const [idle] = systemProblems({ ...worker, queued: 0 }, null);
    expect(chipLabel(idle).full).toBe("Worker offline");
  });

  it("shortens the update row's name", () => {
    const [p] = systemProblems(null, updating);
    expect(chipLabel(p)).toEqual({ full: "Updating to 9462a35", short: "Updating" });
    const [restart] = systemProblems(null, { name: "Restarting Vardo's shared services…" });
    expect(chipLabel(restart).full).toBe("Restarting Vardo's shared services");
  });
});

describe("workerLines", () => {
  it("says the org's queue, and the instance's to an admin only when it holds more", () => {
    expect(workerLines(worker)).toEqual(["3 deploys queued."]);
    expect(workerLines({ ...worker, queued: 1 })).toEqual(["1 deploy queued."]);
    expect(workerLines({ ...worker, queuedInstance: 3 })).toEqual(["3 deploys queued."]);
    expect(workerLines({ ...worker, queuedInstance: 12 })).toEqual(["3 deploys queued.", "12 across the instance."]);
    expect(workerLines({ ...worker, queued: 0, queuedInstance: 4 })).toEqual(["4 deploys queued across the instance."]);
    expect(workerLines({ ...worker, queued: 0 })).toEqual([]);
  });
});
