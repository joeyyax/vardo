// A repo symlink reaches an untrusted slot as a link, so the compose check sees where it points (#886).

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, rm, symlink, writeFile, lstat, readFile, realpath } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import type { DeployContext, DeployApp } from "@/lib/docker/deploy-context";

vi.mock("child_process", () => ({
  execFile: (_cmd: string, _args: string[], _opts: unknown, cb: (e: Error | null, r?: unknown) => void) =>
    cb(null, { stdout: "", stderr: "" }),
}));
vi.mock("@/lib/db", () => ({
  db: { query: { apps: { findMany: vi.fn().mockResolvedValue([]) }, orgEnvVars: { findMany: vi.fn().mockResolvedValue([]) } } },
}));
vi.mock("@/lib/docker/slots", () => ({ detectActiveSlot: vi.fn().mockResolvedValue(null) }));
vi.mock("@/lib/docker/self-env", () => ({ isSelfApp: () => false, seedSelfEnv: vi.fn().mockResolvedValue(null) }));
vi.mock("@/lib/docker/compose-policy", () => ({ assertComposeWithinApp: vi.fn(async () => ({ legacyPaths: [] })) }));
vi.mock("@/lib/docker/bind-roots", () => ({ setBindWarnings: vi.fn().mockResolvedValue(undefined) }));

import { build } from "@/lib/docker/deploy-steps/build";

let dir: string;

beforeEach(async () => {
  dir = await realpath(await mkdtemp(join(tmpdir(), "vardo-build-links-")));
  await mkdir(join(dir, "repo"));
  await writeFile(join(dir, "console.env"), "SECRET=x\n");
  await writeFile(join(dir, "repo", "plain.txt"), "plain\n");
  await symlink(join(dir, "console.env"), join(dir, "repo", "leak.env"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function ctx(orgTrusted: boolean): DeployContext {
  const app = { id: "a", name: "blog", memoryLimit: 512, priority: "standard", rootDirectory: null, domains: [] } as unknown as DeployApp;
  return {
    app,
    organizationId: "org",
    orgTrusted,
    envName: "production",
    envType: "production",
    envMap: {},
    compose: { services: { web: { name: "web", image: "nginx" } } },
    bareCompose: { services: { web: { name: "web", image: "nginx" } } },
    serviceConfig: {},
    appDir: join(dir, "production"),
    repoDir: join(dir, "repo"),
    log: vi.fn(),
    stage: vi.fn(),
    checkAbort: vi.fn(),
    logs: { push: vi.fn() },
  } as unknown as DeployContext;
}

describe("build — repo symlinks", () => {
  it("links them for an untrusted org", async () => {
    await build(ctx(false));
    const slot = join(dir, "production", "blue");
    expect((await lstat(join(slot, "leak.env"))).isSymbolicLink()).toBe(true);
    expect((await lstat(join(slot, "plain.txt"))).isFile()).toBe(true);
  });

  it("copies them for a trusted org, as before", async () => {
    await build(ctx(true));
    const leak = join(dir, "production", "blue", "leak.env");
    expect((await lstat(leak)).isFile()).toBe(true);
    expect(await readFile(leak, "utf-8")).toBe("SECRET=x\n");
  });
});
