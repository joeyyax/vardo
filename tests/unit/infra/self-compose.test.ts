// Vardo's own compose, as `docker compose config` resolves it with and without a Redis password (#889).

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync } from "child_process";
import { copyFile, mkdtemp, rm, writeFile } from "fs/promises";
import { readFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

type Service = { environment?: Record<string, string>; command?: string[]; healthcheck?: { test?: string[] } };
type Config = { services: Record<string, Service> };

let hasCompose = true;
try {
  execFileSync("docker", ["compose", "version"], { stdio: "ignore" });
} catch {
  hasCompose = false;
}

let dir = "";

function resolve(env: Record<string, string>): Config {
  const out = execFileSync(
    "docker",
    ["compose", "-f", join(dir, "docker-compose.yml"), "--profile", "production", "config", "--format", "json"],
    { cwd: dir, encoding: "utf-8", env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", ...env } as unknown as NodeJS.ProcessEnv },
  );
  return JSON.parse(out) as Config;
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
    const cfg = resolve({ REDIS_PASSWORD: "abc123" });
    expect(cfg.services.redis.environment?.REDIS_ARGS).toBe("--requirepass abc123");
    expect(cfg.services.frontend.environment?.REDIS_URL).toBe("redis://:abc123@vardo-redis:6379");
  });

  it("keeps an install without one running passwordless", () => {
    const cfg = resolve({});
    expect(cfg.services.redis.environment?.REDIS_ARGS).toBe("");
    expect(cfg.services.frontend.environment?.REDIS_URL).toBe("redis://:@vardo-redis:6379");
  });

  it("never serves Traefik's API insecurely", () => {
    const command = resolve({}).services.traefik.command ?? [];
    expect(command).not.toContain("--api.insecure=true");
    expect(command).toContain("--entrypoints.traefik.address=:8080");
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
