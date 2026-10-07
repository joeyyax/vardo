// ---------------------------------------------------------------------------
// A shared service's rendered definition must not change between deploys.
// Its config hash is how the swap detects drift, so anything per-deploy on it
// reads as drift on every deploy.
// ---------------------------------------------------------------------------

import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

vi.mock("@/lib/ssl/generate-config", () => ({
  removeAppRouteConfig: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/docker/client", () => ({
  detectExposedPorts: vi.fn().mockResolvedValue([]),
}));
vi.mock("@/lib/db", () => ({
  db: { query: { apps: { findMany: vi.fn().mockResolvedValue([]) } } },
}));

import { resolveCompose } from "@/lib/docker/deploy-steps/resolve-compose";
import { parseCompose } from "@/lib/docker/compose-parse";
import { buildVardoOverlay } from "@/lib/docker/compose-inject";
import { partitionBySlot } from "@/lib/docker/slot-partition";
import { NETWORK_NAME } from "@/lib/docker/constants";
import type { DeployContext, DeployApp } from "@/lib/docker/deploy-context";

const vardoCompose = readFileSync(join(process.cwd(), "docker-compose.yml"), "utf-8");

function app(): DeployApp {
  return {
    id: "app-id",
    organizationId: "org-id",
    name: "vardo",
    displayName: "Vardo",
    source: "git",
    deployType: "compose",
    autoTraefikLabels: true,
    containerPort: 3000,
    restartPolicy: "unless-stopped",
    projectId: "project-id",
    priority: "standard",
    cpuLimit: null,
    memoryLimit: null,
    gpuEnabled: false,
    backendProtocol: null,
    domains: [
      {
        id: "dom-id-abcdef12",
        domain: "vardo.example.com",
        isPrimary: true,
        port: null,
        sslEnabled: true,
        certResolver: "le",
        redirectTo: null,
        redirectCode: null,
      },
    ],
  } as unknown as DeployApp;
}

async function render(deploymentId: string, slot: "blue" | "green") {
  const compose = parseCompose(vardoCompose);
  const a = app();
  const ctx = {
    deploymentId,
    appId: a.id,
    organizationId: a.organizationId,
    app: a,
    envName: "production",
    envType: "production",
    envMap: {},
    volumesList: [],
    appVolumes: [],
    compose,
    bareCompose: parseCompose(vardoCompose),
    serviceConfig: {},
    builtImageRefs: [],
    appDir: "/opt/vardo/apps/vardo/production",
    slotDir: `/opt/vardo/apps/vardo/production/${slot}`,
    newProjectName: `vardo-production-${slot}`,
    activeSlot: slot === "blue" ? "green" : "blue",
    newSlot: slot,
    isLocalEnv: false,
    containerPort: 3000,
    stableVolumePrefix: "vardo-production",
    log: (line: string) => line,
    logs: { push: () => {} },
    logLines: [],
    stage: () => {},
    checkAbort: () => {},
  } as unknown as DeployContext;

  await resolveCompose(ctx);
  const overlay = buildVardoOverlay({
    fullCompose: ctx.compose,
    networkName: NETWORK_NAME,
    externalVolumes: ctx.compose.volumes ?? {},
    bareVolumeNames: Object.keys(ctx.bareCompose.volumes ?? {}),
  });
  const shared = Object.keys(partitionBySlot(ctx.compose).shared);
  const pick = (c: { services: Record<string, unknown> }) =>
    Object.fromEntries(shared.map((name) => [name, c.services[name]]));
  return { shared, base: pick(ctx.bareCompose), overlay: pick(overlay), frontend: overlay.services.frontend };
}

describe("resolveCompose — shared services across deploys", () => {
  it("renders Vardo's shared services identically for two deploys into different slots", async () => {
    const first = await render("deploy-aaaa", "green");
    const second = await render("deploy-bbbb", "blue");

    expect(first.shared).toEqual(["postgres", "redis", "buildkit", "traefik", "wireguard"]);
    expect(second.base).toEqual(first.base);
    expect(second.overlay).toEqual(first.overlay);
  });

  it("still stamps the deployment id on rotating services", async () => {
    const { frontend, overlay } = await render("deploy-aaaa", "green");

    expect(frontend.labels?.["vardo.deployment.id"]).toBe("deploy-aaaa");
    for (const service of Object.values(overlay) as { labels?: Record<string, string> }[]) {
      expect(service.labels?.["vardo.deployment.id"]).toBeUndefined();
    }
  });
});
