// The log shipper routes each container to the tenant on its vardo.log.account
// label, so deploy decides which organization can read a container's logs.

import { describe, it, expect, vi, beforeEach } from "vitest";

const { accounts } = vi.hoisted(() => ({ accounts: new Map<string, number>() }));

vi.mock("@/lib/ssl/generate-config", () => ({ removeAppRouteConfig: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@/lib/docker/client", () => ({ detectExposedPorts: vi.fn().mockResolvedValue([]) }));
vi.mock("@/lib/docker/label-hosts", () => ({ assertLabelHostsOwned: vi.fn().mockResolvedValue([]) }));
vi.mock("@/lib/db", () => ({ db: { query: { apps: { findMany: vi.fn().mockResolvedValue([]) } } } }));
vi.mock("@/lib/logging/account", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/logging/account")>()),
  logAccountId: vi.fn(async (orgId: string) => {
    const id = accounts.get(orgId);
    if (id === undefined) throw new Error("VictoriaLogs read requires an organization's log account");
    return id;
  }),
}));

import { resolveCompose } from "@/lib/docker/deploy-steps/resolve-compose";
import { parseCompose } from "@/lib/docker/compose-parse";
import type { DeployContext, DeployApp } from "@/lib/docker/deploy-context";

const COMPOSE = "services:\n  web:\n    image: nginx\n  db:\n    image: postgres:17\n";

async function deploy(name: string, organizationId: string) {
  const lines: string[] = [];
  const app = {
    id: `${name}-id`, organizationId, name, displayName: name, source: "direct", deployType: "compose",
    autoTraefikLabels: false, containerPort: null, restartPolicy: "unless-stopped", projectId: "p", priority: "standard",
    cpuLimit: null, memoryLimit: null, gpuEnabled: false, backendProtocol: null, domains: [],
  } as unknown as DeployApp;
  const ctx = {
    deploymentId: "d1", appId: app.id, organizationId, app,
    org: { id: organizationId, name: "Org", baseDomain: null, trusted: true, isSystemManaged: false },
    orgTrusted: true, envName: "production", envType: "production", envMap: {}, volumesList: [], appVolumes: [],
    compose: parseCompose(COMPOSE), bareCompose: parseCompose(COMPOSE), serviceConfig: {}, builtImageRefs: [],
    appDir: `/opt/vardo/apps/${name}/production`, slotDir: `/opt/vardo/apps/${name}/production/blue`,
    newProjectName: `${name}-production-blue`, activeSlot: "green", newSlot: "blue", isLocalEnv: false,
    containerPort: null, stableVolumePrefix: `${name}-production`,
    log: (line: string) => { lines.push(line); return line; },
    logs: { push: () => {} }, logLines: [], stage: () => {}, checkAbort: () => {},
  } as unknown as DeployContext;
  await resolveCompose(ctx);
  const labels = Object.fromEntries(
    Object.entries(ctx.compose.services).map(([svc, def]) => [svc, (def.labels ?? {}) as Record<string, string>]),
  );
  return { labels, lines };
}

describe("resolveCompose — log account label", () => {
  beforeEach(() => {
    accounts.clear();
    accounts.set("org-a", 7);
    accounts.set("org-b", 8);
  });

  it("labels every service of an app with its own organization's account", async () => {
    const a = await deploy("shop", "org-a");
    const b = await deploy("blog", "org-b");
    expect(a.labels.web["vardo.log.account"]).toBe("7");
    expect(a.labels.db["vardo.log.account"]).toBe("7");
    expect(b.labels.web["vardo.log.account"]).toBe("8");
  });

  it("gives Vardo's own services no account, so their logs stay in the tenant no organization reads", async () => {
    const { labels } = await deploy("collector", "org-a");
    expect(labels.web["vardo.scope"]).toBe("instance");
    expect(labels.web["vardo.log.account"]).toBeUndefined();
  });

  it("deploys without the label, and says so, when the organization has no account", async () => {
    const { labels, lines } = await deploy("shop", "org-gone");
    expect(labels.web["vardo.log.account"]).toBeUndefined();
    expect(lines.some((l) => /no log account/.test(l))).toBe(true);
  });
});
