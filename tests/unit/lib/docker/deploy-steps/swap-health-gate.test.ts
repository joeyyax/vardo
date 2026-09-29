// ---------------------------------------------------------------------------
// The health gate fails closed. A service with no Docker healthcheck is ready
// only once it has kept accepting connections for a sustained window; a
// refused connection or a timeout is never healthy.
// ---------------------------------------------------------------------------

import { describe, it, expect, vi, beforeEach } from "vitest";
import { createServer, type Server } from "net";

const { execFileAsyncMock, execFileMock } = vi.hoisted(() => {
  const execFileAsyncMock = vi.fn();
  const execFileMock = vi.fn();
  Object.defineProperty(execFileMock, Symbol.for("nodejs.util.promisify.custom"), {
    value: execFileAsyncMock,
    configurable: true,
    writable: true,
  });
  return { execFileAsyncMock, execFileMock };
});

vi.mock("child_process", () => ({ execFile: execFileMock }));
vi.mock("@/lib/db", () => ({ db: {} }));

import { routedPort, tcpProbe, waitForHealthy } from "@/lib/docker/deploy-steps/swap";
import type { ComposeService } from "@/lib/docker/compose-types";

const FAST = { intervalMs: 5, stableMs: 40 };

function psReturns(...containers: Record<string, string>[]) {
  execFileAsyncMock.mockResolvedValue({
    stdout: containers.map((c) => JSON.stringify(c)).join("\n"),
    stderr: "",
  });
}

function gate(probe?: () => Promise<boolean>, timeoutMs = 300) {
  const logs: string[] = [];
  const result = waitForHealthy("app-production-green", [], "/tmp", { push: (l) => logs.push(l) }, timeoutMs, probe, FAST);
  return { result, logs };
}

beforeEach(() => {
  execFileAsyncMock.mockReset();
});

describe("waitForHealthy", () => {
  it("fails a running service whose port refuses every connection", async () => {
    psReturns({ Service: "web", State: "running", Health: "" });
    const probe = vi.fn().mockResolvedValue(false);

    const { result, logs } = gate(probe);

    expect(await result).toBe(false);
    expect(probe).toHaveBeenCalled();
    expect(logs.at(-1)).toContain("Timeout");
  });

  it("does not pass on a single success", async () => {
    psReturns({ Service: "web", State: "running", Health: "" });
    const probe = vi.fn().mockResolvedValueOnce(true).mockResolvedValue(false);

    expect(await gate(probe).result).toBe(false);
  });

  it("passes once the probe keeps succeeding for the window", async () => {
    psReturns({ Service: "web", State: "running", Health: "" });
    const probe = vi.fn().mockResolvedValue(true);

    expect(await gate(probe).result).toBe(true);
    expect(probe.mock.calls.length).toBeGreaterThan(1);
  });

  it("restarts the window when the service flaps", async () => {
    psReturns({ Service: "web", State: "running", Health: "" });
    let calls = 0;
    // Up, down, then up for good: must not pass on the first run of successes.
    const probe = vi.fn(async () => {
      calls++;
      return calls !== 3;
    });
    const started = Date.now();

    expect(await gate(probe).result).toBe(true);
    expect(Date.now() - started).toBeGreaterThanOrEqual(FAST.stableMs);
    expect(calls).toBeGreaterThan(3);
  });

  it("fails a container stuck restarting", async () => {
    psReturns({ Service: "web", State: "restarting", Health: "" });

    expect(await gate(vi.fn().mockResolvedValue(true)).result).toBe(false);
  });

  it("holds an unprobed service to the running window", async () => {
    psReturns({ Service: "worker", State: "running", Health: "" });
    const started = Date.now();

    expect(await gate(undefined).result).toBe(true);
    expect(Date.now() - started).toBeGreaterThanOrEqual(FAST.stableMs);
  });

  it("trusts Docker's healthcheck without a window", async () => {
    psReturns({ Service: "web", State: "running", Health: "healthy" });
    const probe = vi.fn().mockResolvedValue(false);

    expect(await gate(probe).result).toBe(true);
    expect(probe).not.toHaveBeenCalled();
  });

  it("fails closed when compose cannot be queried", async () => {
    execFileAsyncMock.mockRejectedValue(new Error("docker daemon unreachable"));

    expect(await gate(vi.fn().mockResolvedValue(true)).result).toBe(false);
  });

  it("fails an exited container at once", async () => {
    psReturns({ Service: "web", State: "exited", Health: "" });

    expect(await gate(vi.fn().mockResolvedValue(true), 10_000).result).toBe(false);
  });
});

describe("tcpProbe", () => {
  let server: Server;

  it("succeeds against a listening port", async () => {
    server = createServer((s) => s.end());
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const { port } = server.address() as { port: number };

    expect(await tcpProbe("127.0.0.1", port, 1000)()).toBe(true);
    await new Promise((r) => server.close(r));
  });

  it("fails against a refused port", async () => {
    server = createServer();
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const { port } = server.address() as { port: number };
    await new Promise((r) => server.close(r));

    expect(await tcpProbe("127.0.0.1", port, 1000)()).toBe(false);
  });
});

describe("routedPort", () => {
  it("reads the port Traefik routes to", () => {
    const svc = {
      labels: { "traefik.http.services.app-web.loadbalancer.server.port": "8080" },
    } as unknown as ComposeService;
    expect(routedPort(svc)).toBe(8080);
  });

  it("returns null without one", () => {
    expect(routedPort({ labels: {} } as unknown as ComposeService)).toBeNull();
    expect(routedPort(undefined)).toBeNull();
  });
});
