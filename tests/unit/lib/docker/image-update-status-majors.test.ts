// New majors are informational: never in update counts, attention or the digest's update list.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { readCachedChecks, readIgnoreRules, readMajorGateBlock, readTrackPolicies } = vi.hoisted(() => ({
  readCachedChecks: vi.fn(),
  readIgnoreRules: vi.fn(),
  readMajorGateBlock: vi.fn(),
  readTrackPolicies: vi.fn(),
}));

vi.mock("@/lib/docker/image-updates/check", () => ({
  readCachedChecks,
  CHECK_TTL_MS: 6 * 60 * 60 * 1000,
}));
vi.mock("@/lib/docker/image-updates/read-ignores", () => ({ readIgnoreRules }));
vi.mock("@/lib/docker/image-updates/read-tracks", () => ({ readTrackPolicies }));
vi.mock("@/lib/docker/image-updates/major-gate-store", () => ({ readMajorGateBlock }));

import {
  getAggregateUpdateStatus,
  getAppUpdateStatus,
  getFleetUpdateStatus,
} from "@/lib/docker/image-updates/status";
import { majorNoticeRows } from "@/lib/attention/major-notice-rows";
import { summarize } from "@/lib/ui/attention";

const NOW = new Date("2026-10-10T12:00:00Z");

function row(
  imageRef: string,
  fields: Partial<{ status: string; latestTag: string | null; severity: string | null; available: string[]; majorAvailable: string | null }>,
) {
  return {
    imageRef,
    status: "current",
    latestTag: null,
    severity: null,
    remoteDigest: null,
    unorderable: [],
    available: [],
    majorAvailable: null,
    majorLocked: false,
    error: null,
    checkedAt: NOW,
    ...fields,
  };
}

const COMPOSE = [
  "services:",
  "  web:",
  "    image: ghost:5.2",
  "  db:",
  "    image: postgres:16",
  "  old:",
  "    image: postgres:14",
  "  proxy:",
  "    image: nginx:1.25",
].join("\n");

const app = {
  id: "app-1",
  name: "blog",
  displayName: "Blog",
  deployType: "compose",
  imageName: null,
  composeContent: COMPOSE,
  composeService: null,
  isSystemManaged: false,
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  readIgnoreRules.mockResolvedValue([]);
  readTrackPolicies.mockResolvedValue([]);
  readMajorGateBlock.mockResolvedValue(null);
  readCachedChecks.mockResolvedValue(
    new Map([
      // Patch within the running major plus a new major.
      ["docker.io/library/ghost:5.2", row("docker.io/library/ghost:5.2", { status: "update", latestTag: "5.3", severity: "minor", available: ["6.0", "5.3"], majorAvailable: "6.0" })],
      // Only a major: older rows called this an update.
      ["docker.io/library/postgres:16", row("docker.io/library/postgres:16", { status: "update", available: ["18", "17"], majorAvailable: "18" })],
      // Near end of life.
      ["docker.io/library/postgres:14", row("docker.io/library/postgres:14", { available: ["18"], majorAvailable: "18" })],
      // Older row: a major sitting in latestTag.
      ["docker.io/library/nginx:1.25", row("docker.io/library/nginx:1.25", { status: "update", latestTag: "2.0", severity: "major", available: ["2.0"] })],
    ]),
  );
});

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

const byService = <T extends { service: string | null }>(services: T[], name: string): T =>
  services.find((s) => s.service === name)!;

describe("getAppUpdateStatus", () => {
  it("counts only updates within the running major", async () => {
    const status = await getAppUpdateStatus(app);
    expect(status.updateCount).toBe(1);
    expect(status.highestSeverity).toBe("minor");
    // ghost and nginx follow latest; both postgres services stay on their major.
    expect(status.majorCount).toBe(2);
    expect(status.heldCount).toBe(2);
  });

  it("reclassifies older rows", async () => {
    const status = await getAppUpdateStatus(app);
    expect(byService(status.services, "db")).toMatchObject({ status: "current", latestTag: null, majorAvailable: "18", majorHeld: true });
    expect(byService(status.services, "proxy")).toMatchObject({ status: "current", latestTag: null, majorAvailable: "2.0", majorHeld: false });
    expect(byService(status.services, "web")).toMatchObject({ latestTag: "5.3", available: ["5.3"], majorTags: ["6.0"] });
  });

  it("applies the default track by image", async () => {
    const status = await getAppUpdateStatus(app);
    expect(byService(status.services, "db").track).toEqual({ mode: "major", explicit: false, major: 16 });
    expect(byService(status.services, "web").track).toEqual({ mode: "latest", explicit: false, major: 5 });
  });

  it("follows an explicit policy, keyed by the compose owner", async () => {
    const status = await getAppUpdateStatus(
      { ...app, id: "child-1", composeService: "db", composeOwnerId: "app-1" },
      [],
      [{ appId: "app-1", composeService: "db", mode: "latest" }],
    );
    expect(status.services).toHaveLength(1);
    expect(status.services[0]).toMatchObject({ majorHeld: false, track: { mode: "latest", explicit: true } });
    expect(status.majorCount).toBe(1);
    expect(status.updateCount).toBe(0);
  });

  it("holds a major under an active ignore rule", async () => {
    const status = await getAppUpdateStatus(app, [
      { id: "r1", appId: "app-1", composeService: "proxy", scope: "major", expiresAt: null },
    ]);
    expect(byService(status.services, "proxy").majorHeld).toBe(true);
    expect(status.majorCount).toBe(1);
  });

  it("flags the running major near end of life", async () => {
    const status = await getAppUpdateStatus(app);
    expect(byService(status.services, "old").reasons).toMatchObject([{ kind: "eol", notice: { series: "14", state: "ending" } }]);
    expect(byService(status.services, "db").reasons).toEqual([]);
  });
});

describe("fleet and aggregate", () => {
  it("leaves majors out of totals and lists them apart", async () => {
    const fleet = await getFleetUpdateStatus("org-1", [app], 0);
    expect(fleet.totalUpdates).toBe(1);
    expect(fleet.apps[0].services.map((s) => s.service)).toEqual(["web"]);
    expect(fleet.majors.map((m) => m.service.service)).toEqual(["web", "proxy", "db", "old"]);
    expect(fleet.majorNotices.map((m) => m.service.service)).toEqual(["old"]);
  });

  it("reports no updates when every newer tag is a major", async () => {
    readCachedChecks.mockResolvedValue(
      new Map([["docker.io/library/postgres:16", row("docker.io/library/postgres:16", { status: "update", available: ["17"], majorAvailable: "17" })]]),
    );
    const aggregate = await getAggregateUpdateStatus(
      "org-1",
      [{ ...app, composeContent: "services:\n  db:\n    image: postgres:16\n" }],
      0,
    );
    expect(aggregate.totalUpdates).toBe(0);
    expect(aggregate.appsWithUpdates).toEqual([]);
    expect(aggregate.majorNotices).toEqual([]);
  });

  it("turns notices into a lifecycle attention row with plain wording", async () => {
    const aggregate = await getAggregateUpdateStatus("org-1", [app], 0);
    const rows = majorNoticeRows(aggregate.majorNotices);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ group: "lifecycle", tone: "warning" });
    expect(rows[0].items[0]).toMatchObject({
      name: "Blog · old",
      href: "/apps/blog/updates",
      detail: "PostgreSQL 14 stops getting security fixes on Nov 12, 2026. 18 is out.",
    });
    expect(summarize(rows).groups.map((g) => g.key)).toEqual(["lifecycle"]);
  });

  it("adds no attention row without a reason", () => {
    expect(majorNoticeRows([])).toEqual([]);
  });
});
