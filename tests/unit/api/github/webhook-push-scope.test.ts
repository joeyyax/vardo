// A push only deploys apps in orgs the delivering installation is linked to (#788).

import { NextRequest } from "next/server";
import { createHmac } from "crypto";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { describe, it, expect, vi, beforeEach } from "vitest";

const SECRET = "whsec";

const { requestDeploy, links, appRows } = vi.hoisted(() => ({
  requestDeploy: vi.fn(),
  links: new Map<number, string[]>(),
  appRows: [] as { id: string; name: string; displayName: string; organizationId: string; gitUrl: string; gitBranch: string; autoDeploy: boolean; isSystemManaged: boolean }[],
}));

const dialect = new PgDialect();

vi.mock("@/lib/api/rate-limit", () => ({ rateLimit: async () => null }));
vi.mock("@/lib/api/require-plugin", () => ({ requirePlugin: async () => null }));
vi.mock("@/lib/system-settings", () => ({ getGitHubAppConfig: async () => ({ webhookSecret: SECRET }) }));
vi.mock("@/lib/docker/deploy-cancel", () => ({ requestDeploy }));
vi.mock("@/lib/docker/preview", () => ({ createPreview: vi.fn(), destroyPreview: vi.fn() }));
vi.mock("@/lib/docker/self-preview", () => ({
  getSystemManagedApp: vi.fn(),
  createVardoPreview: vi.fn(),
  destroyVardoPreview: vi.fn(),
}));
vi.mock("@/lib/config/features", () => ({ isFeatureEnabled: () => false, isFeatureEnabledAsync: async () => false }));
vi.mock("@/lib/git-integration/org-installations", () => ({
  orgsForInstallation: async (id: number) => links.get(id) ?? [],
}));
vi.mock("@/lib/db", () => ({
  db: {
    query: {
      apps: {
        // Applies the where clause's bound git URL and org ids; no org ids means every org.
        findMany: async ({ where }: { where: SQL }) => {
          const { params } = dialect.sqlToQuery(where);
          const orgIds = params.filter((p) => appRows.some((a) => a.organizationId === p));
          return appRows.filter(
            (a) => params.includes(a.gitUrl) && a.autoDeploy && (orgIds.length === 0 || orgIds.includes(a.organizationId)),
          );
        },
      },
    },
  },
}));

const { POST } = await import("@/app/api/v1/github/webhook/route");

function push(installationId: number | undefined) {
  const body = JSON.stringify({
    ref: "refs/heads/main",
    after: "abc1234",
    repository: { full_name: "acme/site" },
    pusher: { name: "dev" },
    ...(installationId !== undefined ? { installation: { id: installationId } } : {}),
  });
  const signature = "sha256=" + createHmac("sha256", SECRET).update(body).digest("hex");
  return POST(
    new NextRequest("http://localhost/api/v1/github/webhook", {
      method: "POST",
      body,
      headers: { "x-github-event": "push", "x-hub-signature-256": signature },
    }),
  );
}

const app = (id: string, organizationId: string) => ({
  id,
  name: id,
  displayName: id,
  organizationId,
  gitUrl: "https://github.com/acme/site.git",
  gitBranch: "main",
  autoDeploy: true,
  isSystemManaged: false,
});

beforeEach(() => {
  requestDeploy.mockReset();
  requestDeploy.mockResolvedValue({ deploymentId: "d1", success: true });
  links.clear();
  appRows.length = 0;
  appRows.push(app("ops-site", "org-ops"), app("vardo-site", "org-vardo"));
});

describe("push webhook scope", () => {
  it("deploys only the app in the org the installation is linked to", async () => {
    links.set(2, ["org-vardo"]);

    const res = await push(2);

    expect(res.status).toBe(200);
    expect(requestDeploy).toHaveBeenCalledTimes(1);
    expect(requestDeploy).toHaveBeenCalledWith(expect.objectContaining({ appId: "vardo-site", organizationId: "org-vardo" }));
  });

  it("deploys nothing for an installation no org has linked", async () => {
    const res = await push(99);

    expect((await res.json()).skipped).toBe("installation not linked");
    expect(requestDeploy).not.toHaveBeenCalled();
  });

  it("deploys nothing without an installation in the payload", async () => {
    links.set(2, ["org-vardo"]);

    const res = await push(undefined);

    expect((await res.json()).skipped).toBe("no installation");
    expect(requestDeploy).not.toHaveBeenCalled();
  });
});
