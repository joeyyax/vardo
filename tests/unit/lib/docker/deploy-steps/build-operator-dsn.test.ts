// ---------------------------------------------------------------------------
// Vardo no longer mints or injects a DSN. An operator who points SENTRY_DSN or
// GLITCHTIP_DSN at their own Sentry or GlitchTip keeps working — the value
// reaches the container untouched and the build adds none of its own.
// ---------------------------------------------------------------------------

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { DeployContext, DeployApp } from "@/lib/docker/deploy-context";

const { writes, childApps } = vi.hoisted(() => ({
  writes: [] as { path: string; content: string }[],
  childApps: vi.fn().mockResolvedValue([] as unknown[]),
}));

vi.mock("fs/promises", () => ({
  mkdir: vi.fn().mockResolvedValue(undefined),
  writeFile: vi.fn(async (path: string, content: string) => {
    writes.push({ path, content });
  }),
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
  db: { query: { apps: { findMany: childApps, findFirst: vi.fn() }, orgEnvVars: { findMany: vi.fn().mockResolvedValue([]) } } },
}));
vi.mock("@/lib/crypto/encrypt", () => ({
  decryptOrFallback: vi.fn((content: string) => ({ content, wasEncrypted: true })),
}));
vi.mock("@/lib/env/resolve", () => ({
  resolveAllEnvVars: vi.fn(async (env: Record<string, string>) => env),
}));
vi.mock("@/lib/docker/slots", () => ({ detectActiveSlot: vi.fn().mockResolvedValue(null) }));
vi.mock("@/lib/docker/self-env", () => ({
  isSelfApp: () => false,
  seedSelfEnv: vi.fn().mockResolvedValue(null),
}));

import { build } from "@/lib/docker/deploy-steps/build";

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

function slotEnv(): string {
  return writes.find((w) => w.path.endsWith("/.env"))?.content ?? "";
}

function overlay(): string {
  return writes.find((w) => w.path.endsWith("docker-compose.override.yml"))?.content ?? "";
}

beforeEach(() => {
  writes.length = 0;
  vi.clearAllMocks();
  childApps.mockResolvedValue([]);
});

describe("build — operator-set DSN", () => {
  it("passes an app's own SENTRY_DSN through to the container", async () => {
    await build(makeCtx({ envMap: { PORT: "3000", SENTRY_DSN: "https://operator@sentry.io/9" } }));

    expect(slotEnv()).toContain("SENTRY_DSN=https://operator@sentry.io/9");
  });

  it("passes an app's own GLITCHTIP_DSN through to the container", async () => {
    await build(makeCtx({ envMap: { PORT: "3000", GLITCHTIP_DSN: "https://operator@errors.example.com/1" } }));

    expect(slotEnv()).toContain("GLITCHTIP_DSN=https://operator@errors.example.com/1");
  });

  it("gives a decomposed child its own operator DSN", async () => {
    childApps.mockResolvedValue([
      {
        composeService: "api",
        exposedPorts: null,
        envContent: "SENTRY_DSN=https://operator@sentry.io/7",
      },
    ]);

    await build(
      makeCtx({
        compose: {
          services: { api: { name: "api", image: "api" }, worker: { name: "worker", image: "worker" } },
        },
        bareCompose: {
          services: { api: { name: "api", image: "api" }, worker: { name: "worker", image: "worker" } },
        },
      }),
    );

    expect(overlay()).toContain("SENTRY_DSN: https://operator@sentry.io/7");
  });

  it("adds no DSN of its own", async () => {
    await build(makeCtx());

    expect(overlay()).not.toContain("SENTRY_DSN");
    expect(overlay()).not.toContain("GLITCHTIP_DSN");
    expect(slotEnv()).not.toContain("DSN");
  });
});
