// The build step's volume externalization: unmounted volumes are dropped, shared-only ones take the shared project's names.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import type { DeployContext, DeployApp } from "@/lib/docker/deploy-context";

const created = vi.hoisted(() => [] as string[]);

vi.mock("child_process", () => ({
  execFile: (_cmd: string, args: string[], _opts: unknown, cb: (e: Error | null, r?: unknown) => void) => {
    if (args[0] === "volume" && args[1] === "create") created.push(args[2]);
    cb(null, { stdout: "", stderr: "" });
  },
}));
vi.mock("@/lib/db", () => ({
  db: { query: { apps: { findMany: vi.fn(async () => []) }, orgEnvVars: { findMany: vi.fn(async () => []) } } },
}));
vi.mock("@/lib/env/resolve", () => ({ resolveAllEnvVars: vi.fn(async (env: Record<string, string>) => env) }));
vi.mock("@/lib/docker/slots", () => ({ detectActiveSlot: vi.fn(async () => null) }));
vi.mock("@/lib/docker/compose-policy", () => ({ assertComposeWithinApp: vi.fn() }));
vi.mock("@/lib/docker/self-env", () => ({ isSelfApp: () => false, seedSelfEnv: vi.fn(async () => null) }));

import { build } from "@/lib/docker/deploy-steps/build";

let root: string;
let appDir: string;

function makeCtx(): DeployContext {
  const app = {
    id: "app-id", organizationId: "org-id", name: "blog", displayName: "Blog", source: "git",
    deployType: "compose", containerPort: 3000, memoryLimit: 512, priority: "standard",
    exposedPorts: null, rootDirectory: null, domains: [],
  } as unknown as DeployApp;
  const compose = () => ({
    services: {
      web: { name: "web", image: "blog", volumes: ["uploads:/data"] },
      db: { name: "db", image: "postgres", volumes: ["db_data:/var/lib/postgresql"], "x-vardo-shared": true },
    },
    volumes: { uploads: {}, db_data: {}, buildkit_data: {} },
  });
  return {
    appId: "app-id", organizationId: "org-id", app, org: null,
    envName: "production", envType: "production", envMap: { PORT: "3000" },
    compose: compose(), bareCompose: compose(), serviceConfig: {},
    appDir, repoDir: join(root, "repo"),
    log: vi.fn(), stage: vi.fn(), checkAbort: vi.fn(), logs: { push: vi.fn() },
    gitSha: "fedcba9876543210fedcba9876543210fedcba98",
  } as unknown as DeployContext;
}

beforeEach(async () => {
  created.length = 0;
  root = await mkdtemp(join(tmpdir(), "vardo-build-vol-"));
  appDir = join(root, "apps", "blog", "production");
  await mkdir(join(root, "repo"), { recursive: true });
  await writeFile(join(root, "repo", "docker-compose.yml"), "services:\n  web:\n    image: blog\n");
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("build — volumes", () => {
  it("drops volumes no service mounts and creates no copy of them", async () => {
    const ctx = await build(makeCtx());
    expect(Object.keys(ctx.compose.volumes ?? {}).sort()).toEqual(["db_data", "uploads"]);
    expect(created.some((n) => n.includes("buildkit_data"))).toBe(false);
    const slotFiles = (await readFile(join(appDir, "blue", "docker-compose.yml"), "utf-8")) +
      (await readFile(join(appDir, "blue", "docker-compose.override.yml"), "utf-8"));
    expect(slotFiles).not.toContain("buildkit_data");
  });

  it("points shared-only volumes at the shared project's names", async () => {
    const ctx = await build(makeCtx());
    expect(ctx.compose.volumes?.db_data).toEqual({ external: true, name: "blog-production-shared_db_data" });
    expect(ctx.compose.volumes?.uploads).toEqual({ external: true, name: expect.stringMatching(/_uploads$/) });
  });
});
