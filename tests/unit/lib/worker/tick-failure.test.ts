import { beforeEach, describe, expect, it, vi } from "vitest";

const { streak, emitSystemIncident, resolveSystemIncident } = vi.hoisted(() => ({
  streak: { value: 0 },
  emitSystemIncident: vi.fn(async () => {}),
  resolveSystemIncident: vi.fn(async () => {}),
}));

vi.mock("@/lib/worker/jobs", () => ({
  recordFailure: vi.fn(async () => ++streak.value),
  recordOk: vi.fn(async () => {
    const ended = streak.value;
    streak.value = 0;
    return ended;
  }),
}));
vi.mock("@/lib/incidents/system", () => ({ emitSystemIncident, resolveSystemIncident }));
vi.mock("@/lib/notifications/admin-orgs", () => ({ adminOrgIds: vi.fn(async () => ["org-1", "org-2"]) }));

import { FAILURE_ALERT_THRESHOLD, recordTickFailure, recordTickOk } from "@/lib/worker/tick-failure";

const log = { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn(), child: vi.fn() };
const fail = () => recordTickFailure(log, "git-poll", new Error("boom"));

describe("loop failure incidents", () => {
  beforeEach(() => {
    streak.value = 0;
    vi.clearAllMocks();
  });

  it("opens one system.loop-failing incident on the fifth failure in a row, and none after", async () => {
    for (let i = 0; i < FAILURE_ALERT_THRESHOLD - 1; i++) await fail();
    expect(emitSystemIncident).not.toHaveBeenCalled();

    await fail();
    expect(emitSystemIncident).toHaveBeenCalledOnce();
    expect(emitSystemIncident).toHaveBeenCalledWith(
      ["org-1", "org-2"],
      expect.objectContaining({ type: "system.service-down", service: "loop:git-poll" }),
      expect.objectContaining({ kind: "system.loop-failing", about: "loop:git-poll", severity: "warning" }),
    );

    await fail();
    expect(emitSystemIncident).toHaveBeenCalledOnce();
  });

  it("resolves it on the next clean pass", async () => {
    for (let i = 0; i < FAILURE_ALERT_THRESHOLD; i++) await fail();
    await recordTickOk(log, "git-poll");
    expect(resolveSystemIncident).toHaveBeenCalledWith(["org-1", "org-2"], "system.loop-failing", "loop:git-poll", expect.any(String));

    await recordTickOk(log, "git-poll");
    expect(resolveSystemIncident).toHaveBeenCalledOnce();
  });

  it("a short streak opens nothing and resolves nothing", async () => {
    await fail();
    await fail();
    await recordTickOk(log, "git-poll");
    expect(emitSystemIncident).not.toHaveBeenCalled();
    expect(resolveSystemIncident).not.toHaveBeenCalled();
  });
});
