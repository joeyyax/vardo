import { beforeEach, describe, expect, it, vi } from "vitest";

const { open, emitSystemIncident, resolveSystemIncident } = vi.hoisted(() => ({
  open: { value: false },
  emitSystemIncident: vi.fn(async () => {}),
  resolveSystemIncident: vi.fn(async () => {}),
}));

vi.mock("@/lib/db", () => ({
  db: { query: { incidents: { findFirst: vi.fn(async () => (open.value ? { id: "inc_1" } : undefined)) } } },
}));
vi.mock("@/lib/incidents/system", () => ({ emitSystemIncident, resolveSystemIncident }));
vi.mock("@/lib/notifications/admin-orgs", () => ({ adminOrgIds: vi.fn(async () => ["org-1"]) }));

import { syncHostProblem, type HostProblem } from "@/lib/incidents/host";
import { incidentKey } from "@/lib/incidents/key";

const problem: HostProblem = {
  kind: "host.worker-down",
  about: "host",
  title: "Background worker is down",
  message: "No heartbeat",
  severity: "critical",
};

describe("host problems", () => {
  beforeEach(() => {
    open.value = false;
    vi.clearAllMocks();
  });

  it("opens once while the condition holds", async () => {
    expect(await syncHostProblem(problem, true, "back")).toBe("opened");
    expect(emitSystemIncident).toHaveBeenCalledWith(
      ["org-1"],
      expect.objectContaining({ type: "system.service-down", service: "host" }),
      expect.objectContaining({ kind: "host.worker-down", about: "host", severity: "critical" }),
    );
    open.value = true;
    expect(await syncHostProblem(problem, true, "back")).toBe("unchanged");
    expect(emitSystemIncident).toHaveBeenCalledOnce();
  });

  it("resolves an open incident on recovery and does nothing when none is open", async () => {
    expect(await syncHostProblem(problem, false, "back")).toBe("unchanged");
    open.value = true;
    expect(await syncHostProblem(problem, false, "back")).toBe("resolved");
    expect(resolveSystemIncident).toHaveBeenCalledWith(["org-1"], "host.worker-down", "host", "back");
  });

  it("keys this host and each peer apart", () => {
    expect(incidentKey("host.worker-down", "host")).toBe("host:local:host.worker-down");
    expect(incidentKey("host.peer-silent", "peer:i-1")).toBe("host:peer:i-1:host.peer-silent");
  });
});
