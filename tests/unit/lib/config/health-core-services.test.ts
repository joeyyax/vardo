import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { createServer, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

// The core service probes reach past the process: VictoriaLogs and the log shipper
// over HTTP, and the logs links through the apps table. Each of those is stubbed
// so the probe's own decisions are what's under test. Feature flags come from the
// environment, which resolves ahead of any settings read.

const state = vi.hoisted(() => ({
  admin: true,
  systemManagedApps: [] as { name: string }[],
}));

vi.mock("@/lib/auth/admin", () => ({
  isAppAdmin: async () => state.admin,
}));

// Reintroducing an active-org lookup would throw here and swallow every href.
vi.mock("@/lib/auth/session", () => ({
  getCurrentOrg: async () => {
    throw new Error("health links must not depend on the viewer's active org");
  },
}));

vi.mock("@/lib/db", () => ({
  db: {
    select: () => ({ from: () => ({ where: async () => state.systemManagedApps }) }),
  },
}));

import { checkServiceByName } from "@/lib/config/health";

// What a signed-in request passes; the worker passes nothing.
const request = { isAdmin: async () => state.admin };

const FLAG_VARS = [
  "VARDO_FEATURE_LOGGING",
  "VARDO_FEATURE_METRICS",
  "VARDO_FEATURE_SELF_MANAGEMENT",
];

async function listen(handler: (res: ServerResponse) => void): Promise<Server> {
  const server = createServer((_req, res) => handler(res));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return server;
}

function urlOf(server: Server): string {
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

async function close(server: Server): Promise<void> {
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

beforeEach(() => {
  for (const key of FLAG_VARS) process.env[key] = "true";
  state.admin = true;
  state.systemManagedApps = [];
});

afterEach(() => {
  for (const key of FLAG_VARS) delete process.env[key];
  delete process.env.VICTORIALOGS_URL;
  delete process.env.VARDO_LOG_SHIPPER_URL;
});

for (const probe of [
  { name: "VictoriaLogs", env: "VICTORIALOGS_URL" },
  { name: "Log shipper", env: "VARDO_LOG_SHIPPER_URL" },
]) {
  describe(`${probe.name} probe`, () => {
    it("reports healthy when /health answers", async () => {
      const server = await listen((res) => res.end("OK"));
      process.env[probe.env] = urlOf(server);

      await expect(checkServiceByName(probe.name, request)).resolves.toMatchObject({ name: probe.name, status: "healthy" });

      await close(server);
    });

    it("catches one that is up but erroring", async () => {
      const server = await listen((res) => {
        res.statusCode = 503;
        res.end();
      });
      process.env[probe.env] = urlOf(server);

      await expect(checkServiceByName(probe.name, request)).resolves.toMatchObject({ status: "unhealthy", error: "HTTP 503" });

      await close(server);
    });

    it("catches one that is gone, and recovers once it is back", async () => {
      const gone = await listen((res) => res.end("OK"));
      process.env[probe.env] = urlOf(gone);
      await close(gone);
      const status = await checkServiceByName(probe.name, request);
      expect(status?.status).toBe("unhealthy");
      expect(status?.error).toBeTruthy();

      const up = await listen((res) => res.end("OK"));
      process.env[probe.env] = urlOf(up);
      expect((await checkServiceByName(probe.name, request))?.status).toBe("healthy");
      await close(up);
    });
  });
}

describe("logs hrefs", () => {
  let shipper: Server;
  beforeEach(async () => {
    shipper = await listen((res) => res.end("OK"));
    process.env.VARDO_LOG_SHIPPER_URL = urlOf(shipper);
  });
  afterEach(() => close(shipper));

  it("resolves for an app admin whatever org they are looking at", async () => {
    state.systemManagedApps = [{ name: "log-shipper" }];

    await expect(checkServiceByName("Log shipper", request)).resolves.toMatchObject({
      logsHref: "/apps/log-shipper/logs",
    });
  });

  it("offers no link without a request, as in the worker", async () => {
    state.systemManagedApps = [{ name: "log-shipper" }];

    expect((await checkServiceByName("Log shipper"))?.logsHref).toBeUndefined();
  });

  it("offers no link to someone who is not an app admin", async () => {
    state.admin = false;
    state.systemManagedApps = [{ name: "log-shipper" }];

    expect((await checkServiceByName("Log shipper", request))?.logsHref).toBeUndefined();
  });

  it("offers no link when the logs tab is switched off", async () => {
    process.env.VARDO_FEATURE_LOGGING = "false";
    state.systemManagedApps = [{ name: "collector" }];

    expect((await checkServiceByName("Collector", request))?.logsHref).toBeUndefined();
  });

  it("offers no link for a service this instance does not run as an app", async () => {
    state.systemManagedApps = [];

    expect((await checkServiceByName("Log shipper", request))?.logsHref).toBeUndefined();
  });
});
