// The build step's slot files on a real directory: Vardo's overlay, the commit variables and a repo file named like the old overlay.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import type { DeployContext, DeployApp } from "@/lib/docker/deploy-context";

vi.mock("child_process", () => ({
  execFile: (_cmd: string, _args: string[], _opts: unknown, cb: (e: Error | null, r?: unknown) => void) =>
    cb(null, { stdout: "", stderr: "" }),
}));
vi.mock("@/lib/db", () => ({
  db: { query: { apps: { findMany: vi.fn(async () => []) }, orgEnvVars: { findMany: vi.fn(async () => []) } } },
}));
vi.mock("@/lib/env/resolve", () => ({ resolveAllEnvVars: vi.fn(async (env: Record<string, string>) => env) }));
vi.mock("@/lib/docker/slots", () => ({ detectActiveSlot: vi.fn(async () => null) }));
vi.mock("@/lib/docker/compose-policy", () => ({ assertComposeWithinApp: vi.fn() }));
vi.mock("@/lib/docker/self-env", () => ({ isSelfApp: () => false, seedSelfEnv: vi.fn(async () => null) }));

import { build } from "@/lib/docker/deploy-steps/build";
import { slotComposeFiles } from "@/lib/docker/slot-files";

const SHA = "fedcba9876543210fedcba9876543210fedcba98";

// A repo's own file that uses the name Vardo's overlay had before April 2026.
const REPO_VARDO_FILE = "services:\n  web:\n    image: blog:repo\n    ports:\n      - \"9999:80\"\n";

let root: string;
let repoDir: string;
let appDir: string;

function makeCtx(overrides: Partial<DeployContext> = {}): DeployContext {
  const app = {
    id: "app-id", organizationId: "org-id", name: "blog", displayName: "Blog", source: "git",
    deployType: "compose", containerPort: 3000, memoryLimit: 512, priority: "standard",
    exposedPorts: null, rootDirectory: null, domains: [],
  } as unknown as DeployApp;
  const compose = () => ({ services: { web: { name: "web", image: "blog:${VARDO_GIT_SHORT_SHA}" } } });
  return {
    appId: "app-id", organizationId: "org-id", app, org: null,
    envName: "production", envType: "production", envMap: { PORT: "3000" },
    compose: compose(), bareCompose: compose(), serviceConfig: {},
    appDir, repoDir,
    log: vi.fn(), stage: vi.fn(), checkAbort: vi.fn(), logs: { push: vi.fn() },
    ...overrides,
  } as unknown as DeployContext;
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "vardo-build-"));
  repoDir = join(root, "repo");
  appDir = join(root, "apps", "blog", "production");
  await mkdir(repoDir, { recursive: true });
  await writeFile(join(repoDir, "docker-compose.yml"), "services:\n  web:\n    image: blog\n");
  await writeFile(join(repoDir, "docker-compose.vardo.yml"), REPO_VARDO_FILE);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("build — slot files", () => {
  it("deploys a repo with its own docker-compose.vardo.yml on Vardo's overlay", async () => {
    const ctx = await build(makeCtx({ gitSha: SHA }));
    const slot = join(appDir, "blue");

    expect(await readFile(join(slot, "docker-compose.vardo.yml"), "utf-8")).toBe(REPO_VARDO_FILE);
    const expected = [
      "-f", join(slot, "docker-compose.yml"),
      "-f", join(slot, "docker-compose.override.yml"),
      "--env-file", join(slot, ".env"),
      "--env-file", join(slot, ".vardo.env"),
    ];
    expect(ctx.composeFileArgs).toEqual(expected);
    expect(await slotComposeFiles(slot)).toEqual(expected);
    expect(await readFile(join(slot, "docker-compose.override.yml"), "utf-8")).toContain("memory: 512M");
  });

  it("writes the deploy's commit for compose interpolation", async () => {
    await build(makeCtx({ gitSha: SHA }));

    expect(await readFile(join(appDir, "blue", ".vardo.env"), "utf-8")).toBe(
      `VARDO_GIT_SHA=${SHA}\nVARDO_GIT_SHORT_SHA=fedcba9\n`,
    );
  });

  it("writes local for a deploy without a commit", async () => {
    await build(makeCtx({ repoDir: null }));

    expect(await readFile(join(appDir, "blue", ".vardo.env"), "utf-8")).toBe(
      "VARDO_GIT_SHA=local\nVARDO_GIT_SHORT_SHA=local\n",
    );
  });

  it("keeps the commit variables out of the container env file", async () => {
    await build(makeCtx({ gitSha: SHA }));

    expect(await readFile(join(appDir, "blue", ".env"), "utf-8")).not.toContain("VARDO_GIT");
  });
});
