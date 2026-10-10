import { describe, it, expect, vi, beforeEach } from "vitest";
import { tokenScopeCapabilities } from "@/lib/auth/permissions";

const { mockFeature, mockInstanceAdminUser, mockGetSession, mockGetCurrentOrg, mockIsAppAdmin } = vi.hoisted(() => ({
  mockFeature: vi.fn(),
  mockInstanceAdminUser: vi.fn(),
  mockGetSession: vi.fn(),
  mockGetCurrentOrg: vi.fn(),
  mockIsAppAdmin: vi.fn(),
}));

vi.mock("@/lib/db", async () => {
  const { dbMock } = await import("@/tests/helpers/db");
  const rows = Object.assign(Promise.resolve([]), { groupBy: async () => [] });
  return { db: { ...dbMock.db, select: () => ({ from: () => ({ where: () => rows }) }) } };
});
vi.mock("@/lib/config/features", () => ({
  isFeatureEnabledAsync: mockFeature,
  getFeatureFlags: vi.fn(async () => ({})),
}));
vi.mock("@/lib/auth/system-org", () => ({ isInstanceAdminUser: mockInstanceAdminUser }));
vi.mock("@/lib/auth/session", () => ({ getSession: mockGetSession, getCurrentOrg: mockGetCurrentOrg }));
vi.mock("@/lib/auth/admin", () => ({ isAppAdmin: mockIsAppAdmin }));
vi.mock("@/lib/db/app-restarts", () => ({ restartCountsByApp: vi.fn(async () => new Map()), restartReading: vi.fn() }));
vi.mock("@/lib/user/preferences", () => ({ getUserPreferences: vi.fn(async () => ({ density: "comfortable" })) }));
vi.mock("@/lib/system-settings", () => ({
  getEmailProviderConfig: vi.fn(async () => null),
  getInstanceConfig: vi.fn(async () => ({ baseDomain: "example.test" })),
}));

import { dbMock } from "@/tests/helpers/db";
import type { Actor, Organization } from "@/lib/app-services/actor";
import { FeatureDisabledError, ForbiddenError, InvalidInputError, NotFoundError } from "@/lib/app-services/errors";
import { getApp, loadNewAppPage } from "@/lib/app-services/apps";
import { createProject, listProjectsApps, loadProjectDetail } from "@/lib/app-services/projects";
import { listBackupAppOptions } from "@/lib/app-services/backups";
import { listInvitations, listMembers } from "@/lib/app-services/team";
import { mcpActor } from "@/lib/app-services/mcp-actor";
import { actorForOrg } from "@/lib/app-services/session-actor";

const ORG = { id: "org-1", name: "Ops", slug: "ops", isSystemManaged: false } as Organization;

function actor(role: string, extra: Partial<Actor> = {}): Actor {
  return { userId: "user-1", org: ORG, membership: { role }, instanceAdmin: false, ...extra };
}

type QueryArg = {
  where?: unknown;
  with?: Record<string, { with: Record<string, { columns: Record<string, boolean> }> }>;
};

/** The options object a query mock was first called with. */
function queryArg(fn: { mock: { calls: unknown[][] } }): QueryArg {
  return fn.mock.calls[0][0] as QueryArg;
}

/** Values bound in a Drizzle where clause. */
function boundValues(where: unknown): unknown[] {
  const values: unknown[] = [];
  const walk = (node: unknown) => {
    if (Array.isArray(node)) return node.forEach(walk);
    if (!node || typeof node !== "object") return;
    const obj = node as Record<string, unknown>;
    if ("encoder" in obj) values.push(obj.value);
    if (Array.isArray(obj.queryChunks)) walk(obj.queryChunks);
  };
  walk((where as { queryChunks?: unknown[] })?.queryChunks ?? []);
  return values;
}

beforeEach(() => {
  vi.clearAllMocks();
  dbMock.reset();
  mockFeature.mockResolvedValue(true);
  mockInstanceAdminUser.mockResolvedValue(false);
});

describe("org scoping", () => {
  it("looks an app up only inside the actor's org, so another org's id reads as not found", async () => {
    dbMock.query.apps.findFirst.mockResolvedValue(undefined);

    await expect(getApp(actor("owner"), "app-in-org-2")).rejects.toBeInstanceOf(NotFoundError);
    expect(boundValues(queryArg(dbMock.query.apps.findFirst).where)).toEqual(["app-in-org-2", "org-1"]);
  });

  it("scopes member and project lists to the actor's org", async () => {
    await listMembers(actor("member"));
    await listProjectsApps(actor("member"));

    expect(boundValues(queryArg(dbMock.query.memberships.findMany).where)).toEqual(["org-1"]);
    expect(boundValues(queryArg(dbMock.query.apps.findMany).where)).toContain("org-1");
  });

  it("gives an API caller no actor for an org other than their current one", async () => {
    mockGetSession.mockResolvedValue({ user: { id: "user-1" } });
    mockGetCurrentOrg.mockResolvedValue({ organization: ORG, membership: { role: "owner" } });
    mockIsAppAdmin.mockResolvedValue(false);

    expect(await actorForOrg("org-2")).toBeNull();
    expect((await actorForOrg("org-1"))?.org.id).toBe("org-1");
  });

  it("refuses an API caller with no session", async () => {
    mockGetSession.mockResolvedValue(null);
    await expect(actorForOrg("org-1")).rejects.toThrow("Unauthorized");
  });
});

describe("MCP actors", () => {
  const token = { userId: "user-1", organizationId: "org-1", crossOrg: false };

  it("never resolves another org for a single-org token", async () => {
    expect(await mcpActor(token, "org-2", "app.view")).toBeNull();
    expect(dbMock.query.memberships.findFirst).not.toHaveBeenCalled();
  });

  it("resolves a cross-org token only where its user is a member", async () => {
    dbMock.query.memberships.findFirst.mockResolvedValue(undefined);
    expect(await mcpActor({ ...token, crossOrg: true }, "org-2", "app.view")).toBeNull();
  });

  it("keeps the system org from a user who is no longer an instance admin", async () => {
    dbMock.query.memberships.findFirst.mockResolvedValue({
      id: "m1",
      role: "owner",
      organization: { ...ORG, isSystemManaged: true },
    });
    expect(await mcpActor(token, "org-1", "app.view")).toBeNull();
  });

  it("narrows the role to the token's scope", async () => {
    dbMock.query.memberships.findFirst.mockResolvedValue({ id: "m1", role: "owner", organization: ORG });
    const readToken = { ...token, scopes: tokenScopeCapabilities("read", null) };

    expect(await mcpActor(readToken, "org-1", "project.manage")).toBeNull();
    expect((await mcpActor(readToken, "org-1", "app.view"))?.membership.role).toBe("owner");
  });
});

describe("capabilities", () => {
  it("refuses the new-app bootstrap to a role without app.create, before any query", async () => {
    await expect(loadNewAppPage(actor("viewer"))).rejects.toBeInstanceOf(ForbiddenError);
    expect(dbMock.query.projects.findMany).not.toHaveBeenCalled();
  });

  it("refuses a read-scoped token a project write its role allows", async () => {
    const scoped = actor("owner", { membership: { role: "owner", scopes: tokenScopeCapabilities("read", null) } });
    await expect(createProject(scoped, { name: "web", displayName: "Web" })).rejects.toBeInstanceOf(ForbiddenError);
    expect(dbMock.inserts).toHaveLength(0);
  });

  it("lets an instance admin list backup apps in an org where their role can't", async () => {
    await expect(listBackupAppOptions(actor("viewer"))).rejects.toBeInstanceOf(ForbiddenError);
    await expect(listBackupAppOptions(actor("viewer", { instanceAdmin: true }))).resolves.toEqual([]);
  });

  it("masks compose env in an app read without env.reveal", async () => {
    const compose = "services:\n  db:\n    environment:\n      PASSWORD: hunter2\n";
    dbMock.query.apps.findFirst.mockResolvedValue({ id: "a1", composeContent: compose, envContent: "v1:x", deployments: [] });

    expect(JSON.stringify(await getApp(actor("member"), "a1"))).not.toContain("hunter2");
    dbMock.query.apps.findFirst.mockResolvedValue({ id: "a1", composeContent: compose, envContent: "v1:x", deployments: [] });
    expect((await getApp(actor("admin"), "a1")).composeContent).toBe(compose);
  });

  it("reports a disabled feature rather than an empty list", async () => {
    mockFeature.mockImplementation(async (flag: string) => flag !== "teams");
    await expect(listInvitations(actor("owner"))).rejects.toBeInstanceOf(FeatureDisabledError);
  });
});

describe("behavior settled by the move", () => {
  it("holds every caller to the project name rule, MCP included", async () => {
    await expect(createProject(actor("member"), { name: "My Project", displayName: "Mine" })).rejects.toBeInstanceOf(
      InvalidInputError,
    );
    expect(dbMock.inserts).toHaveLength(0);
  });

  it("never loads env var values for the project page", async () => {
    dbMock.query.projects.findFirst.mockResolvedValue(undefined);
    await expect(loadProjectDetail(actor("member"), "web")).rejects.toBeInstanceOf(NotFoundError);

    const { envVars } = queryArg(dbMock.query.projects.findFirst).with!.apps.with;
    expect(envVars.columns).not.toHaveProperty("value");
  });

  it("masks git credentials in the Projects list", async () => {
    dbMock.query.apps.findMany.mockResolvedValue([
      {
        id: "a1",
        gitUrl: "https://user:token@example.test/repo.git",
        domains: [],
        deployments: [],
        appTags: [],
        childApps: [],
      },
    ]);

    const [app] = await listProjectsApps(actor("member"));
    expect(app.gitUrl).not.toContain("token");
  });
});
