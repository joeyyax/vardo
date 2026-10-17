// Vardo's own compose, as `docker compose config` resolves it with and without a Redis password (#889).

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync } from "child_process";
import { copyFile, mkdtemp, rm, writeFile } from "fs/promises";
import { readFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { BUNDLED_RANGES } from "@/lib/docker/cloudflare-only";
import { parse as parseToml } from "@iarna/toml";
import { runningTrustedIps } from "@/lib/docker/trusted-proxies";

type Service = { image?: string; networks?: Record<string, unknown>; configs?: { source: string; target: string }[]; environment?: Record<string, string>; command?: string[]; healthcheck?: { test?: string[] } };
type Config = { services: Record<string, Service>; configs?: Record<string, { content?: string }> };

let hasCompose = true;
try {
  execFileSync("docker", ["compose", "version"], { stdio: "ignore" });
} catch {
  hasCompose = false;
}

let dir = "";

function resolveRaw(env: Record<string, string>): string {
  return execFileSync(
    "docker",
    ["compose", "-f", join(dir, "docker-compose.yml"), "--profile", "production", "--profile", "buildkit", "config", "--format", "json"],
    { cwd: dir, encoding: "utf-8", stdio: "pipe", env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", ...env } as unknown as NodeJS.ProcessEnv },
  );
}

function resolve(env: Record<string, string>): Config {
  return JSON.parse(resolveRaw({ DB_PASSWORD: "db-pass", ...env })) as Config;
}

describe.skipIf(!hasCompose)("self compose (#889)", () => {
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "vardo-self-compose-"));
    await copyFile(join(process.cwd(), "docker-compose.yml"), join(dir, "docker-compose.yml"));
    await writeFile(join(dir, ".env"), "");
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("runs Redis with a password when the .env sets one, and the console sends it", () => {
    const pw = "fixture-pw";
    const cfg = resolve({ REDIS_PASSWORD: pw });
    expect(cfg.services.redis.environment?.REDIS_ARGS).toBe(`--appendonly yes --appendfsync everysec --save 3600 1 --maxmemory 320mb --maxmemory-policy volatile-lru --requirepass ${pw}`);
    expect(cfg.services.frontend.environment?.REDIS_URL).toBe(`redis://:${pw}@vardo-redis:6379`);
  });

  it("keeps an install without one running passwordless", () => {
    const cfg = resolve({});
    expect(cfg.services.redis.environment?.REDIS_ARGS).toBe("--appendonly yes --appendfsync everysec --save 3600 1 --maxmemory 320mb --maxmemory-policy volatile-lru");
    expect(cfg.services.frontend.environment?.REDIS_URL).toBe("redis://:@vardo-redis:6379");
  });

  it("refuses to resolve without a database password", () => {
    expect(() => resolveRaw({})).toThrow(/DB_PASSWORD/);
  });

  it("passes the database password to Postgres and the console", () => {
    const cfg = resolve({});
    expect(cfg.services.postgres.environment?.POSTGRES_PASSWORD).toBe("db-pass");
    expect(cfg.services.frontend.environment?.DATABASE_URL).toBe("postgresql://host:db-pass@vardo-postgres:5432/host");
  });

  it("builds the console with the engine's commit, then install.sh's", () => {
    const arg = (env: Record<string, string>) =>
      (resolve(env).services.frontend as Service & { build?: { args?: Record<string, string> } }).build?.args?.GIT_SHA;
    expect(arg({ VARDO_GIT_SHORT_SHA: "71b4f31", GIT_SHA: "e36c2e3" })).toBe("71b4f31");
    expect(arg({ GIT_SHA: "e36c2e3" })).toBe("e36c2e3");
    expect(arg({})).toBe("");
  });

  it("never serves Traefik's API insecurely", () => {
    const command = resolve({}).services.traefik.command ?? [];
    expect(command).not.toContain("--api.insecure=true");
    expect(command).toContain("--entrypoints.traefik.address=:8080");
  });

  it("trusts Cloudflare's bundled ranges on both entrypoints until the console writes its own (#902)", () => {
    const bundled = [...BUNDLED_RANGES.v4, ...BUNDLED_RANGES.v6].join(",");
    const trusted = (env: Record<string, string>) =>
      runningTrustedIps(resolve(env).services.traefik.command ?? []);
    expect(trusted({})).toEqual({ web: bundled, websecure: bundled });
    expect(trusted({ VARDO_TRAEFIK_TRUSTED_IPS: "198.51.100.0/24" })).toEqual({ web: "198.51.100.0/24", websecure: "198.51.100.0/24" });
    expect(trusted({ VARDO_TRAEFIK_TRUSTED_IPS: "" })).toEqual({ web: "", websecure: "" });
  });

  it("gives HTTPS requests Traefik's 60s to arrive, or VARDO_TRAEFIK_READ_TIMEOUT", () => {
    const flag = "--entrypoints.websecure.transport.respondingtimeouts.readtimeout=";
    expect(resolve({}).services.traefik.command).toContain(`${flag}60s`);
    expect(resolve({ VARDO_TRAEFIK_READ_TIMEOUT: "30m" }).services.traefik.command).toContain(`${flag}30m`);
  });

  describe("Traefik metrics", () => {
    const traefik = (env: Record<string, string>) => resolve(env).services.traefik as Service & { ports?: { target: number }[] };

    it("is off by default", () => {
      expect(traefik({}).command).toContain("--metrics.prometheus=false");
    });

    it("turns on with VARDO_TRAEFIK_METRICS=true, on an entrypoint of its own", () => {
      const command = traefik({ VARDO_TRAEFIK_METRICS: "true" }).command ?? [];
      expect(command).toContain("--metrics.prometheus=true");
      expect(command).toContain("--metrics.prometheus.entrypoint=metrics");
      expect(command).toContain("--entrypoints.metrics.address=:8082");
    });

    it("never publishes the metrics port", () => {
      for (const env of [{}, { VARDO_TRAEFIK_METRICS: "true" }] as Record<string, string>[]) {
        expect((traefik(env).ports ?? []).map((p) => p.target)).toEqual([80, 443]);
      }
    });
  });

  describe("BuildKit cache ceiling (#801)", () => {
    type Policy = {
      all?: boolean;
      filters?: string[];
      keepDuration?: string;
      reservedSpace?: string;
      maxUsedSpace: string;
      minFreeSpace: string;
    };
    const buildkitd = (env: Record<string, string>) => {
      const cfg = resolve(env);
      expect(cfg.services.buildkit.configs).toEqual([
        expect.objectContaining({ source: "buildkitd", target: "/etc/buildkit/buildkitd.toml" }),
      ]);
      const toml = parseToml(cfg.configs!.buildkitd.content!) as { worker: { oci: { gc: boolean; gcpolicy: Policy[] } } };
      return toml.worker.oci;
    };
    /** What buildkitd reads: a bare number is bytes, a unit suffix is binary (units.RAMInBytes). */
    const bytesOf = (v: string) => {
      const m = /^(\d+)\s*([kmg]?)b?$/i.exec(v)!;
      return Number(m[1]) * 1024 ** "bkmg".indexOf((m[2] || "b").toLowerCase());
    };

    it("pins the image to a release tag", () => {
      expect(resolve({}).services.buildkit.image).toMatch(/^moby\/buildkit:v\d+\.\d+\.\d+$/);
    });

    it("turns gc on, evicting layers unused for 7 days before the catch-all holding 10 GiB by default", () => {
      const oci = buildkitd({});
      expect(oci.gc).toBe(true);
      expect(oci.gcpolicy).toHaveLength(2);
      const [old, all] = oci.gcpolicy;
      expect(old.filters).toEqual(["type!=exec.cachemount"]);
      expect(old.keepDuration).toBe("168h");
      expect(old.reservedSpace).toBeUndefined();
      expect(bytesOf(old.maxUsedSpace)).toBe(10 * 1024 ** 3);
      expect(bytesOf(old.minFreeSpace)).toBe(5e9);
      expect(all.all).toBe(true);
      expect(all.filters).toBeUndefined();
      expect(all.keepDuration).toBeUndefined();
      expect(bytesOf(all.maxUsedSpace)).toBe(10 * 1024 ** 3);
      expect(bytesOf(all.reservedSpace!)).toBe(1e9);
      expect(bytesOf(all.minFreeSpace)).toBe(5e9);
    });

    it("reads VARDO_BUILDKIT_CACHE_MAX as bytes in both policies", () => {
      for (const p of buildkitd({ VARDO_BUILDKIT_CACHE_MAX: String(23 * 1024 ** 3) }).gcpolicy) {
        expect(bytesOf(p.maxUsedSpace)).toBe(23 * 1024 ** 3);
      }
    });

    it("caps buildkitd's Go heap (#1016)", () => {
      expect(resolve({}).services.buildkit.environment?.GOMEMLIMIT).toBe("600MiB");
    });

    it("keeps build steps off the network Postgres and Redis share", () => {
      const cfg = resolve({});
      const buildkitNets = Object.keys(cfg.services.buildkit.networks ?? {});
      for (const svc of ["postgres", "redis"]) {
        const shared = Object.keys(cfg.services[svc].networks ?? {}).filter((n) => buildkitNets.includes(n));
        expect(shared, svc).toEqual([]);
      }
    });

    it("passes a unit through for buildkitd to read, not as megabytes", () => {
      const [p] = buildkitd({ VARDO_BUILDKIT_CACHE_MAX: "20GB" }).gcpolicy;
      expect(p.maxUsedSpace).toBe("20GB");
      expect(bytesOf(p.maxUsedSpace)).toBe(20 * 1024 ** 3);
    });
  });
});

describe("installer (#889)", () => {
  it("writes a Redis password for staging and production, not dev", () => {
    const script = readFileSync(join(process.cwd(), "install.sh"), "utf-8");
    expect(script.match(/^REDIS_PASSWORD=\$redis_pass$/gm)).toHaveLength(2);
    const dev = script.slice(script.indexOf("VARDO_ROLE=development\n"), script.indexOf("VARDO_ROLE=staging\n"));
    expect(dev).not.toContain("REDIS_PASSWORD");
  });
});
