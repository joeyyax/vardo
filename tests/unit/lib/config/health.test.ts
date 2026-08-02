import { describe, it, expect, afterEach } from "vitest";
import { createServer, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { checkServiceByName, probeErrorText, sanitizeError, SERVICE_PROBES } from "@/lib/config/health";

// ---------------------------------------------------------------------------
// sanitizeError — strips sensitive internals from library error messages
// ---------------------------------------------------------------------------
// ioredis connection failures can expose internal host:port and connection URLs.
// pg/Drizzle errors can expose role, database, and user names.
// This verifies redaction is both correct (catches real patterns) and
// conservative (doesn't corrupt unrelated messages).

describe("sanitizeError", () => {
  // --- Redis/connection URL patterns ---

  it("strips a redis:// URL", () => {
    expect(sanitizeError("connect ECONNREFUSED redis://localhost:6379")).toBe(
      "connect ECONNREFUSED [url]"
    );
  });

  it("strips a redis URL with credentials", () => {
    expect(sanitizeError("connect ECONNREFUSED redis://:password@10.0.0.1:6379/0")).toBe(
      "connect ECONNREFUSED [url]"
    );
  });

  it("strips a postgres:// URL", () => {
    expect(sanitizeError("connect ECONNREFUSED postgres://localhost:5432/vardo")).toBe(
      "connect ECONNREFUSED [url]"
    );
  });

  it("strips a postgresql:// URL", () => {
    expect(sanitizeError("connection failed: postgresql://user:pass@db.internal:5432/prod")).toBe(
      "connection failed: [url]"
    );
  });

  // --- IPv4 host patterns ---

  it("strips an IPv4 address with port", () => {
    expect(sanitizeError("connect ECONNREFUSED 127.0.0.1:6379")).toBe(
      "connect ECONNREFUSED [host]"
    );
  });

  it("strips a private IPv4 address with port", () => {
    expect(sanitizeError("connect ECONNREFUSED 10.0.0.1:5432")).toBe(
      "connect ECONNREFUSED [host]"
    );
  });

  it("strips an IPv4 address without port", () => {
    expect(sanitizeError("host unreachable: 192.168.1.100")).toBe(
      "host unreachable: [host]"
    );
  });

  // --- localhost patterns ---

  it("strips localhost with port", () => {
    expect(sanitizeError("ECONNREFUSED localhost:7200")).toBe(
      "ECONNREFUSED [host]"
    );
  });

  it("strips bare localhost", () => {
    expect(sanitizeError("cannot connect to localhost")).toBe(
      "cannot connect to [host]"
    );
  });

  // --- pg role/database/user name patterns ---

  it("strips pg user name from authentication errors", () => {
    expect(sanitizeError('password authentication failed for user "postgres"')).toBe(
      'password authentication failed for user [name]'
    );
  });

  it("strips pg role name", () => {
    expect(sanitizeError('permission denied for role "vardo_admin"')).toBe(
      'permission denied for role [name]'
    );
  });

  it("strips pg database name", () => {
    expect(sanitizeError('database "vardo_prod" does not exist')).toBe(
      'database [name] does not exist'
    );
  });

  // --- Length cap ---

  it("caps messages at 120 characters", () => {
    const long = "a".repeat(200);
    expect(sanitizeError(long)).toHaveLength(120);
  });

  // --- Safe passthrough cases ---

  it("passes through a short safe message unchanged", () => {
    expect(sanitizeError("unreachable")).toBe("unreachable");
  });

  it("passes through a numeric status code unchanged", () => {
    expect(sanitizeError("503")).toBe("503");
  });

  it("passes through an empty string unchanged", () => {
    expect(sanitizeError("")).toBe("");
  });
});

// ---------------------------------------------------------------------------
// probeErrorText — what an operator reads on a failed check
// ---------------------------------------------------------------------------

describe("probeErrorText", () => {
  it("names the budget a probe ran out, so slow reads apart from refused", () => {
    const err = new Error("timeout");
    err.name = "TimeoutError";
    expect(probeErrorText(err, 2000)).toBe("Timed out after 2s");
    expect(probeErrorText(err, 5000)).toBe("Timed out after 5s");
  });

  it("treats an aborted fetch as a timeout", () => {
    const err = new Error("This operation was aborted");
    err.name = "AbortError";
    expect(probeErrorText(err, 2000)).toBe("Timed out after 2s");
  });

  it("unwraps the cause fetch hides behind 'fetch failed'", () => {
    const err = new Error("fetch failed", {
      cause: new Error("connect ECONNREFUSED 127.0.0.1:7300"),
    });
    expect(probeErrorText(err, 2000)).toBe("fetch failed: connect ECONNREFUSED [host]");
  });

  it("keeps an HTTP status as the error", () => {
    expect(probeErrorText(new Error("HTTP 503"), 2000)).toBe("HTTP 503");
  });

  it("stringifies a non-Error throw", () => {
    expect(probeErrorText("boom", 2000)).toBe("boom");
  });
});

// ---------------------------------------------------------------------------
// Probe registry
// ---------------------------------------------------------------------------

describe("SERVICE_PROBES", () => {
  it("bounds every probe, so no check can hang the strip", () => {
    for (const probe of SERVICE_PROBES) {
      expect(probe.timeoutMs).toBeGreaterThan(0);
    }
  });

  it("keeps the HTTP probes on their 2s budget", () => {
    for (const name of ["cAdvisor", "Loki", "Traefik"]) {
      expect(SERVICE_PROBES.find((p) => p.name === name)?.timeoutMs).toBe(2000);
    }
  });

  it("points cAdvisor and Loki at their own app logs", () => {
    expect(SERVICE_PROBES.find((p) => p.name === "cAdvisor")?.logsApp).toBe("cadvisor");
    expect(SERVICE_PROBES.find((p) => p.name === "Loki")?.logsApp).toBe("loki");
  });
});

// ---------------------------------------------------------------------------
// checkServiceByName — the re-probe behind "check again"
// ---------------------------------------------------------------------------

/** A stand-in Loki, so a probe can be broken and mended inside one test run. */
async function listen(handler: (res: ServerResponse) => void): Promise<Server> {
  const server = createServer((_req, res) => handler(res));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return server;
}

function urlOf(server: Server): string {
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}`;
}

async function close(server: Server): Promise<void> {
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

describe("checkServiceByName", () => {
  const original = process.env.LOKI_URL;

  afterEach(() => {
    if (original === undefined) delete process.env.LOKI_URL;
    else process.env.LOKI_URL = original;
  });

  it("returns null for a name no probe answers to", async () => {
    await expect(checkServiceByName("nginx")).resolves.toBeNull();
  });

  it("matches a probe regardless of how the caller cased it", async () => {
    const server = await listen((res) => res.end("ready"));
    process.env.LOKI_URL = urlOf(server);
    await expect(checkServiceByName("loki")).resolves.toMatchObject({ name: "Loki" });
    await close(server);
  });

  it("reports healthy with a latency and a check time", async () => {
    const server = await listen((res) => res.end("ready"));
    process.env.LOKI_URL = urlOf(server);

    const status = await checkServiceByName("Loki");
    expect(status?.status).toBe("healthy");
    expect(status?.error).toBeUndefined();
    expect(status?.latencyMs).toBeGreaterThanOrEqual(0);
    expect(Number.isNaN(Date.parse(status!.checkedAt))).toBe(false);
    expect(status?.timeoutMs).toBe(2000);

    await close(server);
  });

  it("reports the status a service answered with", async () => {
    const server = await listen((res) => {
      res.statusCode = 503;
      res.end();
    });
    process.env.LOKI_URL = urlOf(server);

    await expect(checkServiceByName("Loki")).resolves.toMatchObject({
      status: "unhealthy",
      error: "HTTP 503",
    });

    await close(server);
  });

  it("recovers on the next check once the service is back", async () => {
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
