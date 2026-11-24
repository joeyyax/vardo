import { describe, expect, it, vi } from "vitest";

import { appLogSource } from "@/lib/logging/source";
import type { ContainerInfo } from "@/lib/docker/client";

// An install upgraded from Loki keeps running containers deployed without a log
// account. The shipper sends those to tenant 0, so the viewer reads them from
// Docker until the app's next deploy labels them.

const APP = { id: "a1", name: "shop" };

function container(labels: Record<string, string>): ContainerInfo {
  return { id: "c", name: "shop-blue-web-1", image: "x", state: "running", status: "Up", ports: [], labels };
}

const up = async () => true;

describe("appLogSource", () => {
  it("reads VictoriaLogs once every running container carries its log account", async () => {
    const containers = vi.fn(async () => [container({ "vardo.log.account": "7" }), container({ "vardo.log.account": "7" })]);
    expect(await appLogSource(APP, "production", { available: up, containers })).toBe("victorialogs");
    expect(containers).toHaveBeenCalledWith(APP, "production");
  });

  it("reads Docker while any running container predates log accounts", async () => {
    const containers = async () => [container({ "vardo.log.account": "7" }), container({ "vardo.project": "shop" })];
    expect(await appLogSource(APP, "production", { available: up, containers })).toBe("docker");
  });

  it("reads Docker when VictoriaLogs is down", async () => {
    const containers = vi.fn(async () => [container({ "vardo.log.account": "7" })]);
    expect(await appLogSource(APP, "production", { available: async () => false, containers })).toBe("docker");
    expect(containers).not.toHaveBeenCalled();
  });

  it("reads VictoriaLogs for an app with nothing running, whose history is stored", async () => {
    expect(await appLogSource(APP, "production", { available: up, containers: async () => [] })).toBe("victorialogs");
  });
});
