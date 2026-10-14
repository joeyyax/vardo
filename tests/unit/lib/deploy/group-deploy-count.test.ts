// The count Deploy all announces at enqueue is the set the group job deploys.

import { beforeEach, describe, expect, it, vi } from "vitest";

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
vi.mock("@/lib/redis", () => ({ redis: {} }));
vi.mock("@/lib/logger", async () => (await import("@/tests/helpers/mocks")).loggerModule());
vi.mock("@/lib/deploy/request", () => ({ deployAndWait: deployAndWaitMock }));

const { groupDeployCount } = await import("@/lib/deploy/group-job");
const { deployGroup } = await import("@/lib/docker/deploy-group");

const app = (id: string, dependsOn: string[] | null = null) => ({ id, name: id, projectId: "proj", organizationId: "org-1", parentAppId: null, dependsOn });

beforeEach(() => {
  vi.clearAllMocks();
  appsFindMany.mockResolvedValue([app("api", ["redis"]), app("redis"), app("notes")]);
  envsFindMany.mockResolvedValue([
    { id: "env-api", appId: "api", groupEnvironmentId: "ge-1" },
    { id: "env-redis", appId: "redis", groupEnvironmentId: "ge-1" },
  ]);
  deployAndWaitMock.mockImplementation(async (opts: { appId: string }) => ({ deploymentId: `dep-${opts.appId}`, status: "success", success: true, durationMs: 1, log: "" }));
});

describe("groupDeployCount", () => {
  it.each([
    ["production", undefined, 3],
    ["a group environment", "ge-1", 2],
  ])("matches the deploys the job runs for %s", async (_label, groupEnvironmentId, expected) => {
    const request = { projectId: "proj", organizationId: "org-1", trigger: "manual" as const, groupEnvironmentId };
    const count = await groupDeployCount(request);
    await deployGroup(request);
    expect(count).toBe(expected);
    expect(deployAndWaitMock).toHaveBeenCalledTimes(count);
  });
});
