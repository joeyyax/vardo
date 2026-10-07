// Org env vars are encrypted at rest. A deploy decrypts them, and still reads
// rows stored before that as plaintext.

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { DeployContext, DeployApp } from "@/lib/docker/deploy-context";
import type { ResolveContext } from "@/lib/env/resolve";

process.env.ENCRYPTION_MASTER_KEY = "1".repeat(64);

const { orgRows, resolveAllEnvVars } = vi.hoisted(() => ({
  orgRows: [] as { key: string; value: string; isSecret: boolean }[],
  resolveAllEnvVars: vi.fn<(env: Record<string, string>, ctx: ResolveContext) => Promise<Record<string, string>>>(
    async (env) => env,
  ),
}));

vi.mock("fs/promises", () => ({
  mkdir: vi.fn().mockResolvedValue(undefined),
  writeFile: vi.fn().mockResolvedValue(undefined),
  readFile: vi.fn().mockResolvedValue(""),
  rm: vi.fn().mockResolvedValue(undefined),
  symlink: vi.fn().mockResolvedValue(undefined),
  copyFile: vi.fn().mockResolvedValue(undefined),
  stat: vi.fn().mockResolvedValue({ isDirectory: () => false }),
  readdir: vi.fn().mockResolvedValue([]),
}));

vi.mock("child_process", () => ({
  execFile: (_cmd: string, _args: string[], _opts: unknown, cb: (e: Error | null, r?: unknown) => void) =>
    cb(null, { stdout: "", stderr: "" }),
}));

vi.mock("@/lib/db", () => ({
  db: {
    query: {
      apps: { findMany: vi.fn().mockResolvedValue([]), findFirst: vi.fn() },
      orgEnvVars: { findMany: vi.fn(async () => orgRows) },
    },
  },
}));
vi.mock("@/lib/env/resolve", () => ({ resolveAllEnvVars }));
vi.mock("@/lib/docker/slots", () => ({ detectActiveSlot: vi.fn().mockResolvedValue(null) }));
vi.mock("@/lib/docker/self-env", () => ({
  isSelfApp: () => false,
  seedSelfEnv: vi.fn().mockResolvedValue(null),
}));

import { build } from "@/lib/docker/deploy-steps/build";
import { encrypt } from "@/lib/crypto/encrypt";

function makeCtx(overrides: Partial<DeployContext> = {}): DeployContext {
  const app = {
    id: "app-id",
    organizationId: "org-id",
    name: "blog",
    displayName: "Blog",
    source: "image",
    deployType: "compose",
    containerPort: 3000,
    memoryLimit: 512,
    priority: "standard",
    exposedPorts: null,
    rootDirectory: null,
    domains: [],
  } as unknown as DeployApp;

  return {
    appId: "app-id",
    organizationId: "org-id",
    app,
    org: null,
    envName: "production",
    envType: "production",
    envMap: { PORT: "3000" },
    compose: { services: { web: { name: "web", image: "nginx" } } },
    bareCompose: { services: { web: { name: "web", image: "nginx" } } },
    serviceConfig: {},
    appDir: "/srv/apps/blog/production",
    repoDir: null,
    log: vi.fn((line: string) => line),
    stage: vi.fn(),
    checkAbort: vi.fn(),
    logs: { push: vi.fn() },
    ...overrides,
  } as unknown as DeployContext;
}

const orgEnvSeen = () => resolveAllEnvVars.mock.calls[0][1].orgEnvVars;

beforeEach(() => {
  vi.clearAllMocks();
  orgRows.length = 0;
});

describe("build — org env vars", () => {
  it("decrypts secret and non-secret values", async () => {
    orgRows.push(
      { key: "API_TOKEN", value: encrypt("hunter2", "org-id"), isSecret: true },
      { key: "LOG_LEVEL", value: encrypt("info", "org-id"), isSecret: false },
    );

    await build(makeCtx());

    expect(orgEnvSeen()).toEqual({ API_TOKEN: "hunter2", LOG_LEVEL: "info" });
  });

  it("reads a legacy plaintext row", async () => {
    orgRows.push({ key: "LOG_LEVEL", value: "warn", isSecret: false });

    await build(makeCtx());

    expect(orgEnvSeen()).toEqual({ LOG_LEVEL: "warn" });
  });

  it("aborts on a value the running key can't open", async () => {
    orgRows.push({ key: "LOG_LEVEL", value: encrypt("info", "another-org"), isSecret: false });

    await expect(build(makeCtx())).rejects.toThrow("LOG_LEVEL");
  });
});
