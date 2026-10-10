import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ContainerMetrics } from "@/lib/metrics/types";

const GIB = 1_073_741_824;

const m = vi.hoisted(() => ({
  emit: vi.fn(),
  queryDiskWriteRange: vi.fn(),
  inspectContainer: vi.fn(),
  isBulkWriting: vi.fn(),
  findFirst: vi.fn(),
  claim: vi.fn(),
}));

vi.mock("@/lib/logger", () => ({ logger: { child: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }) } }));
vi.mock("@/lib/notifications/dispatch", () => ({ emit: m.emit }));
vi.mock("@/lib/metrics/store", () => ({ queryDiskWriteRange: m.queryDiskWriteRange }));
vi.mock("@/lib/docker/client", () => ({ inspectContainer: m.inspectContainer }));
vi.mock("@/lib/metrics/bulk-write", () => ({ isBulkWriting: m.isBulkWriting }));
vi.mock("@/lib/db", () => ({ db: { query: { apps: { findFirst: m.findFirst } } } }));
vi.mock("@/lib/notifications/throttle", () => ({ claimCooldown: m.claim }));

import { ALERT_COOLDOWN_MS, alertKey, alertName, checkDiskWriteAlerts, effectiveThreshold } from "@/lib/metrics/disk-write-alerts";

let seq = 0;
function container(overrides: Partial<ContainerMetrics> = {}): ContainerMetrics {
  seq += 1;
  return {
    containerId: `c${seq}`,
    containerIdFull: "",
    containerName: `app-blue-mysql-${seq}`,
    projectName: `proj${seq}`,
    organizationId: "org1",
    labels: { "vardo.project.id": "parent1", "com.docker.compose.service": "mysql" },
    ...overrides,
  } as ContainerMetrics;
}

const childApp = {
  id: "child1",
  displayName: "MySQL",
  organizationId: "org1",
  parentAppId: "parent1",
  composeService: "mysql",
  diskWriteAlertThreshold: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  m.isBulkWriting.mockResolvedValue(false);
  m.inspectContainer.mockResolvedValue({ image: "mysql:8" });
  m.findFirst.mockImplementation(async () => childApp);
  m.claim.mockResolvedValue(true);
});

function written(bytes: number) {
  m.queryDiskWriteRange.mockResolvedValue([[0, 0], [1, bytes]]);
}

describe("effectiveThreshold", () => {
  it("uses the app's own threshold first", () => {
    expect(effectiveThreshold(2 * GIB, true)).toBe(2 * GIB);
  });

  it("gives data engines 8 GiB and everything else 1 GiB", () => {
    expect(effectiveThreshold(null, true)).toBe(8 * GIB);
    expect(effectiveThreshold(null, false)).toBe(GIB);
  });
});

describe("checkDiskWriteAlerts", () => {
  it("names the app and stack, with readable byte figures", async () => {
    m.inspectContainer.mockResolvedValue({ image: "nginx" });
    m.findFirst
      .mockResolvedValueOnce(childApp)
      .mockResolvedValueOnce({ displayName: "Shop Staging" });
    written(8_270_499_840);
    await checkDiskWriteAlerts([container()]);
    expect(m.emit).toHaveBeenCalledOnce();
    const event = m.emit.mock.calls[0][1];
    expect(event).toMatchObject({
      appName: "MySQL",
      projectName: "Shop Staging",
      composeService: "mysql",
      thresholdBytes: GIB,
    });
    expect(event.message).toContain("7.7 GiB");
    expect(event.message).toContain("1 GiB");
  });

  it("holds a database under 8 GiB", async () => {
    written(5 * GIB);
    await checkDiskWriteAlerts([container()]);
    expect(m.emit).not.toHaveBeenCalled();
  });

  it("alerts a database over 8 GiB and flags it as a data engine", async () => {
    written(9 * GIB);
    await checkDiskWriteAlerts([container()]);
    expect(m.emit.mock.calls[0][1]).toMatchObject({ dataEngine: true, thresholdBytes: 8 * GIB });
  });

  it("honors an app's own threshold on a database", async () => {
    m.findFirst.mockResolvedValue({ ...childApp, diskWriteAlertThreshold: 2 * GIB });
    written(3 * GIB);
    await checkDiskWriteAlerts([container()]);
    expect(m.emit.mock.calls[0][1]).toMatchObject({ dataEngine: false, thresholdBytes: 2 * GIB });
  });

  it("stays quiet while an import or restore marker is set", async () => {
    m.isBulkWriting.mockResolvedValue(true);
    written(20 * GIB);
    await checkDiskWriteAlerts([container()]);
    expect(m.emit).not.toHaveBeenCalled();
    expect(m.isBulkWriting).toHaveBeenCalledWith(["parent1", "child1", "parent1"]);
  });
});

describe("disk write alert throttle and names", () => {
  it("holds each container for six hours", () => {
    expect(ALERT_COOLDOWN_MS).toBe(6 * 60 * 60 * 1000);
  });

  it("keys on the compose service, so a blue-green swap doesn't alert again", () => {
    const blue = { containerId: "aaa", containerName: "shop-production-blue-mysql-1", labels: { "com.docker.compose.service": "mysql" } };
    const green = { containerId: "bbb", containerName: "shop-production-green-mysql-1", labels: { "com.docker.compose.service": "mysql" } };
    expect(alertKey("shop", blue)).toBe(alertKey("shop", green));
  });

  it("sends once per container until the cooldown passes", async () => {
    const c = container();
    written(9 * GIB);
    await checkDiskWriteAlerts([c]);
    await checkDiskWriteAlerts([{ ...c, containerId: "swapped" }]);
    expect(m.emit).toHaveBeenCalledOnce();
  });

  it("leaves the email to another console that already sent it", async () => {
    m.claim.mockResolvedValue(false);
    written(9 * GIB);
    await checkDiskWriteAlerts([container()]);
    expect(m.emit).not.toHaveBeenCalled();
  });

  it("names an app it can't resolve by its service and project, never the raw container", async () => {
    m.findFirst.mockResolvedValue(undefined);
    m.inspectContainer.mockResolvedValue({ image: "nginx" });
    written(2 * GIB);
    await checkDiskWriteAlerts([container({ projectName: "shop-staging-data", containerName: "shop-staging-data-production-blue-mysql-1" })]);
    const event = m.emit.mock.calls[0][1];
    expect(event.title).toBe("High disk writes: shop-staging-data mysql");
    expect(event).toMatchObject({ appName: "mysql", projectName: "shop-staging-data" });
  });

  it("puts the stack before the app's own name", () => {
    expect(alertName({ displayName: "MySQL" }, "Shop Staging", { containerName: "x", labels: {} }, "p")).toEqual({ name: "MySQL", stack: "Shop Staging" });
    expect(alertName(undefined, undefined, { containerName: "lone-1", labels: {} }, "p")).toEqual({ name: "lone-1" });
  });
});
