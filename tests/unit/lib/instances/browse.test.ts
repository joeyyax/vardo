// Browse answers only with the mapped user's own memberships, and only with names, statuses, domains and deploy times.

import { describe, it, expect, vi } from "vitest";

vi.mock("@/lib/db", () => ({ db: {} }));
vi.mock("@/lib/system-settings", () => ({ getInstanceDisplayName: async () => "edge" }));

const { browse, BrowseError, toRemoteApp } = await import("@/lib/instances/browse");
const { projectsResponseSchema } = await import("@/lib/instances/directory");
type BrowseStore = import("@/lib/instances/browse").BrowseStore;
type AppRow = import("@/lib/instances/browse").AppRow;

const PEER = { name: "hub", acceptInstanceBrowse: true, organizationId: null as string | null };

function app(over: Partial<AppRow> = {}): AppRow {
  return {
    id: "a1",
    name: "web",
    displayName: "Web",
    status: "active",
    parked: false,
    domains: [{ domain: "web.example.com" }],
    deployments: [{ status: "success", startedAt: new Date("2026-01-01T00:00:00Z"), finishedAt: new Date("2026-01-01T00:01:00Z") }],
    ...over,
  };
}

function store(over: Partial<BrowseStore> = {}): BrowseStore & { projectsIn: ReturnType<typeof vi.fn> } {
  return {
    verifiedUserId: async (email) => (email.toLowerCase() === "owner@example.com" ? "u1" : null),
    memberships: async () => [
      { role: "member", organization: { id: "org-a", name: "Alpha", isSystemManaged: false } },
      { role: "owner", organization: { id: "org-b", name: "Beta", isSystemManaged: false } },
      { role: "owner", organization: { id: "org-sys", name: "System", isSystemManaged: true } },
    ],
    projectsIn: vi.fn(async (orgId: string) => [{ id: `p-${orgId}`, name: "site", displayName: "Site", apps: [app()] }]),
    ...over,
  } as BrowseStore & { projectsIn: ReturnType<typeof vi.fn> };
}

async function refusal(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (err) {
    if (err instanceof BrowseError) return { status: err.status, message: err.message };
    throw err;
  }
  throw new Error("expected a refusal");
}

describe("browse scoping", () => {
  it("lists only the user's own non-system orgs, with their role", async () => {
    const res = await browse(PEER, { kind: "organizations", email: "Owner@example.com" }, store());
    expect(res).toEqual({
      organizations: [
        { id: "org-a", name: "Alpha", role: "member" },
        { id: "org-b", name: "Beta", role: "owner" },
      ],
    });
  });

  it("narrows to the org a bound peer is tied to", async () => {
    const res = await browse({ ...PEER, organizationId: "org-b" }, { kind: "organizations", email: "owner@example.com" }, store());
    expect(res).toEqual({ organizations: [{ id: "org-b", name: "Beta", role: "owner" }] });
  });

  it("reads projects only from an org the user belongs to", async () => {
    const s = store();
    const res = await browse(PEER, { kind: "projects", email: "owner@example.com", organizationId: "org-a" }, s);
    expect(s.projectsIn).toHaveBeenCalledWith("org-a");
    expect(res).toEqual({ projects: [expect.objectContaining({ id: "p-org-a" })] });
  });

  it("refuses another org's projects without reading them", async () => {
    const s = store();
    const res = await refusal(browse(PEER, { kind: "projects", email: "owner@example.com", organizationId: "org-other" }, s));
    expect(res.status).toBe(404);
    expect(s.projectsIn).not.toHaveBeenCalled();
  });

  it("refuses a system org even when the user is a member", async () => {
    const s = store();
    expect((await refusal(browse(PEER, { kind: "projects", email: "owner@example.com", organizationId: "org-sys" }, s))).status).toBe(404);
    expect(s.projectsIn).not.toHaveBeenCalled();
  });

  it("refuses outside a bound peer's org", async () => {
    const s = store();
    const bound = { ...PEER, organizationId: "org-b" };
    expect((await refusal(browse(bound, { kind: "projects", email: "owner@example.com", organizationId: "org-a" }, s))).status).toBe(404);
  });

  it("refuses an unknown or unverified email", async () => {
    expect((await refusal(browse(PEER, { kind: "organizations", email: "nobody@example.com" }, store()))).status).toBe(403);
  });

  it("refuses when this link doesn't share projects", async () => {
    const res = await refusal(browse({ ...PEER, acceptInstanceBrowse: false }, { kind: "organizations", email: "owner@example.com" }, store()));
    expect(res.status).toBe(403);
    expect(res.message).toContain("doesn't share its projects with hub");
  });
});

describe("browse redaction", () => {
  const SECRETS = ["hunter2", "ghp_secrettoken", "BEGIN PRIVATE KEY", "DATABASE_URL", "deploy log line"];

  // A row carrying what a careless query might pull in.
  const leaky = {
    ...app({ status: "error" }),
    envVars: [{ key: "DATABASE_URL", value: "postgres://u:hunter2@db/app" }],
    gitCredentials: "ghp_secrettoken",
    composeContent: "secrets:\n  key: BEGIN PRIVATE KEY",
    deployments: [
      { status: "failed", startedAt: new Date("2026-01-02T00:00:00Z"), finishedAt: null, log: "deploy log line", envSnapshot: "hunter2" },
    ],
  } as unknown as AppRow;

  it("copies only the allowed fields of an app", () => {
    const out = toRemoteApp(leaky);
    expect(Object.keys(out).sort()).toEqual(["attention", "displayName", "domains", "id", "lastDeployedAt", "name", "status"]);
    expect(out.attention).toBe("Container failed");
    expect(out.lastDeployedAt).toBe("2026-01-02T00:00:00.000Z");
  });

  it("sends no secret values in a projects payload", async () => {
    const s = store({ projectsIn: vi.fn(async () => [{ id: "p1", name: "site", displayName: "Site", apps: [leaky], envVars: "hunter2" }]) as never });
    const json = JSON.stringify(await browse(PEER, { kind: "projects", email: "owner@example.com", organizationId: "org-a" }, s));
    for (const secret of SECRETS) expect(json).not.toContain(secret);
  });

  it("strips anything extra a peer sends before it reaches the UI", () => {
    const parsed = projectsResponseSchema.parse({
      projects: [{ id: "p1", name: "site", displayName: "Site", token: "ghp_secrettoken", apps: [{ ...toRemoteApp(app()), env: { A: "hunter2" } }] }],
    });
    const json = JSON.stringify(parsed);
    for (const secret of SECRETS) expect(json).not.toContain(secret);
  });

  it("flags a failed last deploy and leaves parked apps alone", () => {
    expect(toRemoteApp(app({ deployments: [{ status: "failed", startedAt: new Date(), finishedAt: null }] })).attention).toBe("Last deploy failed");
    expect(toRemoteApp(app({ status: "error", parked: true })).attention).toBeNull();
  });
});
