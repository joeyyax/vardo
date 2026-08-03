import { describe, it, expect, beforeEach, vi } from "vitest";

const { appsFindFirstMock, getCurrentOrgMock, notFoundMock, redirectMock } = vi.hoisted(() => ({
  appsFindFirstMock: vi.fn(),
  getCurrentOrgMock: vi.fn(),
  notFoundMock: vi.fn(() => {
    throw new Error("NEXT_NOT_FOUND");
  }),
  redirectMock: vi.fn(() => {
    throw new Error("NEXT_REDIRECT");
  }),
}));

vi.mock("next/navigation", () => ({ notFound: notFoundMock, redirect: redirectMock }));
vi.mock("@/lib/auth/session", () => ({ getCurrentOrg: getCurrentOrgMock }));
vi.mock("@/lib/db", () => ({
  db: {
    query: {
      apps: { findFirst: appsFindFirstMock, findMany: vi.fn().mockResolvedValue([]) },
      tags: { findMany: vi.fn().mockResolvedValue([]) },
      orgEnvVars: { findMany: vi.fn().mockResolvedValue([]) },
    },
  },
}));
vi.mock("@/app/(authenticated)/apps/[...slug]/app-detail", () => ({ AppDetail: () => null }));

import AppDetailPage from "@/app/(authenticated)/apps/[...slug]/page";

const ORG_ID = "org-1";

/** Column names and bound values in a Drizzle where clause, in query order. */
function predicate(where: unknown): { columns: string[]; values: unknown[] } {
  const columns: string[] = [];
  const values: unknown[] = [];
  const walk = (node: unknown) => {
    if (Array.isArray(node)) return node.forEach(walk);
    if (!node || typeof node !== "object") return;
    const obj = node as Record<string, unknown>;
    if (typeof obj.name === "string" && obj.table) columns.push(obj.name);
    if ("encoder" in obj) values.push(obj.value);
    if (Array.isArray(obj.queryChunks)) walk(obj.queryChunks);
  };
  walk((where as { queryChunks?: unknown[] })?.queryChunks ?? []);
  return { columns, values };
}

/** The where clause the page used to resolve the slug. */
async function resolveSlug(slug: string[]) {
  await expect(
    AppDetailPage({ params: Promise.resolve({ slug }) }),
  ).rejects.toThrow("NEXT_NOT_FOUND");
  return predicate(appsFindFirstMock.mock.calls[0][0].where);
}

beforeEach(() => {
  vi.clearAllMocks();
  getCurrentOrgMock.mockResolvedValue({ organization: { id: ORG_ID } });
  appsFindFirstMock.mockResolvedValue(undefined);
});

describe("app slug resolution", () => {
  it("scopes the lookup to the session organization", async () => {
    const { columns, values } = await resolveSlug(["api"]);

    expect(columns).toContain("organization_id");
    expect(values).toContain(ORG_ID);
  });

  it("matches the slug against both name and id", async () => {
    const { columns, values } = await resolveSlug(["api"]);

    expect(columns).toEqual(["organization_id", "name", "id"]);
    expect(values).toEqual([ORG_ID, "api", "api"]);
  });

  it("404s on a name that belongs to another organization", async () => {
    await resolveSlug(["other-orgs-app"]);

    expect(notFoundMock).toHaveBeenCalled();
  });
});
