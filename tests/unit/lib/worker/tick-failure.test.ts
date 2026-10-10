import { beforeEach, describe, expect, it, vi } from "vitest";

const { streak, emit } = vi.hoisted(() => ({ streak: { value: 0 }, emit: vi.fn() }));

vi.mock("@/lib/worker/jobs", () => ({ recordFailure: vi.fn(async () => ++streak.value) }));
vi.mock("@/lib/bus", () => ({ emit }));
vi.mock("@/lib/notifications/admin-orgs", () => ({ adminOrgIds: vi.fn(async () => ["org-1", "org-2"]) }));

import { FAILURE_ALERT_THRESHOLD, recordTickFailure } from "@/lib/worker/tick-failure";

const log = { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn(), child: vi.fn() };

describe("recordTickFailure", () => {
  beforeEach(() => {
    streak.value = 0;
    emit.mockClear();
  });

  it("raises one system alert per admin org on the fifth failure in a row, and none after", async () => {
    for (let i = 0; i < FAILURE_ALERT_THRESHOLD - 1; i++) await recordTickFailure(log, "git-poll", new Error("boom"));
    expect(emit).not.toHaveBeenCalled();

    await recordTickFailure(log, "git-poll", new Error("boom"));
    expect(emit).toHaveBeenCalledTimes(2);
    expect(emit).toHaveBeenCalledWith("org-1", expect.objectContaining({ type: "system.service-down", service: "loop:git-poll" }));

    await recordTickFailure(log, "git-poll", new Error("boom"));
    expect(emit).toHaveBeenCalledTimes(2);
  });
});
