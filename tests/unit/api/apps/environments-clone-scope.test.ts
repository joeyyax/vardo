import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

// ---------------------------------------------------------------------------
// POST /api/v1/organizations/[orgId]/apps/[appId]/environments
// ---------------------------------------------------------------------------
// cloneFrom is caller-supplied. The source-environment lookup must be scoped to
// the app in the path, so an ID belonging to another app resolves to nothing.

type Predicate =
  | { op: "eq"; col: string; val: unknown }
  | { op: "and"; parts: Predicate[] }
  | { op: "sql" };

function matches(row: Record<string, unknown>, pred: Predicate | undefined): boolean {
  if (!pred) return true;
  if (pred.op === "and") return pred.parts.every((p) => matches(row, p));
  if (pred.op === "eq") return row[pred.col] === pred.val;
  return true;
}

vi.mock("drizzle-orm", () => {
  const sql = Object.assign(() => ({ op: "sql" }), { raw: () => ({ op: "sql" }) });
  return {
    eq: (col: string, val: unknown) => ({ op: "eq", col, val }),
    and: (...parts: Predicate[]) => ({ op: "and", parts }),
    sql,
  };
});

vi.mock("@/lib/db/schema", () => ({
  environments: { id: "id", appId: "appId", type: "type" },
  envVars: { appId: "appId", environmentId: "environmentId" },
  apps: { id: "id" },
  groupEnvironments: { projectId: "projectId" },
}));

const { mockEnvFindFirst, mockEnvVarsFindMany, mockInsertValues } = vi.hoisted(() => ({
  mockEnvFindFirst: vi.fn(),
  mockEnvVarsFindMany: vi.fn(),
  mockInsertValues: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  db: {
    query: {
      apps: { findFirst: vi.fn().mockResolvedValue({ projectId: null }) },
      environments: { findFirst: mockEnvFindFirst },
      envVars: { findMany: mockEnvVarsFindMany },
    },
    select: () => ({ from: () => ({ where: () => Promise.resolve([{ count: 1 }]) }) }),
    insert: () => ({
      values: (v: unknown) => {
        mockInsertValues(v);
        return {
          returning: () => Promise.resolve([{ id: "env-new" }]),
          then: (resolve: (value: unknown) => unknown) => resolve(undefined),
        };
      },
    }),
  },
}));

vi.mock("@/lib/api/verify-access", () => ({
  verifyAppAccess: vi.fn().mockResolvedValue({ id: "app-1" }),
  verifyOrgAccess: vi.fn().mockResolvedValue({ session: { user: { id: "user-1" } } }),
}));

vi.mock("@/lib/api/require-plugin", () => ({
  requirePlugin: vi.fn().mockResolvedValue(null),
}));

vi.mock("@/lib/api/with-rate-limit", () => ({
  withRateLimit: (handler: (...args: never[]) => unknown) => handler,
}));

vi.mock("@/lib/docker/clone", () => ({ createGroupEnvironment: vi.fn() }));

vi.mock("@/lib/api/error-response", () => ({
  handleRouteError: (error: unknown) => {
    throw error;
  },
  isUniqueViolation: () => false,
}));

import { POST } from "@/app/api/v1/organizations/[orgId]/apps/[appId]/environments/route";

// Two production environments: one on the app in the path, one on another app.
const ENV_ROWS = [
  { id: "env-mine", appId: "app-1", type: "production" },
  { id: "env-foreign", appId: "app-2", type: "production" },
];

function postEnvironment(cloneFrom: string) {
  const request = new NextRequest("http://localhost/api/v1/organizations/org-1/apps/app-1/environments", {
    method: "POST",
    body: JSON.stringify({ name: "staging", type: "staging", cloneFrom }),
  });
  return POST(request, { params: Promise.resolve({ orgId: "org-1", appId: "app-1" }) });
}

describe("POST /environments — cloneFrom source lookup", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockEnvVarsFindMany.mockResolvedValue([]);
    mockEnvFindFirst.mockImplementation(({ where }: { where?: Predicate }) =>
      Promise.resolve(ENV_ROWS.find((row) => matches(row, where)))
    );
  });

  it("scopes the lookup to the app in the path", async () => {
    await postEnvironment("env-mine");

    const { where } = mockEnvFindFirst.mock.calls[0][0];
    expect(where).toEqual({
      op: "and",
      parts: [
        { op: "eq", col: "id", val: "env-mine" },
        { op: "eq", col: "appId", val: "app-1" },
      ],
    });
  });

  it("resolves a production environment belonging to the app", async () => {
    await postEnvironment("env-mine");
    await expect(mockEnvFindFirst.mock.results[0].value).resolves.toMatchObject({ type: "production" });
  });

  it("resolves nothing for an environment belonging to another app", async () => {
    await postEnvironment("env-foreign");
    await expect(mockEnvFindFirst.mock.results[0].value).resolves.toBeUndefined();
  });

  it("does not copy base vars when cloneFrom names another app's production environment", async () => {
    mockEnvVarsFindMany.mockResolvedValue([{ key: "SECRET", value: "x", isSecret: true }]);
    await postEnvironment("env-foreign");

    // The production branch pulls in base vars via a second envVars query.
    expect(mockEnvVarsFindMany).toHaveBeenCalledTimes(1);
  });
});
