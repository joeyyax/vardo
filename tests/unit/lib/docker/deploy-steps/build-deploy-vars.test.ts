// Every rotating service gets Vardo's deploy variables in the overlay; an app's own value wins.

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { DeployContext, DeployApp } from "@/lib/docker/deploy-context";

process.env.ENCRYPTION_MASTER_KEY = "1".repeat(64);

const { childApps } = vi.hoisted(() => ({ childApps: [] as Record<string, unknown>[] }));

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
      apps: { findMany: vi.fn(async () => childApps), findFirst: vi.fn() },
      orgEnvVars: { findMany: vi.fn(async () => []) },
    },
  },
}));
vi.mock("@/lib/env/resolve", () => ({ resolveAllEnvVars: vi.fn(async (env: Record<string, string>) => env) }));
vi.mock("@/lib/docker/slots", () => ({ detectActiveSlot: vi.fn().mockResolvedValue("blue") }));
vi.mock("@/lib/docker/compose-policy", () => ({ assertComposeWithinApp: vi.fn(async () => ({ legacyPaths: [] })) }));
vi.mock("@/lib/docker/bind-roots", () => ({ setBindWarnings: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@/lib/docker/self-env", () => ({ isSelfApp: () => false, seedSelfEnv: vi.fn().mockResolvedValue(null) }));

import { build } from "@/lib/docker/deploy-steps/build";

const OLD_SHA = "1".repeat(40);
const NEW_SHA = "2".repeat(40);

function makeCtx(overrides: Partial<DeployContext> = {}, appOverrides: Partial<DeployApp> = {}): DeployContext {
  const app = {
    id: "app-id",
    organizationId: "org-id",
    name: "blog",
    displayName: "Blog",
    source: "git",
    deployType: "compose",
    containerPort: 3000,
    memoryLimit: 512,
    priority: "standard",
    exposedPorts: null,
    rootDirectory: null,
    domains: [{ id: "d1", appId: "app-id", domain: "blog.example.com", isPrimary: true, sslEnabled: true }],
    ...appOverrides,
  } as unknown as DeployApp;
  const services = { web: { name: "web", image: "nginx" } };
  return {
    deploymentId: "dep-new",
    appId: "app-id",
    organizationId: "org-id",
    app,
    org: null,
    envName: "production",
    envType: "production",
    envMap: {},
    gitSha: NEW_SHA,
    gitBranch: "main",
    compose: { services },
    bareCompose: { services: structuredClone(services) },
    serviceConfig: {},
    appDir: "/srv/apps/blog/production",
    repoDir: null,
    log: vi.fn(),
    stage: vi.fn(),
    checkAbort: vi.fn(),
    logs: { push: vi.fn() },
    ...overrides,
  } as unknown as DeployContext;
}

const envOf = (ctx: DeployContext, service: string) =>
  (ctx.overlayCompose?.services[service]?.environment ?? {}) as Record<string, string>;

beforeEach(() => {
  vi.clearAllMocks();
  childApps.length = 0;
});

describe("build — deploy variables", () => {
  it("sets each variable in the overlay and records them", async () => {
    const ctx = await build(makeCtx());
    const env = envOf(ctx, "web");

    expect(env).toMatchObject({
      VARDO_GIT_SHA: NEW_SHA,
      VARDO_GIT_BRANCH: "main",
      VARDO_DEPLOY_ID: "dep-new",
      VARDO_APP_NAME: "blog",
      VARDO_APP_URL: "https://blog.example.com",
      VARDO_ENVIRONMENT: "production",
      VARDO_MEMORY_LIMIT: String(512 * 1024 ** 2),
      VARDO_SLOT: "green",
    });
    expect(Number.isNaN(Date.parse(env.VARDO_DEPLOYED_AT))).toBe(false);
    expect(ctx.deployVars).toEqual({ web: env });
  });

  it("a rollback carries the target's commit with its own deploy id", async () => {
    const ctx = await build(makeCtx({
      gitSha: OLD_SHA,
      rollback: { targetDeploymentId: "dep-old", gitSha: OLD_SHA },
    }));
    expect(envOf(ctx, "web").VARDO_GIT_SHA).toBe(OLD_SHA);
    expect(envOf(ctx, "web").VARDO_DEPLOY_ID).toBe("dep-new");
  });

  it("gives an app without a repo no commit or branch", async () => {
    const ctx = await build(makeCtx({ gitSha: undefined, gitBranch: undefined }, { source: "direct", deployType: "image" } as Partial<DeployApp>));
    const env = envOf(ctx, "web");
    expect(env).not.toHaveProperty("VARDO_GIT_SHA");
    expect(env).not.toHaveProperty("VARDO_GIT_BRANCH");
    expect(env.VARDO_DEPLOY_ID).toBe("dep-new");
  });

  it("leaves a name the app's env or the service sets to them", async () => {
    const ctx = makeCtx({ envMap: { VARDO_APP_URL: "https://mine.example.com" } });
    ctx.compose.services.web.environment = { VARDO_GIT_SHA: "${VARDO_GIT_SHA}" };
    await build(ctx);
    const env = envOf(ctx, "web");
    expect(env).not.toHaveProperty("VARDO_APP_URL");
    expect(env).not.toHaveProperty("VARDO_GIT_SHA");
    expect(env.VARDO_APP_NAME).toBe("blog");
  });

  it("applies the learned default to the memory variable", async () => {
    const ctx = await build(makeCtx({ learnedMemory: { mb: 300, reason: "peak" } }, { memoryLimit: null }));
    expect(envOf(ctx, "web").VARDO_MEMORY_LIMIT).toBe(String(300 * 1024 ** 2));
  });

  it("leaves shared services alone", async () => {
    const services = {
      web: { name: "web", image: "nginx" },
      db: { name: "db", image: "postgres", "x-vardo-shared": true },
    };
    const ctx = await build(makeCtx({ compose: { services }, bareCompose: { services: structuredClone(services) } }));
    expect(envOf(ctx, "web").VARDO_DEPLOY_ID).toBe("dep-new");
    expect(envOf(ctx, "db")).toEqual({});
    expect(Object.keys(ctx.deployVars ?? {})).toEqual(["web"]);
  });

  it("gives each child service its own name and URL, with the child's variable winning", async () => {
    childApps.push(
      { id: "child-api", name: "blog-api", composeService: "api", exposedPorts: null, envContent: null },
      { id: "child-worker", name: "blog-worker", composeService: "worker", exposedPorts: null, envContent: null },
    );
    const services = {
      web: { name: "web", image: "nginx" },
      api: { name: "api", image: "api" },
      worker: { name: "worker", image: "worker" },
    };
    const ctx = makeCtx(
      { compose: { services }, bareCompose: { services: structuredClone(services) }, envMap: { VARDO_APP_NAME: "parent-own" } },
      {
        domains: [
          { id: "d1", appId: "app-id", domain: "blog.example.com", isPrimary: true },
          { id: "d2", appId: "child-api", domain: "api.example.com", serviceName: "api", isPrimary: true },
        ],
      } as Partial<DeployApp>,
    );
    await build(ctx);
    expect(envOf(ctx, "web")).not.toHaveProperty("VARDO_APP_NAME");
    expect(envOf(ctx, "api")).toMatchObject({ VARDO_APP_NAME: "blog-api", VARDO_APP_URL: "https://api.example.com" });
    expect(envOf(ctx, "worker")).toMatchObject({ VARDO_APP_NAME: "blog-worker", VARDO_APP_URL: "https://blog.example.com" });
  });

  it("a preview gets its own name and URL", async () => {
    const ctx = await build(makeCtx(
      { envName: "pr-12", envType: "preview", envIsolated: true },
      { domains: [{ id: "env-1", appId: "app-id", domain: "pr-12.blog.example.com", isPrimary: true }] } as Partial<DeployApp>,
    ));
    expect(envOf(ctx, "web")).toMatchObject({ VARDO_ENVIRONMENT: "pr-12", VARDO_APP_URL: "https://pr-12.blog.example.com" });
  });

  it("keeps per-deploy values out of compose build args", async () => {
    const services = { web: { name: "web", build: { context: "." } } };
    const ctx = await build(makeCtx({
      compose: { services },
      bareCompose: { services: structuredClone(services) },
      repoDir: "/srv/apps/blog/repo",
    } as Partial<DeployContext>));
    const args = (ctx.compose.services.web.build as unknown as { args: Record<string, string> }).args;
    expect(args).toEqual({ VARDO_GIT_SHA: NEW_SHA, VARDO_GIT_BRANCH: "main" });
  });
});
