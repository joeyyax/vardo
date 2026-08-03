import { describe, it, expect } from "vitest";
import {
  deriveStatus,
  deployHoldsStatus,
  parseExitCode,
  restartsFor,
  stabilityTransition,
  DEPLOYING_HOLD_MS,
} from "@/lib/docker/status-reconcile";
import { matchContainers, type ReconcilableApp } from "@/lib/docker/container-match";
import type { ContainerInfo } from "@/lib/docker/client";
import type { ExitReason } from "@/lib/docker/exit-reason";

function container(over: Partial<ContainerInfo> = {}): ContainerInfo {
  return {
    id: "c1",
    name: "app-1",
    image: "img",
    state: "running",
    status: "Up 2 hours",
    ports: [],
    labels: {},
    ...over,
  };
}

function app(over: Partial<ReconcilableApp> = {}): ReconcilableApp {
  return {
    id: "app-id",
    name: "myapp",
    status: "active",
    parentAppId: null,
    composeService: null,
    containerName: null,
    importedContainerId: null,
    ...over,
  };
}

describe("deriveStatus", () => {
  it("reports missing when the app has no containers at all", () => {
    expect(deriveStatus([])).toBe("missing");
  });

  it("reports active when any container is running", () => {
    expect(deriveStatus([container({ state: "exited" }), container({ state: "running" })])).toBe(
      "active",
    );
  });

  it("reports error while a container is restarting", () => {
    expect(deriveStatus([container({ state: "restarting" })])).toBe("error");
  });

  it("reports error for a non-zero exit", () => {
    expect(
      deriveStatus([container({ state: "exited", status: "Exited (137) 3 days ago" })]),
    ).toBe("error");
  });

  it("reports stopped for a clean exit", () => {
    expect(deriveStatus([container({ state: "exited", status: "Exited (0) 3 days ago" })])).toBe(
      "stopped",
    );
  });

  it("reports stopped when a 137 was a SIGKILL after a stop timeout", () => {
    expect(
      deriveStatus([container({ state: "exited", status: "Exited (137) 3 days ago" })], {
        kind: "signal",
        signal: "SIGKILL",
        exitCode: 137,
        containerId: "c1",
        containerName: "app-1",
        at: "2026-01-01T00:00:00.000Z",
      }),
    ).toBe("stopped");
  });

  it("reports stopped for a SIGTERM exit", () => {
    expect(
      deriveStatus([container({ state: "exited", status: "Exited (143) 3 days ago" })], {
        kind: "signal",
        signal: "SIGTERM",
        exitCode: 143,
        containerId: "c1",
        containerName: "app-1",
        at: "2026-01-01T00:00:00.000Z",
      }),
    ).toBe("stopped");
  });

  it("reports error for a host OOM kill, which is also a 137", () => {
    expect(
      deriveStatus([container({ state: "exited", status: "Exited (137) 3 days ago" })], {
        kind: "oom-host",
        exitCode: 137,
        containerId: "c1",
        containerName: "app-1",
        at: "2026-01-01T00:00:00.000Z",
      }),
    ).toBe("error");
  });

  it("reports error for a cgroup OOM kill", () => {
    expect(
      deriveStatus([container({ state: "exited", status: "Exited (137) 3 days ago" })], {
        kind: "oom-limit",
        exitCode: 137,
        containerId: "c1",
        containerName: "app-1",
        at: "2026-01-01T00:00:00.000Z",
      }),
    ).toBe("error");
  });

  it("reports error for a non-zero exit with no signal behind it", () => {
    expect(
      deriveStatus([container({ state: "exited", status: "Exited (1) 3 days ago" })], {
        kind: "failed",
        exitCode: 1,
        containerId: "c1",
        containerName: "app-1",
        at: "2026-01-01T00:00:00.000Z",
      }),
    ).toBe("error");
  });

  it("keeps a flapping container an error however its last run ended", () => {
    expect(
      deriveStatus([container({ state: "restarting", status: "Restarting (143) 1 second ago" })], {
        kind: "signal",
        signal: "SIGTERM",
        exitCode: 143,
        containerId: "c1",
        containerName: "app-1",
        at: "2026-01-01T00:00:00.000Z",
      }),
    ).toBe("error");
  });

  it("falls back to the exit code when no reason was resolved", () => {
    expect(
      deriveStatus([container({ state: "exited", status: "Exited (137) 3 days ago" })], null),
    ).toBe("error");
  });
});

describe("parseExitCode", () => {
  it("reads the code out of a list-API status string", () => {
    expect(parseExitCode("Exited (137) 3 days ago")).toBe(137);
  });

  it("returns null for a running container", () => {
    expect(parseExitCode("Up 2 hours")).toBeNull();
  });
});

describe("restartsFor", () => {
  const older = new Date("2026-01-01T00:00:00Z");
  const newer = new Date("2026-03-01T00:00:00Z");
  const read = (count: number | null, createdAt: Date | null = newer) => ({ count, createdAt });
  const nothingStored = { count: null, since: null };

  it("sums the counter across the app's containers", () => {
    expect(restartsFor([read(3), read(1)], nothingStored).count).toBe(4);
  });

  it("reports zero for containers that have never restarted", () => {
    expect(restartsFor([read(0), read(0)], nothingStored).count).toBe(0);
  });

  it("counts from the oldest container the total covers", () => {
    expect(restartsFor([read(1, newer), read(2, older)], nothingStored).since).toEqual(older);
  });

  it("has no anchor when no container gave a creation time", () => {
    expect(restartsFor([read(1, null)], nothingStored).since).toBeNull();
  });

  it("reports null, not zero, when the app has no containers", () => {
    expect(restartsFor([], nothingStored).count).toBeNull();
    expect(restartsFor([], { count: 7, since: older })).toEqual(nothingStored);
  });

  it("keeps the stored figure when a container did not answer", () => {
    expect(restartsFor([read(2), read(null)], { count: 5, since: older })).toEqual({
      count: 5,
      since: older,
    });
  });

  it("stays null when a container did not answer and nothing was stored", () => {
    expect(restartsFor([read(null)], nothingStored).count).toBeNull();
  });

  it("never lowers the total to the part it could read", () => {
    expect(restartsFor([read(1), read(null)], { count: 9, since: older }).count).not.toBe(1);
  });
});

describe("matchContainers", () => {
  it("matches on the vardo app id label", () => {
    const c = container({ labels: { "vardo.project.id": "app-id" } });
    expect(matchContainers(app(), [c, container({ id: "other" })])).toEqual([c]);
  });

  it("matches the legacy host.* label prefix", () => {
    const c = container({ labels: { "host.project.id": "app-id" } });
    expect(matchContainers(app(), [c])).toEqual([c]);
  });

  it("narrows a decomposed child to its compose service", () => {
    const wanted = container({
      id: "svc",
      labels: { "vardo.project": "myapp", "com.docker.compose.service": "redis" },
    });
    const other = container({
      id: "svc2",
      labels: { "vardo.project": "myapp", "com.docker.compose.service": "postgres" },
    });
    const child = app({ composeService: "redis", name: "myapp" });
    expect(matchContainers(child, [wanted, other])).toEqual([wanted]);
  });

  it("falls back to the container name for unlabelled control-plane containers", () => {
    const c = container({ name: "vardo-postgres" });
    expect(matchContainers(app({ name: "vardo-postgres" }), [c])).toEqual([c]);
  });

  it("falls back to the compose project label", () => {
    const c = container({ name: "vardo-redis-1", labels: { "com.docker.compose.project": "vardo" } });
    expect(matchContainers(app({ name: "vardo" }), [c])).toEqual([c]);
  });

  it("returns nothing for a registered app whose containers are gone", () => {
    expect(matchContainers(app({ name: "cadvisor" }), [container()])).toEqual([]);
  });

  it("prefers the imported container id", () => {
    const c = container({ id: "imported-id", labels: {} });
    expect(matchContainers(app({ importedContainerId: "imported-id" }), [c, container()])).toEqual([
      c,
    ]);
  });
});

describe("matchContainers — blue/green decomposition", () => {
  const container = (over: Record<string, unknown> = {}) =>
    ({
      id: "c1",
      name: "paperless-production-green-paperless-1",
      state: "running",
      status: "Up 3 days",
      labels: {
        "com.docker.compose.project": "paperless-production-green",
        "com.docker.compose.service": "paperless",
        "vardo.project": "paperless",
        "vardo.project.id": "PARENT_ID",
      },
      ...over,
    }) as never;

  const child = {
    id: "CHILD_ID",
    name: "paperless-paperless",
    status: "active",
    parentAppId: "PARENT_ID",
    composeService: "paperless",
    containerName: null,
    importedContainerId: null,
  };

  it("matches a decomposed child via the parent's project.id plus service", () => {
    expect(matchContainers(child, [container()])).toHaveLength(1);
  });

  it("does not match a sibling service of the same parent", () => {
    expect(matchContainers({ ...child, composeService: "paperless-db" }, [container()])).toHaveLength(0);
  });

  it("matches a parent app by compose project minus the slot suffix", () => {
    const parent = { ...child, id: "PARENT_ID", name: "paperless", parentAppId: null, composeService: null };
    expect(matchContainers(parent, [container()])).toHaveLength(1);
  });

  it("still reports a genuinely absent service as unmatched", () => {
    const missing = { ...child, id: "X", name: "cadvisor", parentAppId: null, composeService: null };
    expect(matchContainers(missing, [container()])).toHaveLength(0);
  });

  // A shared service sits in `${app}-${env}-shared`, so the label-less fallback
  // has to strip that suffix the same way it strips blue/green.
  it("matches a parent app by the shared project name when the container carries no vardo labels", () => {
    const shared = container({
      name: "paperless-production-shared-db-1",
      labels: {
        "com.docker.compose.project": "paperless-production-shared",
        "com.docker.compose.service": "db",
      },
    });
    const parent = { ...child, id: "PARENT_ID", name: "paperless", parentAppId: null, composeService: null };
    expect(matchContainers(parent, [shared])).toHaveLength(1);
  });
});

describe("matchContainers — non-production environments", () => {
  const unlabelled = (project: string, service = "paperless") =>
    ({
      id: "c1",
      name: `${project}-${service}-1`,
      state: "running",
      status: "Up 3 days",
      labels: {
        "com.docker.compose.project": project,
        "com.docker.compose.service": service,
      },
    }) as never;

  const parent = {
    id: "PARENT_ID",
    name: "paperless",
    status: "active",
    parentAppId: null,
    composeService: null,
    containerName: null,
    importedContainerId: null,
  };

  it("matches a staging slot project", () => {
    expect(matchContainers(parent, [unlabelled("paperless-staging-green")])).toHaveLength(1);
  });

  it("matches a staging shared project", () => {
    expect(matchContainers(parent, [unlabelled("paperless-staging-shared", "db")])).toHaveLength(1);
  });

  it("matches a preview slot project", () => {
    expect(matchContainers(parent, [unlabelled("paperless-pr-42-blue")])).toHaveLength(1);
  });

  it("does not conflate an app with a longer-named sibling", () => {
    const sibling = { ...parent, id: "SIBLING", name: "paperless-db" };
    const c = unlabelled("paperless-db-staging-green", "db");
    expect(matchContainers(sibling, [c])).toHaveLength(1);
    expect(matchContainers(parent, [c])).toHaveLength(0);
  });

  it("matches a decomposed child of a staging project by derived parent name", () => {
    const staging = unlabelled("paperless-staging-green", "db");
    const dbChild = {
      ...parent,
      id: "CHILD",
      name: "paperless-db",
      parentAppId: "PARENT_ID",
      composeService: "db",
    };
    expect(matchContainers(dbChild, [staging])).toHaveLength(1);
  });
});

describe("deployHoldsStatus", () => {
  const now = new Date("2026-01-01T12:00:00Z");
  const minutesAgo = (m: number) => new Date(now.getTime() - m * 60_000);

  it("yields to a deploy that is in flight", () => {
    expect(deployHoldsStatus({ status: "deploying", updatedAt: minutesAgo(2) }, now)).toBe(true);
  });

  it("takes the status back once the hold expires", () => {
    expect(deployHoldsStatus({ status: "deploying", updatedAt: minutesAgo(600) }, now)).toBe(false);
  });

  it("outlasts the deploy timeout the sweeper enforces", () => {
    expect(DEPLOYING_HOLD_MS).toBeGreaterThan(15 * 60_000);
  });

  it("takes the status back when there is no timestamp to age", () => {
    expect(deployHoldsStatus({ status: "deploying", updatedAt: null }, now)).toBe(false);
  });

  it("does not hold any other status", () => {
    expect(deployHoldsStatus({ status: "active", updatedAt: minutesAgo(1) }, now)).toBe(false);
    expect(deployHoldsStatus({ status: "error", updatedAt: minutesAgo(1) }, now)).toBe(false);
  });
});

describe("stabilityTransition", () => {
  const reason = (over: Partial<ExitReason> = {}): ExitReason => ({
    kind: "failed",
    exitCode: 1,
    containerId: "c1",
    containerName: "app-1",
    at: new Date().toISOString(),
    ...over,
  });

  it("records a crash the first time a status turns error", () => {
    expect(
      stabilityTransition({ from: "active", to: "error", reason: reason(), heldMs: null }),
    ).toEqual({ action: "app.crashed", summary: "Exited with code 1" });
  });

  it("does not record a second crash while the app stays error", () => {
    expect(
      stabilityTransition({ from: "error", to: "error", reason: reason(), heldMs: null }),
    ).toBeNull();
  });

  it("separates the two OOM causes in the summary", () => {
    expect(
      stabilityTransition({ from: "active", to: "error", reason: reason({ kind: "oom-host" }), heldMs: null })
        ?.summary,
    ).toContain("host's OOM killer");
    expect(
      stabilityTransition({ from: "active", to: "error", reason: reason({ kind: "oom-limit" }), heldMs: null })
        ?.summary,
    ).toContain("own memory limit");
  });

  it("falls back when Docker offered no reason", () => {
    expect(
      stabilityTransition({ from: "active", to: "error", reason: null, heldMs: null })?.summary,
    ).toBe("Container is restarting or dead");
  });

  it("records a recovery with how long it was down", () => {
    expect(
      stabilityTransition({ from: "error", to: "active", reason: null, heldMs: 25 * 60_000 }),
    ).toEqual({ action: "app.recovered", summary: "Running again after 25m down" });
  });

  it("leaves the duration out when nothing stamped the transition", () => {
    expect(
      stabilityTransition({ from: "error", to: "active", reason: null, heldMs: null })?.summary,
    ).toBe("Running again");
  });

  it("reads a long outage in hours and days", () => {
    expect(
      stabilityTransition({ from: "error", to: "active", reason: null, heldMs: 5 * 3_600_000 })?.summary,
    ).toBe("Running again after 5h down");
    expect(
      stabilityTransition({ from: "error", to: "active", reason: null, heldMs: 3 * 86_400_000 })?.summary,
    ).toBe("Running again after 3d down");
  });

  it("records nothing for a deliberate stop or a start from stopped", () => {
    expect(stabilityTransition({ from: "active", to: "stopped", reason: null, heldMs: null })).toBeNull();
    expect(stabilityTransition({ from: "stopped", to: "active", reason: null, heldMs: null })).toBeNull();
  });

  it("records nothing when a container simply goes missing", () => {
    expect(stabilityTransition({ from: "active", to: "missing", reason: null, heldMs: null })).toBeNull();
  });
});
