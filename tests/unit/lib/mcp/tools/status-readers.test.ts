import { describe, it, expect, vi, beforeEach } from "vitest";
import { adminContext, captureTools, plainContext, selectChain, toolBody } from "@/tests/helpers/mcp-tools";

// vardo_list_attention, vardo_list_activity, vardo_security_summary and vardo_list_deployments stay inside the token's orgs and apps.

const h = vi.hoisted(() => ({
  instanceAdmin: vi.fn(async () => false),
  reachable: ["org-1"] as string[],
  accessibleOrgIds: vi.fn(),
  resolveAppOrg: vi.fn(),
  orgFilter: vi.fn(),
  attentionRows: vi.fn(),
  listActivities: vi.fn(),
  mcpActor: vi.fn(),
  guardHistory: vi.fn(),
  activeBans: vi.fn(),
  select: vi.fn(),
}));

vi.mock("@/lib/auth/system-org", () => ({ isInstanceAdminUser: h.instanceAdmin }));
vi.mock("@/lib/db", () => ({ db: { select: h.select } }));
vi.mock("@/lib/mcp/scope", async (orig) => ({
  ...(await orig<typeof import("@/lib/mcp/scope")>()),
  accessibleOrgIds: h.accessibleOrgIds,
  resolveAppOrg: h.resolveAppOrg,
  orgFilter: h.orgFilter,
  orgLabels: async (ids: string[]) => new Map(ids.map((id) => [id, { id, name: `Org ${id}`, slug: id }])),
}));
vi.mock("@/lib/attention/rows", () => ({ buildAttentionRows: h.attentionRows }));
vi.mock("@/lib/app-services/activity", () => ({ listActivities: h.listActivities }));
vi.mock("@/lib/app-services/mcp-actor", () => ({ mcpActor: h.mcpActor }));
vi.mock("@/lib/probe-guard/history", () => ({ guardHistory: h.guardHistory }));
vi.mock("@/lib/probe-guard/bans", () => ({ listActiveBans: h.activeBans }));

import { registerListAttention } from "@/lib/mcp/tools/list-attention";
import { registerListActivity } from "@/lib/mcp/tools/list-activity";
import { registerSecuritySummary } from "@/lib/mcp/tools/security-summary";
import { registerListDeployments } from "@/lib/mcp/tools/list-deployments";
import { FeatureDisabledError } from "@/lib/app-services/errors";

const T = new Date("2026-10-13T10:00:00Z");

const attentionTool = (c = plainContext) => captureTools(registerListAttention, c).get("vardo_list_attention")!;
const activityTool = (c = plainContext) => captureTools(registerListActivity, c).get("vardo_list_activity")!;
const securityTool = (c = plainContext) => captureTools(registerSecuritySummary, c).get("vardo_security_summary")!;
const deploymentsTool = (c = plainContext) => captureTools(registerListDeployments, c).get("vardo_list_deployments")!;

beforeEach(() => {
  vi.clearAllMocks();
  h.instanceAdmin.mockResolvedValue(false);
  h.reachable = ["org-1"];
  h.accessibleOrgIds.mockImplementation(async () => h.reachable);
  h.resolveAppOrg.mockResolvedValue("org-1");
  h.orgFilter.mockReturnValue(undefined);
  h.mcpActor.mockImplementation(async (_c: unknown, orgId: string) =>
    h.reachable.includes(orgId) ? { userId: "u1", org: { id: orgId, name: `Org ${orgId}`, slug: orgId }, membership: { role: "owner" }, instanceAdmin: false } : null,
  );
});

describe("vardo_list_attention", () => {
  const rows = [
    { key: "deploy-failed", label: "Deploy failed", tone: "error", group: "deploys", footer: "Check the log.", items: Array.from({ length: 14 }, (_, i) => ({ id: `a${i}`, name: `app-${i}`, href: "/secret/link", detail: "exit 1", urgent: true })) },
    { key: "image-updates", label: "Image updates", tone: "neutral", items: [{ id: "a1", name: "app-1" }] },
  ];

  it("returns error and warning rows with capped, link-free items", async () => {
    h.attentionRows.mockResolvedValue(rows);
    const body = toolBody(await attentionTool()({ includeInfo: false, limit: 20 }));
    expect(h.accessibleOrgIds).toHaveBeenCalledWith(plainContext, "org.view");
    expect(body.organizations).toHaveLength(1);
    const [row] = body.organizations[0].rows;
    expect(body.organizations[0].rows).toHaveLength(1);
    expect(row).toMatchObject({ key: "deploy-failed", tone: "error", itemCount: 14 });
    expect(row.items).toHaveLength(10);
    expect(row.items[0]).toEqual({ name: "app-0", where: null, detail: "exit 1", since: null, urgent: true });
  });

  it("includes informational rows on request", async () => {
    h.attentionRows.mockResolvedValue(rows);
    const body = toolBody(await attentionTool()({ includeInfo: true, limit: 20 }));
    expect(body.organizations[0].rows).toHaveLength(2);
  });

  it("passes the instance-admin flag only to a live admin on an admin-scoped token", async () => {
    h.attentionRows.mockResolvedValue([]);
    await attentionTool(adminContext)({ includeInfo: false, limit: 20 });
    expect(h.attentionRows).toHaveBeenLastCalledWith("org-1", { isAppAdmin: false });
    h.instanceAdmin.mockResolvedValue(true);
    await attentionTool(adminContext)({ includeInfo: false, limit: 20 });
    expect(h.attentionRows).toHaveBeenLastCalledWith("org-1", { isAppAdmin: true });
    await attentionTool(plainContext)({ includeInfo: false, limit: 20 });
    expect(h.attentionRows).toHaveBeenLastCalledWith("org-1", { isAppAdmin: false });
  });

  it("refuses an organization the token can't reach", async () => {
    const res = await attentionTool()({ organizationId: "org-2", includeInfo: false, limit: 20 });
    expect(res.isError).toBe(true);
    expect(h.attentionRows).not.toHaveBeenCalled();
  });
});

describe("vardo_list_activity", () => {
  it("lists each reachable org's feed without emails or metadata", async () => {
    h.listActivities.mockResolvedValue({
      total: 7,
      activities: [{ id: "x1", action: "app.deploy", family: "deploy", outcome: "success", metadata: { token: "s3cret" }, createdAt: T, user: { id: "u", name: "Ada", email: "ada@example.com", image: null }, app: { id: "a1", name: "web", displayName: "Web" } }],
    });
    const res = await activityTool()({ appId: "a1", limit: 5 });
    expect(h.listActivities).toHaveBeenCalledWith(expect.objectContaining({ org: expect.objectContaining({ id: "org-1" }) }), expect.objectContaining({ appId: "a1", limit: 5 }));
    expect(res.content[0].text).not.toContain("s3cret");
    expect(res.content[0].text).not.toContain("ada@example.com");
    expect(toolBody(res).organizations[0]).toMatchObject({ total: 7, activities: [{ action: "app.deploy", user: "Ada", app: { id: "a1", name: "Web" }, at: T.toISOString() }] });
  });

  it("refuses an organization the token can't reach", async () => {
    const res = await activityTool()({ organizationId: "org-2", limit: 20 });
    expect(res.isError).toBe(true);
    expect(h.listActivities).not.toHaveBeenCalled();
  });

  it("reports a disabled feed as a refusal", async () => {
    h.listActivities.mockRejectedValue(new FeatureDisabledError("activity"));
    const res = await activityTool()({ limit: 20 });
    expect(res.isError).toBe(true);
  });
});

describe("vardo_security_summary", () => {
  const history = {
    label: "Last 7 days",
    since: T,
    stats: { probes: 40, bans: 3, traps: 1, permanent: 0 },
    bans: [
      { ip: "203.0.113.9", reason: "threshold", hits: 12, status: { kind: "active", label: "Active" }, appId: "a1", createdAt: T, expiresAt: T, blockedCount: 4, detail: { categories: [{ label: "WordPress login", count: 9 }, { label: ".env files", count: 3 }], paths: [], trapPath: null } },
    ],
    categories: [{ label: "WordPress login", count: 9 }],
    sources: [{ ip: "203.0.113.9", count: 12, banned: true }],
    note: null,
  };

  beforeEach(() => {
    h.guardHistory.mockResolvedValue(history);
    h.activeBans.mockResolvedValue([{ id: "b1" }, { id: "b2" }]);
  });

  it("refuses instance-wide data without the admin scope", async () => {
    const res = await securityTool()({ range: "7d", limit: 20 });
    expect(res.isError).toBe(true);
    expect(h.guardHistory).not.toHaveBeenCalled();
  });

  it("refuses instance-wide data once the user is no longer an instance admin", async () => {
    const res = await securityTool(adminContext)({ range: "7d", limit: 20 });
    expect(res.isError).toBe(true);
    expect(h.guardHistory).not.toHaveBeenCalled();
  });

  it("refuses an app the token can't reach", async () => {
    h.resolveAppOrg.mockResolvedValue(null);
    const res = await securityTool()({ appId: "other", range: "7d", limit: 20 });
    expect(res.isError).toBe(true);
    expect(h.guardHistory).not.toHaveBeenCalled();
    expect(h.activeBans).not.toHaveBeenCalled();
  });

  it("summarizes one app for a member", async () => {
    const res = await securityTool()({ appId: "a1", range: "7d", limit: 20 });
    expect(h.resolveAppOrg).toHaveBeenCalledWith(plainContext, "a1", "app.view");
    expect(h.guardHistory).toHaveBeenCalledWith({ range: "7d", appId: "a1" });
    expect(toolBody(res)).toMatchObject({
      stats: { probes: 40, bans: 3 },
      activeBans: { count: 2, capped: false },
      recentBans: [{ ip: "203.0.113.9", status: "active", probed: ["WordPress login", ".env files"] }],
      probed: [{ label: "WordPress login", count: 9 }],
    });
  });

  it("summarizes the instance for a live admin", async () => {
    h.instanceAdmin.mockResolvedValue(true);
    const res = await securityTool(adminContext)({ range: "30d", limit: 20 });
    expect(res.isError).toBeUndefined();
    expect(h.guardHistory).toHaveBeenCalledWith({ range: "30d", appId: undefined });
  });
});

describe("vardo_list_deployments", () => {
  const row = (id: string, status: string) => ({ id, status, trigger: "manual", gitSha: "abc", gitMessage: "fix: token=abcdefghijklmnop1234567890", durationMs: 10, postDeployError: null, rollbackFromId: null, startedAt: T, finishedAt: null, appId: "a1", appName: "Web", organizationId: "org-1" });

  it("scopes the query to the token's apps and lists active deployments first", async () => {
    const limits: number[] = [];
    h.select.mockReturnValueOnce(selectChain([row("d-run", "running")], { limit: limits })).mockReturnValueOnce(selectChain([row("d-ok", "success")], { limit: limits }));
    const body = toolBody(await deploymentsTool()({ limit: 5 }));
    expect(h.accessibleOrgIds).toHaveBeenCalledWith(plainContext, "app.view");
    expect(h.orgFilter).toHaveBeenCalledWith(expect.anything(), ["org-1"]);
    expect(limits).toEqual([5, 4]);
    expect(body.deployments.map((d: { id: string }) => d.id)).toEqual(["d-run", "d-ok"]);
  });

  it("passes an empty org list through when the token reaches no org", async () => {
    h.reachable = [];
    h.select.mockReturnValue(selectChain([]));
    const body = toolBody(await deploymentsTool()({ limit: 20 }));
    expect(h.orgFilter).toHaveBeenCalledWith(expect.anything(), []);
    expect(body.deployments).toEqual([]);
  });

  it("filters by status in one query and clamps the limit", async () => {
    const limits: number[] = [];
    h.select.mockReturnValue(selectChain([row("d-bad", "failed")], { limit: limits }));
    const body = toolBody(await deploymentsTool()({ status: "failed", limit: 500 }));
    expect(limits).toEqual([100]);
    expect(h.select).toHaveBeenCalledTimes(1);
    expect(body.count).toBe(1);
  });
});
