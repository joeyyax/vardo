// An org sees only installations linked to it, even when a member linked others elsewhere (#788).

import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { describe, it, expect, vi, beforeEach } from "vitest";

const { links, userRows, inserted } = vi.hoisted(() => ({
  links: [] as { organizationId: string; installationId: number }[],
  userRows: [] as { userId: string; installationId: number; accountLogin: string }[],
  inserted: [] as unknown[],
}));

const dialect = new PgDialect();
const paramsOf = (where: SQL) => dialect.sqlToQuery(where).params;

vi.mock("@/lib/db", () => ({
  db: {
    query: {
      githubInstallationOrgs: {
        findMany: async ({ where }: { where: SQL }) => {
          const p = paramsOf(where);
          return links.filter((l) => p.includes(l.organizationId) || p.includes(l.installationId));
        },
      },
      githubAppInstallations: {
        findMany: async ({ where }: { where: SQL }) => {
          const p = paramsOf(where);
          return userRows.filter((r) => p.includes(r.installationId));
        },
      },
    },
    insert: () => ({ values: (v: unknown) => ({ onConflictDoNothing: async () => { inserted.push(v); } }) }),
  },
}));

import { orgInstallations, orgsForInstallation, linkToCurrentOrgIfAdmin } from "@/lib/git-integration/org-installations";

beforeEach(() => {
  links.length = 0;
  userRows.length = 0;
  inserted.length = 0;
  // One user in two orgs, with a different installation linked to each.
  userRows.push(
    { userId: "u1", installationId: 1, accountLogin: "ops-gh" },
    { userId: "u1", installationId: 2, accountLogin: "vardo-gh" },
  );
  links.push({ organizationId: "org-ops", installationId: 1 }, { organizationId: "org-vardo", installationId: 2 });
});

describe("orgInstallations", () => {
  it("returns only the org's own installations", async () => {
    expect(await orgInstallations("org-ops")).toEqual([{ installationId: 1, accountLogin: "ops-gh" }]);
    expect(await orgInstallations("org-vardo")).toEqual([{ installationId: 2, accountLogin: "vardo-gh" }]);
  });

  it("returns nothing for an org with no links", async () => {
    expect(await orgInstallations("org-other")).toEqual([]);
  });
});

describe("orgsForInstallation", () => {
  it("lists the orgs an installation is linked to", async () => {
    expect(await orgsForInstallation(2)).toEqual(["org-vardo"]);
  });
});

describe("linkToCurrentOrgIfAdmin", () => {
  it("links for an owner or admin", async () => {
    const current = { organization: { id: "org-vardo" }, membership: { role: "admin" } };
    expect(await linkToCurrentOrgIfAdmin(current, 3, "u1")).toBe(true);
    expect(inserted).toEqual([expect.objectContaining({ organizationId: "org-vardo", installationId: 3, linkedByUserId: "u1" })]);
  });

  it("doesn't link for a plain member", async () => {
    const current = { organization: { id: "org-vardo" }, membership: { role: "member" } };
    expect(await linkToCurrentOrgIfAdmin(current, 3, "u1")).toBe(false);
    expect(inserted).toEqual([]);
  });
});
