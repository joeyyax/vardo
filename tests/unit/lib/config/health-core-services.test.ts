import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { createServer, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

// The core service probes reach past the process: Loki over HTTP, Promtail over
// the Docker socket, and the logs links through the apps table. Each of those is
// stubbed so the probe's own decisions are what's under test. Feature flags come
// from the environment, which resolves ahead of any settings read.

const state = vi.hoisted(() => ({
  admin: true,
  promtailContainers: [] as unknown[],
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

vi.mock("@/lib/docker/client", () => ({
  listContainers: async () => state.promtailContainers,
}));

vi.mock("@/lib/db", () => ({
  db: {
    select: () => ({ from: () => ({ where: async () => state.systemManagedApps }) }),
  },
}));

import { checkServiceByName } from "@/lib/config/health";

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
  state.promtailContainers = [];
  state.systemManagedApps = [];
});

afterEach(() => {
  for (const key of FLAG_VARS) delete process.env[key];
  delete process.env.LOKI_URL;
});

// ---------------------------------------------------------------------------
// Loki
// ---------------------------------------------------------------------------

describe("Loki probe", () => {
  it("reports healthy when the API answers", async () => {
    const server = await listen((res) => res.end("ready"));
    process.env.LOKI_URL = urlOf(server);

    await expect(checkServiceByName("Loki")).resolves.toMatchObject({
      name: "Loki",
      status: "healthy",
    });

    await close(server);
  });

  it("catches a Loki that is up but erroring", async () => {
    const server = await listen((res) => {
      res.statusCode = 502;
      res.end();
    });
    process.env.LOKI_URL = urlOf(server);

    await expect(checkServiceByName("Loki")).resolves.toMatchObject({
      status: "unhealthy",
      error: "HTTP 502",
    });

    await close(server);
  });

  it("catches a Loki that is gone", async () => {
    const server = await listen((res) => res.end("ready"));
    const url = urlOf(server);
    await close(server);
    process.env.LOKI_URL = url;

    const status = await checkServiceByName("Loki");
    expect(status?.status).toBe("unhealthy");
    expect(status?.error).toBeTruthy();
  });

  it("recovers on the next check once it is back", async () => {
    const down = await listen((res) => {
      res.statusCode = 503;
      res.end();
    });
    process.env.LOKI_URL = urlOf(down);
    expect((await checkServiceByName("Loki"))?.status).toBe("unhealthy");
    await close(down);

    const up = await listen((res) => res.end("ready"));
    process.env.LOKI_URL = urlOf(up);
    expect((await checkServiceByName("Loki"))?.status).toBe("healthy");
    await close(up);
  });
});

// ---------------------------------------------------------------------------
// Promtail — no reachable API, so a running container is the signal
// ---------------------------------------------------------------------------

describe("Promtail probe", () => {
  it("reports healthy while its container runs", async () => {
    state.promtailContainers = [{ id: "abc", name: "vardo-promtail", state: "running" }];

    await expect(checkServiceByName("Promtail")).resolves.toMatchObject({
      name: "Promtail",
      status: "healthy",
    });
  });

  it("catches a Promtail that has stopped shipping", async () => {
    state.promtailContainers = [];

    await expect(checkServiceByName("Promtail")).resolves.toMatchObject({
      status: "unhealthy",
      error: "not running",
    });
  });
});

// ---------------------------------------------------------------------------
// Logs links
// ---------------------------------------------------------------------------

describe("logs hrefs", () => {
  it("resolves for an app admin whatever org they are looking at", async () => {
    state.promtailContainers = [{ id: "abc" }];
    state.systemManagedApps = [{ name: "promtail" }];

    await expect(checkServiceByName("Promtail")).resolves.toMatchObject({
      logsHref: "/apps/promtail/logs",
    });
  });

  it("offers no link to someone who is not an app admin", async () => {
    state.admin = false;
    state.promtailContainers = [{ id: "abc" }];
    state.systemManagedApps = [{ name: "promtail" }];

    expect((await checkServiceByName("Promtail"))?.logsHref).toBeUndefined();
  });

  it("offers no link when the logs tab is switched off", async () => {
    process.env.VARDO_FEATURE_LOGGING = "false";
    state.systemManagedApps = [{ name: "cadvisor" }];

    expect((await checkServiceByName("cAdvisor"))?.logsHref).toBeUndefined();
  });

  it("offers no link for a service this instance does not run as an app", async () => {
    state.promtailContainers = [{ id: "abc" }];
    state.systemManagedApps = [];

    expect((await checkServiceByName("Promtail"))?.logsHref).toBeUndefined();
  });
});
