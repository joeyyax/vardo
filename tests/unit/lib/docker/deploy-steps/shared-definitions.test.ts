// A shared container whose definition differs only in labels, weights or how limits are written is left running.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

import { definitionFingerprint } from "@/lib/docker/deploy-steps/shared-definitions";
import { describeSharedOutcome, reconcileSharedServices, type DockerExec } from "@/lib/docker/deploy-steps/shared-drift";
import type { ComposeService } from "@/lib/docker/compose-types";

const LEGACY = "a".repeat(64);
const ENGINE = "b".repeat(64);
const NEWER = "c".repeat(64);

// As `config --format json` prints them.
const legacyPostgres = {
  image: "postgres:17",
  mem_limit: "1073741824",
  networks: { internal: null, mesh: { ipv4_address: "192.0.2.2" } },
  restart: "unless-stopped",
  "x-vardo-shared": true,
};
const enginePostgres = {
  image: "postgres:17",
  deploy: { resources: { limits: { memory: "1073741824" } }, placement: {} },
  labels: { "vardo.project": "vardo", "vardo.managed": "true" },
  networks: { internal: null, mesh: null },
  restart: "unless-stopped",
  "x-vardo-shared": true,
};

describe("definitionFingerprint", () => {
  it("ignores labels, weights, limit spelling and network detail", () => {
    expect(definitionFingerprint(enginePostgres)).toBe(definitionFingerprint(legacyPostgres));
    expect(definitionFingerprint({ ...enginePostgres, cpu_shares: 1024, oom_score_adj: 0 })).toBe(
      definitionFingerprint(legacyPostgres),
    );
  });

  it("counts a different limit, image or mount", () => {
    const base = definitionFingerprint(legacyPostgres);
    expect(definitionFingerprint({ ...legacyPostgres, mem_limit: "2147483648" })).not.toBe(base);
    expect(definitionFingerprint({ ...legacyPostgres, image: "postgres:18" })).not.toBe(base);
    expect(definitionFingerprint({ ...legacyPostgres, volumes: [{ type: "bind", source: "/srv/x", target: "/x" }] })).not.toBe(base);
  });
});

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "shared-definitions-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const shared: Record<string, ComposeService> = { postgres: { name: "postgres", image: "postgres:17", container_name: "vardo-postgres" } };

/** Engine files hash to `desired`; the legacy file to LEGACY. */
function docker(opts: { desired: string; running: string; engine: object }) {
  return vi.fn(async (args: string[]) => {
    const legacy = args.some((a) => a.endsWith("env/current/docker-compose.yml"));
    if (args.includes("--hash")) return { stdout: `postgres ${legacy ? LEGACY : opts.desired}\n`, stderr: "" };
    if (args.includes("config")) {
      return { stdout: JSON.stringify({ services: { postgres: legacy ? legacyPostgres : opts.engine } }), stderr: "" };
    }
    if (args[0] === "inspect" && args[2].includes("config-hash")) return { stdout: `${opts.running}|\n`, stderr: "" };
    if (args[0] === "inspect") return { stdout: "running healthy\n", stderr: "" };
    if (args.includes("up")) return { stdout: "", stderr: "" };
    throw new Error(`unexpected: docker ${args.join(" ")}`);
  }) as DockerExec & ReturnType<typeof vi.fn>;
}

const reconcile = (exec: DockerExec, extra: object = {}) =>
  reconcileSharedServices({
    shared,
    project: "vardo",
    composeFileArgs: ["-f", "docker-compose.yml", "-f", "docker-compose.override.yml"],
    cwd: "/srv/vardo/apps/vardo/production/blue",
    exec,
    timeout: 1000,
    log: () => {},
    upTimeout: 1000,
    readyTimeout: () => 1000,
    intervalMs: 1,
    stableMs: 0,
    sleep: async () => {},
    definitionsFile: join(dir, "shared-definitions.json"),
    ...extra,
  });

describe("reconcileSharedServices with recorded definitions", () => {
  it("leaves a container from the legacy compose file running when only labels and limit spelling differ", async () => {
    const exec = docker({ desired: ENGINE, running: LEGACY, engine: enginePostgres });
    const outcomes = await reconcile(exec, { legacyComposeFile: "/srv/vardo/apps/vardo/env/current/docker-compose.yml" });

    expect(outcomes).toEqual([{ service: "postgres", result: "unchanged", labelsOnly: true }]);
    expect(describeSharedOutcome(outcomes[0])).toContain("unchanged (only labels");
    expect(JSON.parse(readFileSync(join(dir, "shared-definitions.json"), "utf8")).services.postgres.hash).toBe(LEGACY);
  });

  it("stays unchanged on the next deploy from the record alone", async () => {
    await reconcile(docker({ desired: ENGINE, running: LEGACY, engine: enginePostgres }), {
      legacyComposeFile: "/srv/vardo/apps/vardo/env/current/docker-compose.yml",
    });
    const outcomes = await reconcile(docker({ desired: NEWER, running: LEGACY, engine: enginePostgres }));
    expect(outcomes[0]).toMatchObject({ result: "unchanged", labelsOnly: true });
  });

  it("holds a data store whose limit really changed", async () => {
    const engine = { ...enginePostgres, deploy: { resources: { limits: { memory: "2147483648" } } } };
    const outcomes = await reconcile(docker({ desired: ENGINE, running: LEGACY, engine }), {
      legacyComposeFile: "/srv/vardo/apps/vardo/env/current/docker-compose.yml",
    });
    expect(outcomes[0].result).toBe("held");
  });

  it("compares hashes only when no record describes the running container", async () => {
    const outcomes = await reconcile(docker({ desired: ENGINE, running: LEGACY, engine: enginePostgres }));
    expect(outcomes[0].result).toBe("held");
  });

  it("ignores a record for another container", async () => {
    writeFileSync(
      join(dir, "shared-definitions.json"),
      JSON.stringify({ services: { postgres: { hash: NEWER, fingerprint: definitionFingerprint(enginePostgres) } } }),
    );
    const outcomes = await reconcile(docker({ desired: ENGINE, running: LEGACY, engine: enginePostgres }));
    expect(outcomes[0].result).toBe("held");
  });
});
