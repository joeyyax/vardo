// ---------------------------------------------------------------------------
// Integration tests for resolveCompose — the deploy step that applies all
// Vardo transforms to a user compose file. These tests exist because unit
// tests against the individual injectors can't catch pipeline ordering
// regressions (the exact class of bug the agents outage was caused by).
// ---------------------------------------------------------------------------

import { describe, it, expect, vi } from "vitest";
import type { ComposeFile } from "@/lib/docker/compose";
import type { DeployContext, DeployApp } from "@/lib/docker/deploy-context";

// The SSL config writer is a fs side-effect; the real implementation touches
// /etc/traefik. resolveCompose fires it as a best-effort cleanup, so stubbing
// it is fine.
vi.mock("@/lib/ssl/generate-config", () => ({
  removeAppRouteConfig: vi.fn().mockResolvedValue(undefined),
}));

// detectExposedPorts inspects a Docker image — not relevant when app has
// containerPort set, but we mock it to keep tests hermetic.
vi.mock("@/lib/docker/client", () => ({
  detectExposedPorts: vi.fn().mockResolvedValue([]),
}));

import { resolveCompose } from "@/lib/docker/deploy-steps/resolve-compose";

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

function makeApp(overrides: Partial<DeployApp> = {}): DeployApp {
  return {
    id: "app-id",
    organizationId: "org-id",
    name: "agents",
    displayName: "Agents",
    description: null,
    source: "git",
    deployType: "compose",
    gitUrl: "https://github.com/example/agents",
    gitBranch: "main",
    gitKeyId: null,
    imageName: null,
    composeContent: null,
    composeFilePath: null,
    dockerfilePath: null,
    rootDirectory: null,
    autoTraefikLabels: true,
    containerPort: 3000,
    autoDeploy: true,
    exposedPorts: null,
    restartPolicy: "unless-stopped",
    projectId: "project-id",
    templateName: null,
    status: "active",
    needsRedeploy: false,
    cpuLimit: null,
    memoryLimit: null,
    gpuEnabled: false,
    healthCheckTimeout: null,
    autoRollback: null,
    rollbackGracePeriod: null,
    backendProtocol: null,
    envContent: null,
    parentAppId: null,
    composeService: null,
    containerName: null,
    importedContainerId: null,
    importedComposeProject: null,
    configSource: null,
    domains: [
      {
        id: "dom-id-abcdef12",
        domain: "agents.example.com",
        isPrimary: true,
        port: null,
        sslEnabled: true,
        certResolver: "le",
        redirectTo: null,
        redirectCode: null,
      },
    ],
    ...overrides,
  };
}

function makeCtx(compose: ComposeFile, app: DeployApp): DeployContext {
  const logLines: string[] = [];
  // Cast via unknown is intentional — resolveCompose only reads a subset
  // of DeployContext fields and doesn't exercise the full lifecycle shape.
  return {
    deploymentId: "dep-id",
    appId: app.id,
    organizationId: app.organizationId,
    trigger: "manual",
    app,
    org: null,
    orgTrusted: false,
    projectAllowBindMounts: false,
    envName: "production",
    envType: "production",
    envBranchOverride: null,
    envMap: {},
    volumesList: [],
    appVolumes: [],
    effectiveSource: app.source,
    compose,
    bareCompose: compose,
    builtLocally: false,
    hostConfig: null,
    repoDir: null,
    appBase: "/tmp/vardo/apps",
    appDir: "/tmp/vardo/apps/agents/production",
    slotDir: "/tmp/vardo/apps/agents/production/green",
    newProjectName: "agents-production-green",
    activeSlot: "blue",
    newSlot: "green",
    isLocalEnv: false,
    containerPort: 3000,
    composeFileArgs: [],
    stableVolumePrefix: "agents-production",
    log: (line: string) => {
      logLines.push(line);
      return line;
    },
    stage: () => {},
    checkAbort: () => {},
    logs: { push: (line: string) => logLines.push(line) },
    logLines,
    startTime: Date.now(),
  } as unknown as DeployContext;
}

// ---------------------------------------------------------------------------
// The actual regression tests
// ---------------------------------------------------------------------------

describe("resolveCompose — vardo-network scoping (agents outage regression)", () => {
  it("attaches vardo-network only to the Traefik-routed service", async () => {
    // This is the agents-production compose, minimized. Before the fix,
    // every service ended up on vardo-network with their service name
    // as a DNS alias — so postgres/redis collided with glitchtip's
    // same-named services and ~60% of connections hit the wrong host.
    const compose: ComposeFile = {
      services: {
        dashboard: {
          name: "dashboard",
          image: "dashboard",
          networks: ["internal"],
        },
        worker: { name: "worker", image: "worker", networks: ["internal"] },
        postgres: {
          name: "postgres",
          image: "postgres:17",
          networks: ["internal"],
          volumes: ["postgres-data:/var/lib/postgresql/data"],
        },
        redis: {
          name: "redis",
          image: "redis:7",
          networks: ["internal"],
          volumes: ["redis-data:/data"],
        },
        bot: { name: "bot", image: "bot", networks: ["internal"] },
      },
      networks: { internal: null },
      volumes: { "postgres-data": null, "redis-data": null },
    };

    const ctx = makeCtx(compose, makeApp());
    await resolveCompose(ctx);

    // Dashboard is routed → joins vardo-network.
    expect(ctx.compose.services.dashboard.networks).toContain("vardo-network");
    // Everything else stays private to the project network — this is
    // THE assertion that catches the outage regression.
    expect(ctx.compose.services.postgres.networks).not.toContain("vardo-network");
    expect(ctx.compose.services.redis.networks).not.toContain("vardo-network");
    expect(ctx.compose.services.worker.networks).not.toContain("vardo-network");
    expect(ctx.compose.services.bot.networks).not.toContain("vardo-network");
  });

  it("skips vardo-network entirely when the app has no domains", async () => {
    // Worker-only stacks have no ingress → nothing should join vardo-network.
    // The previous fallback was "attach everywhere when no routed service",
    // which is exactly the bug.
    const compose: ComposeFile = {
      services: {
        worker: { name: "worker", image: "worker" },
        queue: { name: "queue", image: "redis:7" },
      },
    };

    const ctx = makeCtx(compose, makeApp({ domains: [] }));
    await resolveCompose(ctx);

    // Defensive: services may have `networks: undefined` when no network
    // was ever attached — ?? [] so .not.toContain works either way.
    expect(ctx.compose.services.worker.networks ?? []).not.toContain("vardo-network");
    expect(ctx.compose.services.queue.networks ?? []).not.toContain("vardo-network");
    expect(ctx.compose.networks?.["vardo-network"]).toBeUndefined();
  });

  it("still tags every service with vardo.* labels regardless of network scoping", async () => {
    // Scoping vardo-network must NOT affect the labels — the metrics/
    // discovery layer depends on every vardo-managed container being
    // tagged with vardo.project / vardo.environment / etc.
    const compose: ComposeFile = {
      services: {
        dashboard: { name: "dashboard", image: "dashboard" },
        postgres: {
          name: "postgres",
          image: "postgres:17",
          volumes: ["data:/var/lib/postgresql/data"],
        },
      },
      volumes: { data: null },
    };

    const ctx = makeCtx(compose, makeApp());
    await resolveCompose(ctx);

    expect(ctx.compose.services.dashboard.labels?.["vardo.project"]).toBe("agents");
    expect(ctx.compose.services.postgres.labels?.["vardo.project"]).toBe("agents");
    expect(ctx.compose.services.postgres.labels?.["vardo.managed"]).toBe("true");
  });

  it("skips GPU reservations for services mounting externalized volumes", async () => {
    // Follow-up fix — postgres/redis should not get NVIDIA reservations
    // when the app has gpuEnabled=true.
    const compose: ComposeFile = {
      services: {
        dashboard: { name: "dashboard", image: "dashboard" },
        postgres: {
          name: "postgres",
          image: "postgres:17",
          volumes: ["data:/var/lib/postgresql/data"],
        },
      },
      volumes: { data: null },
    };

    const ctx = makeCtx(compose, makeApp({ gpuEnabled: true }));
    await resolveCompose(ctx);

    const dashDevices = ctx.compose.services.dashboard.deploy?.resources?.reservations?.devices;
    const pgDevices = ctx.compose.services.postgres.deploy?.resources?.reservations?.devices;
    expect(dashDevices?.[0]?.capabilities).toContain("gpu");
    expect(pgDevices).toBeUndefined();
  });
});
