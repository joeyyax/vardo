// ---------------------------------------------------------------------------
// The build step hands each service a GLITCHTIP_DSN through the compose
// overlay — and a broken GlitchTip leaves the deploy alone.
// ---------------------------------------------------------------------------

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { DeployContext, DeployApp } from "@/lib/docker/deploy-context";

const { writes, childApps, featureEnabled, available, ensureProjectDSN } = vi.hoisted(() => ({
  writes: [] as { path: string; content: string }[],
  childApps: vi.fn().mockResolvedValue([] as unknown[]),
  featureEnabled: vi.fn().mockResolvedValue(true),
  available: vi.fn().mockResolvedValue(true),
  ensureProjectDSN: vi.fn(async (name: string) => `https://key@glitchtip/${name}`),
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
vi.mock("@/lib/config/features", () => ({ isFeatureEnabledAsync: featureEnabled }));
vi.mock("@/lib/error-tracking/client", () => ({
  isGlitchTipAvailable: available,
  ensureProjectDSN,
}));

import { build } from "@/lib/docker/deploy-steps/build";
import { clearDSNCache } from "@/lib/error-tracking/inject";

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

function overlay(): string {
  return writes.find((w) => w.path.endsWith("docker-compose.override.yml"))?.content ?? "";
}

beforeEach(() => {
  writes.length = 0;
  clearDSNCache();
  vi.clearAllMocks();
  childApps.mockResolvedValue([]);
  featureEnabled.mockResolvedValue(true);
  available.mockResolvedValue(true);
  ensureProjectDSN.mockImplementation(async (name: string) => `https://key@glitchtip/${name}`);
});

describe("build — error tracking injection", () => {
  it("writes the app's DSN into the overlay", async () => {
    await build(makeCtx());

    expect(overlay()).toContain("GLITCHTIP_DSN: https://key@glitchtip/blog");
  });

  it("keeps the DSN out of the deploy log", async () => {
    const ctx = makeCtx();
    await build(ctx);

    const logged = (ctx.log as unknown as { mock: { calls: string[][] } }).mock.calls.map((c) => c[0]).join("\n");
    expect(logged).not.toContain("glitchtip/blog");
    expect(logged).toContain("GLITCHTIP_DSN set for 1 service(s)");
  });

  it("finishes the deploy when GlitchTip is unreachable", async () => {
    available.mockRejectedValue(new Error("ECONNREFUSED"));

    await expect(build(makeCtx())).resolves.toBeDefined();
    expect(overlay()).not.toContain("GLITCHTIP_DSN");
  });

  it("finishes the deploy when the GlitchTip API errors", async () => {
    ensureProjectDSN.mockRejectedValue(new Error("GlitchTip API 500"));

    await expect(build(makeCtx())).resolves.toBeDefined();
    expect(overlay()).not.toContain("GLITCHTIP_DSN");
  });

  it("injects nothing when error tracking is off", async () => {
    featureEnabled.mockResolvedValue(false);

    await build(makeCtx());

    expect(ensureProjectDSN).not.toHaveBeenCalled();
    expect(overlay()).not.toContain("GLITCHTIP_DSN");
  });

  it("leaves an operator-set DSN alone", async () => {
    await build(makeCtx({ envMap: { PORT: "3000", GLITCHTIP_DSN: "https://operator@sentry.io/9" } }));

    expect(ensureProjectDSN).not.toHaveBeenCalled();
    expect(overlay()).not.toContain("GLITCHTIP_DSN");
  });

  it("gives each decomposed child its own project", async () => {
    childApps.mockResolvedValue([
      { composeService: "api", name: "stack-api", exposedPorts: null, envContent: null },
      { composeService: "worker", name: "stack-worker", exposedPorts: null, envContent: null },
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

    expect(overlay()).toContain("GLITCHTIP_DSN: https://key@glitchtip/stack-api");
    expect(overlay()).toContain("GLITCHTIP_DSN: https://key@glitchtip/stack-worker");
  });
});
