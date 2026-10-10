import { describe, it, expect, vi } from "vitest";
import { checkGitHubPermissions, type PermissionCheckDeps } from "@/lib/git-integration/permission-check";

const FULL = { metadata: "read", contents: "read", pull_requests: "write", deployments: "write", statuses: "write" };
const OLD = { metadata: "read", contents: "read", pull_requests: "write" };

type Routes = Record<string, { status?: number; body?: unknown }>;

function fakeFetch(routes: Routes) {
  return vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const path = String(url).replace("https://api.github.com", "");
    expect((init?.headers as Record<string, string>).Authorization).toBe("Bearer app-jwt");
    const hit = routes[path];
    if (!hit) return new Response("not found", { status: 404 });
    return new Response(JSON.stringify(hit.body ?? {}), { status: hit.status ?? 200 });
  });
}

function deps(routes: Routes, installations = [{ installationId: 42, organizationIds: ["org-1"] }]): PermissionCheckDeps {
  return {
    appToken: async () => "app-jwt",
    installations: async () => installations,
    adminOrgIds: async () => ["org-admin"],
    fetch: fakeFetch(routes) as unknown as typeof fetch,
  };
}

describe("checkGitHubPermissions", () => {
  it("raises an App-level issue to admin orgs when the App lacks permissions", async () => {
    const raised = await checkGitHubPermissions(deps({
      "/app": { body: { slug: "acme-vardo", owner: { login: "acme", type: "Organization" }, permissions: OLD } },
      "/app/installations/42": { body: { id: 42, account: { login: "acme", type: "Organization" }, permissions: OLD } },
    }));
    expect(raised).toHaveLength(1);
    expect(raised[0].organizationIds).toEqual(["org-admin"]);
    expect(raised[0].issue.key).toBe("github:app");
    expect(raised[0].issue.fixUrl).toBe("https://github.com/organizations/acme/settings/apps/acme-vardo/permissions");
  });

  it("raises an installation issue to linked orgs when approval is pending", async () => {
    const raised = await checkGitHubPermissions(deps({
      "/app": { body: { slug: "acme-vardo", owner: { login: "jdoe", type: "User" }, permissions: FULL } },
      "/app/installations/42": { body: { id: 42, account: { login: "jdoe", type: "User" }, permissions: OLD } },
    }));
    expect(raised).toHaveLength(1);
    expect(raised[0].organizationIds).toEqual(["org-1"]);
    expect(raised[0].issue.fixUrl).toBe("https://github.com/settings/installations/42");
    expect(raised[0].issue.missing.map((m) => m.id)).toEqual(["deployments", "statuses"]);
  });

  it("reports nothing when everything is granted", async () => {
    const raised = await checkGitHubPermissions(deps({
      "/app": { body: { slug: "acme-vardo", owner: { login: "acme", type: "Organization" }, permissions: FULL } },
      "/app/installations/42": { body: { id: 42, account: { login: "acme", type: "Organization" }, permissions: FULL } },
    }));
    expect(raised).toEqual([]);
  });

  it("skips removed, suspended and unlinked installations", async () => {
    const raised = await checkGitHubPermissions(deps(
      {
        "/app": { body: { slug: "acme-vardo", owner: { login: "acme", type: "Organization" }, permissions: FULL } },
        "/app/installations/7": { body: { id: 7, account: { login: "acme", type: "Organization" }, permissions: OLD, suspended_at: "2026-01-01T00:00:00Z" } },
        "/app/installations/8": { body: { id: 8, account: { login: "acme", type: "Organization" }, permissions: OLD } },
      },
      [
        { installationId: 6, organizationIds: ["org-1"] },
        { installationId: 7, organizationIds: ["org-1"] },
        { installationId: 8, organizationIds: [] },
      ],
    ));
    expect(raised).toEqual([]);
  });

  it("throws when GitHub can't be read, so nothing clears", async () => {
    await expect(checkGitHubPermissions(deps({
      "/app": { status: 500 },
    }))).rejects.toThrow(/500/);
  });
});
