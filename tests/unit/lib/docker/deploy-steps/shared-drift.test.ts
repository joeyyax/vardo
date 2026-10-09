// ---------------------------------------------------------------------------
// Drift between a shared service's definition and its running container, and
// what a deploy does about it.
// ---------------------------------------------------------------------------

import { describe, it, expect, vi } from "vitest";

import {
  describeSharedOutcome,
  parseConfigHashes,
  reconcileSharedServices,
  sharedDrift,
  sharedPolicy,
  waitForContainer,
  SharedRecreateError,
  type DockerExec,
} from "@/lib/docker/deploy-steps/shared-drift";
import type { ComposeService } from "@/lib/docker/compose-types";

const A = "a".repeat(64);
const B = "b".repeat(64);

const shared = (services: Record<string, Partial<ComposeService>>) =>
  services as Record<string, ComposeService>;

const vardoShared = () =>
  shared({
    postgres: { image: "postgres:17", container_name: "vardo-postgres" },
    redis: { image: "redis/redis-stack-server:7.4.0-v3", container_name: "vardo-redis" },
    traefik: { image: "traefik:v3", container_name: "vardo-traefik" },
  });

type Docker = {
  desired?: Record<string, string>;
  running?: Record<string, string | null>;
  configFails?: boolean;
  upFails?: boolean;
  state?: string[];
};

/** A docker CLI double. `running[container] = null` means no such container. */
function docker(opts: Docker): DockerExec & ReturnType<typeof vi.fn> {
  const states = [...(opts.state ?? ["running healthy"])];
  return vi.fn(async (args: string[]) => {
    if (args.includes("config")) {
      if (opts.configFails) throw new Error("unknown flag: --hash");
      const out = Object.entries(opts.desired ?? {}).map(([s, h]) => `${s} ${h}`).join("\n");
      return { stdout: `${out}\n`, stderr: "" };
    }
    if (args[0] === "inspect" && args[2].includes("config-hash")) {
      const container = args[3];
      const hash = opts.running?.[container];
      if (hash === null) throw new Error(`No such object: ${container}`);
      return { stdout: `${hash ?? "<no value>"}\n`, stderr: "" };
    }
    if (args[0] === "inspect") {
      return { stdout: `${states.length > 1 ? states.shift() : states[0]}\n`, stderr: "" };
    }
    if (args.includes("up")) {
      if (opts.upFails) throw new Error("port is already allocated");
      return { stdout: "", stderr: "" };
    }
    throw new Error(`unexpected: docker ${args.join(" ")}`);
  }) as DockerExec & ReturnType<typeof vi.fn>;
}

const base = (exec: DockerExec) => ({
  shared: vardoShared(),
  project: "vardo-production-shared",
  composeFileArgs: ["-f", "docker-compose.yml"],
  cwd: "/opt/vardo/apps/vardo/production/green",
  exec,
  timeout: 1000,
});

const reconcile = (exec: DockerExec, log: (l: string) => void = () => {}) =>
  reconcileSharedServices({
    ...base(exec),
    log,
    upTimeout: 1000,
    readyTimeout: () => 1000,
    intervalMs: 1,
    stableMs: 0,
    sleep: async () => {},
  });

const upCalls = (exec: ReturnType<typeof vi.fn>) =>
  exec.mock.calls.map((c) => c[0] as string[]).filter((a) => a.includes("up"));

describe("parseConfigHashes", () => {
  it("reads one service and hash per line", () => {
    expect(parseConfigHashes(`postgres ${A}\ntraefik ${B}\n`)).toEqual(
      new Map([["postgres", A], ["traefik", B]]),
    );
  });

  it("ignores lines that are not a hash", () => {
    expect(parseConfigHashes("WARN[0000] something\n").size).toBe(0);
  });
});

describe("sharedPolicy", () => {
  it("holds postgres and redis", () => {
    expect(sharedPolicy({ image: "postgres:17" } as ComposeService).action).toBe("hold");
    expect(sharedPolicy({ image: "redis/redis-stack-server:7.4.0-v3" } as ComposeService).action).toBe("hold");
  });

  it("recreates traefik, buildkit and wireguard", () => {
    for (const image of ["traefik:v3", "moby/buildkit:latest", "linuxserver/wireguard:1.0"]) {
      expect(sharedPolicy({ image } as ComposeService).action).toBe("recreate");
    }
  });
});

describe("sharedDrift", () => {
  it("compares the running label against the definition hash", async () => {
    const exec = docker({
      desired: { postgres: A, redis: A, traefik: B },
      running: { "vardo-postgres": A, "vardo-redis": A, "vardo-traefik": A },
    });
    const { states } = await sharedDrift(base(exec));
    expect(Object.fromEntries(states)).toEqual({ postgres: "unchanged", redis: "unchanged", traefik: "drifted" });
  });

  it("hashes every profile so a profiled service is not refused", async () => {
    const exec = docker({ desired: {}, running: {} });
    await sharedDrift(base(exec));
    expect(exec.mock.calls[0][0]).toEqual(expect.arrayContaining(["--profile", "*", "config", "--hash", "postgres,redis,traefik"]));
  });

  it("calls a container without the label unknown, not unchanged", async () => {
    const exec = docker({ desired: { postgres: A, redis: A, traefik: A }, running: {} });
    const { states } = await sharedDrift(base(exec));
    expect(states.get("traefik")).toBe("unknown");
  });

  it("calls a missing container missing", async () => {
    const exec = docker({ desired: { postgres: A, redis: A, traefik: A }, running: { "vardo-traefik": null } });
    const { states } = await sharedDrift(base(exec));
    expect(states.get("traefik")).toBe("missing");
  });

  it("marks everything unknown when compose cannot hash", async () => {
    const { states, error } = await sharedDrift(base(docker({ configFails: true })));
    expect([...states.values()]).toEqual(["unknown", "unknown", "unknown"]);
    expect(error).toMatch(/--hash/);
  });
});

describe("reconcileSharedServices", () => {
  it("leaves unchanged services alone", async () => {
    const exec = docker({
      desired: { postgres: A, redis: A, traefik: A },
      running: { "vardo-postgres": A, "vardo-redis": A, "vardo-traefik": A },
    });
    const outcomes = await reconcile(exec);
    expect(outcomes.map((o) => o.result)).toEqual(["unchanged", "unchanged", "unchanged"]);
    expect(upCalls(exec)).toEqual([]);
  });

  it("recreates drifted traefik without reaching a registry", async () => {
    const exec = docker({
      desired: { postgres: A, redis: A, traefik: B },
      running: { "vardo-postgres": A, "vardo-redis": A, "vardo-traefik": A },
    });
    const outcomes = await reconcile(exec);
    expect(outcomes.find((o) => o.service === "traefik")?.result).toBe("recreated");
    expect(upCalls(exec)).toEqual([
      ["compose", "-f", "docker-compose.yml", "-p", "vardo-production-shared", "up", "-d", "--no-deps", "--pull", "never", "traefik"],
    ]);
  });

  it("holds drifted postgres and redis and never recreates them", async () => {
    const exec = docker({
      desired: { postgres: B, redis: B, traefik: A },
      running: { "vardo-postgres": A, "vardo-redis": A, "vardo-traefik": A },
    });
    const outcomes = await reconcile(exec);
    expect(outcomes.filter((o) => o.result === "held").map((o) => o.service)).toEqual(["postgres", "redis"]);
    expect(upCalls(exec)).toEqual([]);
  });

  it("recreates a held data store still carrying Traefik routing (formbricks 502 regression)", async () => {
    const exec = docker({
      desired: { postgres: B, redis: A, traefik: A },
      running: { "vardo-postgres": `${A}|true`, "vardo-redis": A, "vardo-traefik": A },
    });
    const log = vi.fn();
    const outcomes = await reconcile(exec, log);
    expect(outcomes.find((o) => o.service === "postgres")?.result).toBe("recreated");
    expect(upCalls(exec).map((a) => a.at(-1))).toEqual(["postgres"]);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("Traefik routing it no longer has"));
  });

  it("still holds a data store whose definition keeps its route", async () => {
    const exec = docker({
      desired: { postgres: B, redis: A, traefik: A },
      running: { "vardo-postgres": `${A}|true`, "vardo-redis": A, "vardo-traefik": A },
    });
    const services = vardoShared();
    services.postgres.labels = { "traefik.enable": "true" };
    const outcomes = await reconcileSharedServices({
      ...base(exec),
      shared: services,
      log: () => {},
      upTimeout: 1000,
      readyTimeout: () => 1000,
      intervalMs: 1,
      stableMs: 0,
      sleep: async () => {},
    });
    expect(outcomes.find((o) => o.service === "postgres")?.result).toBe("held");
    expect(upCalls(exec)).toEqual([]);
  });

  it("waits for a recreated service's healthcheck", async () => {
    const exec = docker({
      desired: { postgres: A, redis: A, traefik: B },
      running: { "vardo-postgres": A, "vardo-redis": A, "vardo-traefik": A },
      state: ["running starting", "running starting", "running healthy"],
    });
    await reconcile(exec);
    const stateReads = exec.mock.calls.filter((c) => (c[0] as string[])[2]?.includes(".State.Status"));
    expect(stateReads).toHaveLength(3);
  });

  it("holds a service whose bind data still sits in a slot dir", async () => {
    const exec = docker({
      desired: { postgres: A, redis: A, traefik: B },
      running: { "vardo-postgres": A, "vardo-redis": A, "vardo-traefik": A },
    });
    const outcomes = await reconcileSharedServices({
      ...base(exec),
      log: () => {},
      upTimeout: 1000,
      readyTimeout: () => 1000,
      intervalMs: 1,
      stableMs: 0,
      sleep: async () => {},
      pendingMoves: { traefik: ["/a/blue/conf → /a/shared/conf"] },
    });
    expect(outcomes.find((o) => o.service === "traefik")).toMatchObject({ result: "held", reason: expect.stringContaining("/a/blue/conf") });
    expect(upCalls(exec)).toEqual([]);
  });

  it("throws naming the service when the recreate fails", async () => {
    const exec = docker({
      desired: { postgres: A, redis: A, traefik: B },
      running: { "vardo-postgres": A, "vardo-redis": A, "vardo-traefik": A },
      upFails: true,
    });
    const err = await reconcile(exec).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SharedRecreateError);
    expect((err as SharedRecreateError).service).toBe("traefik");
  });

  it("throws when the recreated container exits", async () => {
    const exec = docker({
      desired: { postgres: A, redis: A, traefik: B },
      running: { "vardo-postgres": A, "vardo-redis": A, "vardo-traefik": A },
      state: ["exited"],
    });
    await expect(reconcile(exec)).rejects.toThrow(/traefik failed after recreate: container exited/);
  });

  it("logs why drift could not be checked", async () => {
    const log = vi.fn();
    const outcomes = await reconcile(docker({ configFails: true }), log);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("Could not read shared service definitions"));
    expect(outcomes.every((o) => o.result === "unknown")).toBe(true);
  });
});

describe("waitForContainer", () => {
  it("times out on a container that stays unhealthy", async () => {
    let t = 0;
    const exec = docker({ state: ["running unhealthy"] });
    const result = await waitForContainer(
      "vardo-traefik",
      exec,
      { timeoutMs: 10, intervalMs: 1, stableMs: 0, queryTimeout: 1000 },
      async () => { t += 5; },
      () => t,
    );
    expect(result).toMatch(/not ready after .* \(running, unhealthy\)/);
  });

  it("holds a container without a healthcheck to the stable window", async () => {
    let t = 0;
    const exec = docker({ state: ["running"] });
    const result = await waitForContainer(
      "vardo-wireguard",
      exec,
      { timeoutMs: 100, intervalMs: 1, stableMs: 20, queryTimeout: 1000 },
      async () => { t += 5; },
      () => t,
    );
    expect(result).toBeNull();
    expect(t).toBeGreaterThanOrEqual(20);
  });
});

describe("describeSharedOutcome", () => {
  it("names each state", () => {
    expect(describeSharedOutcome({ service: "redis", result: "unchanged" })).toBe("[deploy] Shared service redis: unchanged");
    expect(describeSharedOutcome({ service: "traefik", result: "recreated" })).toContain("recreated");
    expect(describeSharedOutcome({ service: "postgres", result: "held", reason: "x" })).toContain("held — x");
  });
});
