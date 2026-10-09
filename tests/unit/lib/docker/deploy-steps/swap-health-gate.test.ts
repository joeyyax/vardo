// ---------------------------------------------------------------------------
// The health gate fails closed. A service with no Docker healthcheck is ready
// only once it has kept accepting connections for a sustained window; a
// refused connection or a timeout is never healthy. A failure says whether the
// slot crashed, reported unhealthy or was still starting.
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

import { healthFailureMessage, healthGraceCap, routedPort, tcpProbe, waitForHealthy } from "@/lib/docker/deploy-steps/swap";
import type { ComposeService } from "@/lib/docker/compose-types";

const FAST = { intervalMs: 5, stableMs: 40, logActiveMs: 20 };

/** `docker inspect` answers with the next restart count per call, holding the last; `docker logs` with `output`. */
function psReturns(container: Record<string, string>, restarts: number[] = [0], output = "") {
  const list = [container];
  let inspects = 0;
  execFileAsyncMock.mockImplementation(async (_cmd: string, args: string[]) => {
    if (args[0] === "logs") return { stdout: output, stderr: "" };
    if (args[0] === "inspect") {
      const count = restarts[Math.min(inspects++, restarts.length - 1)];
      const stdout = list
        .filter((c) => !c.Health || args.includes(c.Name))
        .map((c) => `/${c.Name} ${count} ${c.State}`)
        .join("\n");
      return { stdout, stderr: "" };
    }
    return { stdout: list.map((c) => JSON.stringify(c)).join("\n"), stderr: "" };
  });
}

function gate(probe?: () => Promise<boolean>, timeoutMs = 300) {
  const logs: string[] = [];
  const result = waitForHealthy("app-production-green", [], "/tmp", { push: (l) => logs.push(l) }, timeoutMs, probe, FAST);
  return { result, logs };
}

const composer = { Service: "composer", Name: "composer-production-blue-composer-1", State: "running", Health: "" };

beforeEach(() => {
  execFileAsyncMock.mockReset();
});

describe("waitForHealthy", () => {
  it("fails a running service whose port refuses every connection", async () => {
    psReturns({ Service: "web", Name: "app-production-green-web-1", State: "running", Health: "" });
    const probe = vi.fn().mockResolvedValue(false);

    const { result, logs } = gate(probe);

    expect((await result).kind).toBe("not-ready");
    expect(probe).toHaveBeenCalled();
    expect(logs.at(-1)).toContain("Timeout");
  });

  it("does not pass on a single success", async () => {
    psReturns({ Service: "web", Name: "app-production-green-web-1", State: "running", Health: "" });
    const probe = vi.fn().mockResolvedValueOnce(true).mockResolvedValue(false);

    expect((await gate(probe).result).kind).not.toBe("healthy");
  });

  it("passes once the probe keeps succeeding for the window", async () => {
    psReturns({ Service: "web", Name: "app-production-green-web-1", State: "running", Health: "" });
    const probe = vi.fn().mockResolvedValue(true);

    expect((await gate(probe).result).kind).toBe("healthy");
    expect(probe.mock.calls.length).toBeGreaterThan(1);
  });

  it("restarts the window when the service flaps", async () => {
    psReturns({ Service: "web", Name: "app-production-green-web-1", State: "running", Health: "" });
    let calls = 0;
    // Up, down, then up for good: must not pass on the first run of successes.
    const probe = vi.fn(async () => {
      calls++;
      return calls !== 3;
    });
    const started = Date.now();

    expect((await gate(probe).result).kind).toBe("healthy");
    expect(Date.now() - started).toBeGreaterThanOrEqual(FAST.stableMs);
    expect(calls).toBeGreaterThan(3);
  });

  it("fails a container stuck restarting", async () => {
    psReturns({ Service: "web", Name: "app-production-green-web-1", State: "restarting", Health: "" });

    expect((await gate(vi.fn().mockResolvedValue(true)).result).kind).toBe("crashed");
  });

  it("holds an unprobed service to the running window", async () => {
    psReturns({ Service: "worker", Name: "app-production-green-worker-1", State: "running", Health: "" });
    const started = Date.now();

    expect((await gate(undefined).result).kind).toBe("healthy");
    expect(Date.now() - started).toBeGreaterThanOrEqual(FAST.stableMs);
  });

  it("trusts Docker's healthcheck without a window", async () => {
    psReturns({ Service: "web", Name: "app-production-green-web-1", State: "running", Health: "healthy" });
    const probe = vi.fn().mockResolvedValue(false);

    expect((await gate(probe).result).kind).toBe("healthy");
    expect(probe).not.toHaveBeenCalled();
  });

  it("fails a service with no healthcheck that keeps restarting between running checks", async () => {
    psReturns({ Service: "formbricks", Name: "formbricks-production-blue-formbricks-1", State: "running", Health: "" }, [0, 1, 2, 3]);

    const { result, logs } = gate(undefined, 10_000);

    expect((await result).kind).toBe("crashed");
    expect(logs.at(-1)).toContain("crash-looping");
  });

  it("restarts the window after a restart and passes once stable", async () => {
    psReturns({ Service: "web", Name: "app-production-green-web-1", State: "running", Health: "" }, [0, 0, 1]);
    const started = Date.now();

    expect((await gate(undefined).result).kind).toBe("healthy");
    expect(Date.now() - started).toBeGreaterThanOrEqual(FAST.stableMs);
  });

  it("does not inspect restarts for a healthchecked service", async () => {
    psReturns({ Service: "web", Name: "app-production-green-web-1", State: "running", Health: "healthy" }, [5]);

    expect((await gate(undefined).result).kind).toBe("healthy");
    expect(execFileAsyncMock.mock.calls.some(([, args]) => args[0] === "inspect")).toBe(false);
  });

  it("fails closed when compose cannot be queried", async () => {
    execFileAsyncMock.mockRejectedValue(new Error("docker daemon unreachable"));

    expect((await gate(vi.fn().mockResolvedValue(true)).result).kind).not.toBe("healthy");
  });

  it("fails an exited container at once", async () => {
    psReturns({ Service: "web", Name: "app-production-green-web-1", State: "exited", Health: "" });

    expect((await gate(vi.fn().mockResolvedValue(true), 10_000).result)).toEqual({ kind: "crashed", service: "web", detail: "exited" });
  });
});

describe("waitForHealthy — slow starts", () => {
  it("extends the wait for a running service still writing logs, then calls it starting", async () => {
    psReturns(composer, [0], "Scanning packages");
    const started = Date.now();

    const { result, logs } = gate(vi.fn().mockResolvedValue(false), 50);
    const verdict = await result;

    expect(verdict.kind).toBe("starting");
    expect(Date.now() - started).toBeGreaterThanOrEqual(healthGraceCap(50) - 10);
    expect(logs.some((l) => l.includes("extending the wait"))).toBe(true);
    expect(logs.at(-1)).toContain("composer: still starting");
    expect(logs.some((l) => l.includes("crash"))).toBe(false);
  });

  it("passes a slow start that becomes ready during the grace", async () => {
    psReturns(composer, [0], "Scanning packages");
    const started = Date.now();
    const probe = vi.fn(async () => Date.now() - started > 70);

    const { result, logs } = gate(probe, 60);

    expect((await result).kind).toBe("healthy");
    expect(logs.some((l) => l.includes("extending the wait"))).toBe(true);
  });

  it("does not extend a running service with quiet logs", async () => {
    psReturns(composer, [0], "");
    const started = Date.now();

    const { result, logs } = gate(vi.fn().mockResolvedValue(false), 50);

    expect((await result).kind).toBe("not-ready");
    expect(Date.now() - started).toBeLessThan(healthGraceCap(50));
    expect(logs.some((l) => l.includes("extending"))).toBe(false);
  });

  it("calls a restart during the wait a crash, even with logs moving", async () => {
    psReturns(composer, [0, 1], "booting");

    const { result, logs } = gate(vi.fn().mockResolvedValue(false), 50);

    expect(await result).toMatchObject({ kind: "crashed", service: "composer" });
    expect(logs.some((l) => l.includes("extending"))).toBe(false);
  });

  it("extends a healthchecked service still in its start period", async () => {
    psReturns({ ...composer, Health: "starting" }, [0], "warming up");

    expect((await gate(undefined, 50).result).kind).toBe("starting");
  });

  it("calls a healthchecked service that restarted into starting a crash", async () => {
    psReturns({ ...composer, Health: "starting" }, [2], "warming up");

    expect(await gate(undefined, 50).result).toMatchObject({ kind: "crashed", detail: "2 restarts" });
  });

  it("reports a failing healthcheck as unhealthy", async () => {
    psReturns({ ...composer, Health: "unhealthy" }, [0], "still logging");

    expect(await gate(undefined, 50).result).toMatchObject({ kind: "unhealthy", service: "composer" });
  });
});

describe("healthGraceCap", () => {
  it("allows three times the timeout up to 600s", () => {
    expect(healthGraceCap(60_000)).toBe(180_000);
    expect(healthGraceCap(300_000)).toBe(600_000);
    expect(healthGraceCap(900_000)).toBe(900_000);
  });
});

describe("healthFailureMessage", () => {
  it("tells a slow start how to get more time without calling it a crash", () => {
    const message = healthFailureMessage({ kind: "starting", service: "composer", waitedMs: 70_900 }, "blue");

    expect(message).toBe(
      "composer is still starting after 71s (running, no restarts, logs still moving). Raise the app's health timeout (Settings → Health check timeout) or add a healthcheck with a start_period",
    );
    expect(message).not.toMatch(/crash/);
  });

  it("names the crash", () => {
    expect(healthFailureMessage({ kind: "crashed", service: "web", detail: "exited" }, "green")).toBe(
      "green slot did not become healthy: web crashed (exited). See logs above",
    );
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
