import { describe, it, expect } from "vitest";
import { integrationRows } from "@/lib/attention/integration-rows";
import { summarize } from "@/lib/ui/attention";
import type { IntegrationIssue } from "@/lib/integrations/issues";

const base: Omit<IntegrationIssue, "key" | "scope" | "fixUrl"> = {
  provider: "github",
  missing: [{ id: "deployments", label: "Deployments", access: "write" }],
  features: ["Deployments on GitHub"],
  purposes: ["show deploy progress on pull requests"],
};

const install: IntegrationIssue = {
  ...base,
  key: "github:installation:42",
  scope: { kind: "installation", id: "42", account: "acme" },
  fixUrl: "https://github.com/organizations/acme/settings/installations/42/permissions/update",
};

const app: IntegrationIssue = {
  ...base,
  key: "github:app",
  scope: { kind: "app", name: "acme-vardo" },
  fixUrl: "https://github.com/organizations/acme/settings/apps/acme-vardo/permissions",
};

const since = "2026-10-01T00:00:00.000Z";

describe("integrationRows", () => {
  it("is one routine item per problem with the GitHub link and a recheck", () => {
    const rows = integrationRows([{ issue: install, since }], { orgId: "org-1", isAppAdmin: false });
    expect(rows).toHaveLength(1);
    const [item] = rows[0].items;
    expect(item.fix).toEqual({ label: "Review and accept", href: install.fixUrl, external: true });
    expect(item.secondary).toEqual({ label: "Check again", post: "/api/v1/organizations/org-1/integrations/check" });
    expect(item.urgent).toBe(false);

    const summary = summarize(rows);
    expect(summary.urgent).toEqual([]);
    expect(summary.routineFaults).toBe(1);
  });

  it("shows App-level gaps to instance admins only", () => {
    const issues = [{ issue: app, since }, { issue: install, since }];
    expect(integrationRows(issues, { orgId: "org-1", isAppAdmin: false })[0].items).toHaveLength(1);
    expect(integrationRows(issues, { orgId: "org-1", isAppAdmin: true })[0].items).toHaveLength(2);
    expect(integrationRows([{ issue: app, since }], { orgId: "org-1", isAppAdmin: false })).toEqual([]);
  });
});

describe("integrationRows review link", () => {
  it("adds a quiet link to every permission when the issue has a review page", async () => {
    const { integrationRows } = await import("@/lib/attention/integration-rows");
    const rows = integrationRows(
      [
        {
          issue: {
            key: "github:installation:7",
            provider: "github",
            scope: { kind: "installation", id: "7", account: "acme" },
            missing: [{ id: "statuses", label: "Commit statuses", access: "write" }],
            fixUrl: "https://github.com/settings/installations/7/permissions/update",
            reviewUrl: "https://github.com/settings/installations/7",
            features: ["Commit status checks"],
            purposes: ["show deploy progress on pull requests"],
          },
          since: "2026-01-01T00:00:00Z",
        },
      ],
      { orgId: "org1", isAppAdmin: true },
    );
    expect(rows[0].items[0].aside).toEqual({
      label: "Review all App permissions",
      href: "https://github.com/settings/installations/7",
    });
  });
});
