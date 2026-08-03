// ---------------------------------------------------------------------------
// Core services are checked but never offered.
//
// The registry answer is kept — a maintainer needs to see Vardo lagging
// upstream — while every count the operator acts on stays at zero, so nothing
// links to a pin the apply path refuses.
// ---------------------------------------------------------------------------

import { describe, it, expect, vi, beforeEach } from "vitest";

const { readCachedChecks, readIgnoreRules, readMajorGateBlock } = vi.hoisted(() => ({
  readCachedChecks: vi.fn(),
  readIgnoreRules: vi.fn(),
  readMajorGateBlock: vi.fn(),
}));

vi.mock("@/lib/docker/image-updates/check", () => ({
  readCachedChecks,
  CHECK_TTL_MS: 6 * 60 * 60 * 1000,
}));
vi.mock("@/lib/docker/image-updates/read-ignores", () => ({ readIgnoreRules }));
vi.mock("@/lib/docker/image-updates/major-gate-store", () => ({ readMajorGateBlock }));

import {
  getAppUpdateStatus,
  getFleetUpdateStatus,
} from "@/lib/docker/image-updates/status";

const LOKI_COMPOSE = "services:\n  loki:\n    image: grafana/loki:3.4\n";
const GLITCHTIP_COMPOSE =
  "services:\n  web:\n    image: glitchtip/glitchtip:latest\n  postgres:\n    image: postgres:17\n";
const TENANT_COMPOSE = "services:\n  app:\n    image: ghost:5\n";

function row(imageRef: string, latestTag: string) {
  return {
    imageRef,
    status: "update",
    latestTag,
    severity: "minor",
    remoteDigest: null,
    unorderable: [],
    available: [latestTag],
    majorAvailable: null,
    majorLocked: false,
    error: null,
    checkedAt: new Date(),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  readIgnoreRules.mockResolvedValue([]);
  readMajorGateBlock.mockResolvedValue(null);
  readCachedChecks.mockResolvedValue(
    new Map([
      ["docker.io/grafana/loki:3.4", row("docker.io/grafana/loki:3.4", "3.6")],
      ["docker.io/library/postgres:17", row("docker.io/library/postgres:17", "17.4")],
      ["docker.io/library/ghost:5", row("docker.io/library/ghost:5", "5.9")],
    ]),
  );
});

describe("getAppUpdateStatus — Vardo-managed apps", () => {
  it("keeps the rows and zeroes the counts for a core service", async () => {
    const status = await getAppUpdateStatus({
      id: "app-loki",
      name: "loki",
      isSystemManaged: true,
      deployType: "compose",
      imageName: null,
      composeContent: LOKI_COMPOSE,
      composeService: null,
    });

    expect(status.selfManaged).toBe(true);
    expect(status.updateCount).toBe(0);
    expect(status.highestSeverity).toBeNull();
    expect(status.services).toHaveLength(1);
    expect(status.services[0]).toMatchObject({ currentTag: "3.4", latestTag: "3.6" });
  });

  it("treats a decomposed core service's child row the same as the parent", async () => {
    const status = await getAppUpdateStatus({
      id: "app-glitchtip-postgres",
      // The name carries no instance-infra prefix — only the inherited flag does.
      name: "glitchtip-postgres",
      isSystemManaged: true,
      deployType: "compose",
      imageName: null,
      composeContent: GLITCHTIP_COMPOSE,
      composeService: "postgres",
    });

    expect(status.selfManaged).toBe(true);
    expect(status.updateCount).toBe(0);
    expect(status.services).toHaveLength(1);
    expect(status.services[0]).toMatchObject({ service: "postgres", latestTag: "17.4" });
  });

  it("classifies by name when the flag was never backfilled", async () => {
    const status = await getAppUpdateStatus({
      id: "app-loki",
      name: "loki",
      isSystemManaged: false,
      deployType: "compose",
      imageName: null,
      composeContent: LOKI_COMPOSE,
      composeService: null,
    });

    expect(status.selfManaged).toBe(true);
    expect(status.updateCount).toBe(0);
  });

  it("still offers a tenant app's update", async () => {
    const status = await getAppUpdateStatus({
      id: "app-blog",
      name: "blog",
      isSystemManaged: false,
      deployType: "compose",
      imageName: null,
      composeContent: TENANT_COMPOSE,
      composeService: null,
    });

    expect(status.selfManaged).toBe(false);
    expect(status.updateCount).toBe(1);
  });
});

describe("getFleetUpdateStatus — Vardo-managed apps", () => {
  const appRows = [
    {
      id: "app-loki",
      name: "loki",
      displayName: "Loki",
      isSystemManaged: true,
      deployType: "compose",
      imageName: null,
      composeContent: LOKI_COMPOSE,
      composeService: null,
    },
    {
      id: "app-glitchtip-postgres",
      name: "glitchtip-postgres",
      displayName: "Postgres",
      isSystemManaged: true,
      deployType: "compose",
      imageName: null,
      composeContent: GLITCHTIP_COMPOSE,
      composeService: "postgres",
    },
    {
      id: "app-blog",
      name: "blog",
      displayName: "Blog",
      isSystemManaged: false,
      deployType: "compose",
      imageName: null,
      composeContent: TENANT_COMPOSE,
      composeService: null,
    },
  ];

  it("lists core services separately and leaves them out of the totals", async () => {
    const fleet = await getFleetUpdateStatus("org-1", appRows, 0);

    expect(fleet.apps.map((a) => a.appId)).toEqual(["app-blog"]);
    expect(fleet.totalUpdates).toBe(1);
    expect(fleet.selfManaged.map((a) => a.appId)).toEqual([
      "app-loki",
      "app-glitchtip-postgres",
    ]);
    expect(fleet.selfManaged[0].services).toHaveLength(1);
  });

  it("never hands a core service to the ignore machinery", async () => {
    readIgnoreRules.mockResolvedValue([
      { id: "r1", appId: "app-loki", composeService: null, scope: "all", expiresAt: null },
    ]);

    const fleet = await getFleetUpdateStatus("org-1", appRows, 0);

    expect(fleet.ignored).toEqual([]);
    expect(fleet.selfManaged.some((a) => a.appId === "app-loki")).toBe(true);
  });
});
