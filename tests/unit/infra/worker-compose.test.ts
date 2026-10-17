import { execFileSync } from "child_process";
import { copyFile, mkdtemp, rm, writeFile } from "fs/promises";
import { readFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parse } from "yaml";

// The worker runs the same code against the same host as the frontend: env, mounts and groups must match. Networks differ by design (#1136).

type Service = {
  image?: string;
  build?: unknown;
  pull_policy?: string;
  command?: string[];
  profiles?: string[];
  mem_limit?: string;
  stop_grace_period?: string;
  env_file?: string;
  environment?: Record<string, string | number>;
  volumes?: string[];
  cap_add?: string[];
  group_add?: (string | number)[];
  depends_on?: Record<string, unknown>;
  networks?: Record<string, { ipv4_address?: string } | null>;
  labels?: string[];
  healthcheck?: { test?: string[] };
  "x-vardo-shared"?: boolean;
};

const compose = parse(readFileSync(join(process.cwd(), "docker-compose.yml"), "utf8")) as { services: Record<string, Service> };
const frontend = compose.services.frontend;
const worker = compose.services.worker;

/** Env only the worker sets. */
const WORKER_ONLY_ENV = ["VARDO_WORKER_HEALTH_PORT"];

describe("worker compose parity", () => {
  it("passes the frontend's env through unchanged", () => {
    const own = Object.fromEntries(Object.entries(worker.environment ?? {}).filter(([k]) => !WORKER_ONLY_ENV.includes(k)));
    expect(own).toEqual(frontend.environment);
    expect(worker.env_file).toBe(frontend.env_file);
  });

  it("mounts what the frontend mounts", () => {
    expect(worker.volumes).toEqual(frontend.volumes);
  });

  it("joins the Docker group with the same capabilities and dependencies", () => {
    expect(worker.group_add).toEqual(frontend.group_add);
    expect(worker.cap_add).toEqual(frontend.cap_add);
    expect(worker.depends_on).toEqual(frontend.depends_on);
  });

  it("joins internal and mesh like the frontend, vardo-network for deploy probes and never the console's network", () => {
    expect(Object.keys(worker.networks ?? {}).sort()).toEqual(["internal", "mesh", "vardo-network"]);
    expect(Object.keys(frontend.networks ?? {}).sort()).toEqual(["console", "internal", "mesh"]);
    expect(worker.networks?.mesh?.ipv4_address).toBeUndefined();
  });

  it("runs the frontend's image as the worker command, never pulled", () => {
    expect(worker.image).toBe("${COMPOSE_PROJECT_NAME}-frontend");
    expect(worker.build).toBeUndefined();
    expect(worker.pull_policy).toBe("never");
    expect(worker.command).toEqual(["worker"]);
  });

  it("rotates with the slot: in the production profile, not shared, not routed", () => {
    expect(worker.profiles).toEqual(["production"]);
    expect(worker["x-vardo-shared"]).toBeUndefined();
    expect(worker.labels).toBeUndefined();
  });

  it("sizes, drains and checks health from settings", () => {
    expect(worker.mem_limit).toBe("${VARDO_WORKER_MEM:-1g}");
    expect(worker.stop_grace_period).toBe("${VARDO_WORKER_STOP_GRACE:-10m}");
    expect(worker.healthcheck?.test).toEqual(["CMD", "curl", "-sf", "http://localhost:3001/healthz"]);
  });
});

let hasCompose = true;
try {
  execFileSync("docker", ["compose", "version"], { stdio: "ignore" });
} catch {
  hasCompose = false;
}

describe.skipIf(!hasCompose)("worker image per slot", () => {
  let dir = "";
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "vardo-worker-compose-"));
    await copyFile(join(process.cwd(), "docker-compose.yml"), join(dir, "docker-compose.yml"));
    await writeFile(join(dir, ".env"), "COMPOSE_PROJECT_NAME=stale\n");
  });
  afterAll(() => rm(dir, { recursive: true, force: true }));

  it("names the image the slot's frontend build produces, whatever the .env says", () => {
    const out = execFileSync(
      "docker",
      ["compose", "-f", join(dir, "docker-compose.yml"), "-p", "vardo-production-blue", "--profile", "production", "config", "--format", "json"],
      { cwd: dir, encoding: "utf-8", env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", DB_PASSWORD: "x" } as unknown as NodeJS.ProcessEnv },
    );
    const cfg = JSON.parse(out) as { services: Record<string, { image?: string }> };
    expect(cfg.services.worker.image).toBe("vardo-production-blue-frontend");
  });
});
