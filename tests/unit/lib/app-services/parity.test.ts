import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

// The API route and the page loader for the same data return the same shape for the same input.

const { mockActorForOrg } = vi.hoisted(() => ({ mockActorForOrg: vi.fn() }));

vi.mock("@/lib/db", async () => {
  const { dbMock } = await import("@/tests/helpers/db");
  const rows = Object.assign(Promise.resolve([{ count: 1 }]), { groupBy: async () => [] });
  return { db: { ...dbMock.db, select: () => ({ from: () => ({ where: () => rows }) }) } };
});
vi.mock("@/lib/app-services/session-actor", () => ({ actorForOrg: mockActorForOrg }));
vi.mock("@/lib/api/with-rate-limit", async () => (await import("@/tests/helpers/mocks")).withRateLimitModule());
vi.mock("@/lib/config/features", () => ({
  isFeatureEnabledAsync: vi.fn(async () => true),
  getFeatureFlags: vi.fn(async () => ({})),
}));
vi.mock("@/lib/activity/query", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/activity/query")>()),
  countActivities: vi.fn(async () => 1),
  activityFacets: vi.fn(async () => ({ families: [], outcomes: { success: 0, failure: 0, neutral: 0 } })),
}));
vi.mock("@/lib/auth/system-org", () => ({ isInstanceAdminUser: vi.fn(async () => false) }));
vi.mock("@/lib/system-settings", () => ({ getEmailProviderConfig: vi.fn(async () => null) }));
vi.mock("@/lib/db/app-restarts", () => ({ restartCountsByApp: vi.fn(async () => new Map()), restartReading: vi.fn(() => null) }));
vi.mock("@/lib/user/preferences", () => ({ getUserPreferences: vi.fn(async () => ({ density: "comfortable", projectSort: "attention" })) }));
vi.mock("@/lib/auth/admin", () => ({ isAppAdmin: vi.fn(async () => false) }));
vi.mock("@/lib/docker/stability-history", () => ({ loadStabilityHistory: vi.fn(async () => []) }));
vi.mock("@/lib/activity/lifecycle", () => ({ loadLifecycleHistory: vi.fn(async () => []) }));

import { dbMock } from "@/tests/helpers/db";
import type { Actor, Organization } from "@/lib/app-services/actor";
import { loadActivityPage } from "@/lib/app-services/activity";
import { loadInvitationsTab, loadTeamTab } from "@/lib/app-services/team";
import { loadProjectsPage } from "@/lib/app-services/projects";
import { loadAppDetail } from "@/lib/app-services/apps";
import { EMPTY_FILTERS } from "@/lib/activity/filter";

const ORG = { id: "org-1", name: "Ops", slug: "ops", isSystemManaged: false } as Organization;
const ACTOR: Actor = { userId: "user-1", org: ORG, membership: { role: "member" }, instanceAdmin: false };
const at = new Date("2026-10-01T12:00:00Z");
const params = { params: Promise.resolve({ orgId: "org-1" }) };

/** What the client receives: JSON for the API, the RSC payload for the page (dates as ISO either way). */
const wire = <T>(value: T) => JSON.parse(JSON.stringify(value));

async function api(route: string, url: string, routeParams: unknown = params) {
  const mod = await import(`@/app/api/v1/organizations/[orgId]/${route}/route`);
  const res = await mod.GET(new NextRequest(`http://localhost${url}`), routeParams);
  expect(res.status).toBe(200);
  return res.json();
}

beforeEach(() => {
  vi.clearAllMocks();
  dbMock.reset();
  mockActorForOrg.mockResolvedValue(ACTOR);
});

describe("API and page parity", () => {
  it("members: the team tab and GET members", async () => {
    dbMock.query.memberships.findMany.mockResolvedValue([
      { role: "owner", createdAt: at, user: { id: "u1", name: "Ada", email: "ada@example.test", image: null } },
    ]);

    const page = await loadTeamTab(ACTOR);
    const body = await api("members", "/api/v1/organizations/org-1/members");

    expect(body.members).toEqual(wire(page.members));
    expect(body.members[0]).toHaveProperty("image");
  });

  it("invitations: the invitations tab and GET invitations", async () => {
    dbMock.query.invitations.findMany.mockResolvedValue([
      {
        id: "inv-1",
        email: "new@example.test",
        role: "member",
        status: "pending",
        createdAt: at,
        expiresAt: at,
        inviter: { id: "u1", name: "Ada", email: "ada@example.test" },
      },
    ]);

    const page = await loadInvitationsTab(ACTOR);
    const body = await api("invitations", "/api/v1/organizations/org-1/invitations");

    expect(body.invitations).toEqual(wire(page.invitations));
  });

  it("activity: the feed's first page and GET activities", async () => {
    dbMock.query.activities.findMany.mockResolvedValue([
      { id: "act-1", action: "deploy.success", family: "deploy", outcome: "success", metadata: {}, createdAt: at, user: null, app: null },
    ]);

    const page = await loadActivityPage(ACTOR, EMPTY_FILTERS);
    const body = await api("activities", "/api/v1/organizations/org-1/activities");

    expect(body.activities).toEqual(wire(page.rows));
    expect(body.pagination.total).toBe(page.total);
    const query = dbMock.query.activities.findMany.mock.calls as { columns: unknown }[][];
    expect(query[0][0].columns).toEqual(query[1][0].columns);
  });

  it("projects: the Projects page lists the same projects GET projects returns", async () => {
    dbMock.query.projects.findMany.mockResolvedValue([
      { id: "p1", name: "web", displayName: "Web", isSystemManaged: false, createdAt: at, apps: [], groupEnvironments: [] },
    ]);

    const page = await loadProjectsPage(ACTOR);
    const body = await api("projects", "/api/v1/organizations/org-1/projects");

    expect(body.projects.map((p: { id: string }) => p.id)).toEqual(page.projects.map((p) => p.id));
    for (const project of page.projects) {
      expect(body.projects.find((p: { id: string }) => p.id === project.id)).toMatchObject(wire(project));
    }
  });

  it("app detail: the page and GET app mask the same fields the same way", async () => {
    const compose = "services:\n  db:\n    environment:\n      PASSWORD: hunter2\n";
    const row = () => ({
      id: "a1",
      name: "api",
      projectId: null,
      parentAppId: null,
      composeContent: compose,
      envContent: "v1:ciphertext",
      gitUrl: "https://user:token@example.test/repo.git",
      gitCredentials: null,
      deployments: [],
      environments: [{ id: "e1", type: "production", name: "production" }],
      domains: [],
      envVars: [],
      childApps: [],
    });
    dbMock.query.apps.findFirst.mockImplementation(async () => row());

    const page = await loadAppDetail(ACTOR, "a1");
    const body = await api("apps/[appId]", "/api/v1/organizations/org-1/apps/a1", {
      params: Promise.resolve({ orgId: "org-1", appId: "a1" }),
    });

    for (const key of ["id", "name", "composeContent", "gitUrl"] as const) {
      expect(body.app[key]).toEqual(wire(page.app)[key]);
    }
    expect(body.app.envContent).toBeUndefined();
    expect(page.app).not.toHaveProperty("envContent");
  });
});
