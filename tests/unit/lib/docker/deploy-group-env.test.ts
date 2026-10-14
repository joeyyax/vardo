import { describe, it, expect, beforeEach, vi } from "vitest";

// An app in the project with no environment in the group used to deploy with
// environmentId undefined, which runDeployment resolves to production.

const { deployAndWaitMock, appsFindMany, envsFindMany } = vi.hoisted(() => ({
  deployAndWaitMock: vi.fn(),
  appsFindMany: vi.fn(),
  envsFindMany: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  db: {
    query: {
      projects: { findFirst: vi.fn().mockResolvedValue({ id: "proj", name: "AI" }) },
      apps: { findMany: appsFindMany },
      environments: { findMany: envsFindMany },
      envVars: { findMany: vi.fn().mockResolvedValue([]) },
    },
  },
}));
vi.mock("@/lib/deploy/request", () => ({ deployAndWait: deployAndWaitMock }));

import { deployGroup } from "@/lib/docker/deploy-group";

const app = (id: string, name: string, dependsOn: string[] | null = null) => ({
  id,
  name,
  projectId: "proj",
  organizationId: "org-1",
  parentAppId: null,
  dependsOn,
});

beforeEach(() => {
  vi.clearAllMocks();
  appsFindMany.mockResolvedValue([
    app("svc", "tools-api", ["redis"]),
    app("redis", "redis"),
    app("ks", "notes-api"),
  ]);
  envsFindMany.mockResolvedValue([
    { id: "env-svc", appId: "svc", groupEnvironmentId: "ge-1" },
    { id: "env-redis", appId: "redis", groupEnvironmentId: "ge-1" },
  ]);
  deployAndWaitMock.mockImplementation(async (opts: { appId: string }) => ({
    deploymentId: `dep-${opts.appId}`,
    status: "success",
    success: true,
    durationMs: 1,
    log: "",
  }));
});

describe("deployGroup with a group environment", () => {
  it("never requests a deploy without an environmentId", async () => {
    await deployGroup({ projectId: "proj", organizationId: "org-1", trigger: "webhook", groupEnvironmentId: "ge-1" });

    expect(deployAndWaitMock).toHaveBeenCalled();
    for (const [opts] of deployAndWaitMock.mock.calls) {
      expect(opts.environmentId).toBeTruthy();
    }
  });

  it("deploys only the apps the group has an environment for", async () => {
    await deployGroup({ projectId: "proj", organizationId: "org-1", trigger: "webhook", groupEnvironmentId: "ge-1" });

    const deployed = deployAndWaitMock.mock.calls.map(([opts]) => [opts.appId, opts.environmentId]);
    expect(deployed.sort()).toEqual([
      ["redis", "env-redis"],
      ["svc", "env-svc"],
    ]);
  });

  it("deploys every top-level app for a production group deploy", async () => {
    await deployGroup({ projectId: "proj", organizationId: "org-1", trigger: "manual" });

    expect(deployAndWaitMock).toHaveBeenCalledTimes(3);
  });
});
