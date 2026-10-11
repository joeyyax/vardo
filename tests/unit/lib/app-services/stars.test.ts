import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { getTableConfig } from "drizzle-orm/pg-core";

const { mockActorForOrg } = vi.hoisted(() => ({ mockActorForOrg: vi.fn() }));

vi.mock("@/lib/db", async () => (await import("@/tests/helpers/db")).dbModule());
vi.mock("@/lib/app-services/session-actor", () => ({ actorForOrg: mockActorForOrg }));
vi.mock("@/lib/api/with-rate-limit", () => ({ withRateLimit: (h: unknown) => h }));

import { dbMock } from "@/tests/helpers/db";
import { userStars } from "@/lib/db/schema";
import type { Actor, Organization } from "@/lib/app-services/actor";
import { ForbiddenError, InvalidInputError, NotFoundError } from "@/lib/app-services/errors";
import { listStars, starTarget, unstarTarget } from "@/lib/app-services/stars";
import { DELETE, GET, PUT } from "@/app/api/v1/organizations/[orgId]/stars/route";

const ORG = { id: "org-1", name: "Ops", slug: "ops", isSystemManaged: false } as Organization;
const ACTOR: Actor = { userId: "user-1", org: ORG, membership: { role: "member" }, instanceAdmin: false };

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

const firstWhere = (fn: { mock: { calls: unknown[][] } }) => (fn.mock.calls[0][0] as { where: unknown }).where;

beforeEach(() => {
  vi.clearAllMocks();
  dbMock.reset();
  mockActorForOrg.mockResolvedValue(ACTOR);
});

describe("stars service", () => {
  it("lists only the actor's stars in the actor's org", async () => {
    dbMock.query.userStars.findMany.mockResolvedValue([
      { kind: "project", projectId: "p1", appId: null },
      { kind: "app", projectId: null, appId: "a1" },
    ]);
    expect(await listStars(ACTOR)).toEqual({ projects: ["p1"], apps: ["a1"] });
    expect(boundValues(firstWhere(dbMock.query.userStars.findMany))).toEqual(expect.arrayContaining(["user-1", "org-1"]));
  });

  it("can't star another org's project: the lookup is scoped to the actor's org and misses", async () => {
    dbMock.query.projects.findFirst.mockResolvedValue(undefined);
    await expect(starTarget(ACTOR, { kind: "project", targetId: "other-org-project" })).rejects.toBeInstanceOf(NotFoundError);
    expect(boundValues(firstWhere(dbMock.query.projects.findFirst))).toEqual(["other-org-project", "org-1"]);
    expect(dbMock.inserts).toHaveLength(0);
  });

  it("can't star another org's app", async () => {
    dbMock.query.apps.findFirst.mockResolvedValue(undefined);
    await expect(starTarget(ACTOR, { kind: "app", targetId: "other-org-app" })).rejects.toBeInstanceOf(NotFoundError);
    expect(boundValues(firstWhere(dbMock.query.apps.findFirst))).toEqual(["other-org-app", "org-1"]);
    expect(dbMock.inserts).toHaveLength(0);
  });

  it("stars a project in the actor's org for the actor only", async () => {
    dbMock.query.projects.findFirst.mockResolvedValue({ id: "p1" });
    await starTarget(ACTOR, { kind: "project", targetId: "p1" });
    expect(dbMock.inserts[0].values).toMatchObject({
      userId: "user-1",
      organizationId: "org-1",
      kind: "project",
      projectId: "p1",
      appId: null,
    });
  });

  it("unstars only the actor's own star in the actor's org", async () => {
    await unstarTarget(ACTOR, { kind: "app", targetId: "a1" });
    expect(boundValues(dbMock.deletes[0].where)).toEqual(["user-1", "org-1", "app", "a1"]);
  });

  it("refuses an unknown kind", async () => {
    await expect(starTarget(ACTOR, { kind: "volume", targetId: "v1" })).rejects.toBeInstanceOf(InvalidInputError);
  });

  it("needs org.view", async () => {
    const outsider = { ...ACTOR, membership: { role: "member", scopes: new Set<never>() } };
    await expect(listStars(outsider)).rejects.toBeInstanceOf(ForbiddenError);
  });
});

describe("stars route", () => {
  const params = { params: Promise.resolve({ orgId: "org-2" }) };
  const url = "http://localhost/api/v1/organizations/org-2/stars";

  it("refuses an org that isn't the caller's current one", async () => {
    mockActorForOrg.mockResolvedValue(null);
    expect((await GET(new NextRequest(url), params)).status).toBe(403);
    const put = new NextRequest(url, { method: "PUT", body: JSON.stringify({ kind: "project", targetId: "p1" }) });
    expect((await PUT(put, params)).status).toBe(403);
    expect((await DELETE(new NextRequest(`${url}?kind=project&targetId=p1`, { method: "DELETE" }), params)).status).toBe(403);
    expect(dbMock.inserts).toHaveLength(0);
    expect(dbMock.deletes).toHaveLength(0);
  });

  it("404s a target outside the org", async () => {
    dbMock.query.projects.findFirst.mockResolvedValue(undefined);
    const put = new NextRequest(url, { method: "PUT", body: JSON.stringify({ kind: "project", targetId: "p9" }) });
    expect((await PUT(put, params)).status).toBe(404);
  });

  it("stars and unstars", async () => {
    dbMock.query.apps.findFirst.mockResolvedValue({ id: "a1" });
    const put = new NextRequest(url, { method: "PUT", body: JSON.stringify({ kind: "app", targetId: "a1" }) });
    expect(await (await PUT(put, params)).json()).toEqual({ star: { kind: "app", targetId: "a1" }, starred: true });
    const del = await DELETE(new NextRequest(`${url}?kind=app&targetId=a1`, { method: "DELETE" }), params);
    expect(await del.json()).toEqual({ star: { kind: "app", targetId: "a1" }, starred: false });
  });
});

describe("star cleanup", () => {
  it("cascades when the user, org, project or app is deleted", () => {
    const { foreignKeys, checks } = getTableConfig(userStars);
    const refs = Object.fromEntries(
      foreignKeys.map((fk) => {
        const ref = fk.reference();
        return [ref.columns[0].name, { table: getTableConfig(ref.foreignTable).name, onDelete: fk.onDelete }];
      }),
    );
    expect(refs).toEqual({
      user_id: { table: "user", onDelete: "cascade" },
      organization_id: { table: "organization", onDelete: "cascade" },
      project_id: { table: "project", onDelete: "cascade" },
      app_id: { table: "app", onDelete: "cascade" },
    });
    expect(checks.map((c) => c.name)).toEqual(["user_star_one_target"]);
  });
});
