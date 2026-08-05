import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

// ---------------------------------------------------------------------------
// POST /api/v1/organizations/[orgId]/apps/[appId]/transfer
// ---------------------------------------------------------------------------
// destinationOrgId is caller-supplied and needs no membership — the destination
// accepts or rejects. Analysis that read the destination's app names turned that
// into an existence oracle: craft a ref, read which refs came back unresolved.

type Predicate =
  | { op: "eq"; col: string; val: unknown }
  | { op: "isNull"; col: string }
  | { op: "and"; parts: Predicate[] };

function matches(row: Record<string, unknown>, pred: Predicate | undefined): boolean {
  if (!pred) return true;
  if (pred.op === "and") return pred.parts.every((p) => matches(row, p));
  if (pred.op === "isNull") return row[pred.col] == null;
  return row[pred.col] === pred.val;
}

vi.mock("drizzle-orm", () => ({
  eq: (col: string, val: unknown) => ({ op: "eq", col, val }),
  and: (...parts: Predicate[]) => ({ op: "and", parts }),
  isNull: (col: string) => ({ op: "isNull", col }),
}));

vi.mock("@/lib/db/schema", () => ({
  apps: { id: "id", organizationId: "organizationId", name: "name" },
  appTransfers: {
    id: "id",
    appId: "appId",
    status: "status",
    destinationOrgId: "destinationOrgId",
  },
  memberships: { userId: "userId", organizationId: "organizationId" },
  envVars: { id: "id", appId: "appId", key: "key", environmentId: "environmentId" },
  organizations: { id: "id" },
  projects: { organizationId: "organizationId", name: "name", id: "id" },
}));

const {
  appsFindFirst,
  appsFindMany,
  envVarsFindMany,
  transfersFindFirst,
  organizationsFindFirst,
  membershipsFindFirst,
  insertValues,
} = vi.hoisted(() => ({
  appsFindFirst: vi.fn(),
  appsFindMany: vi.fn(),
  envVarsFindMany: vi.fn(),
  transfersFindFirst: vi.fn(),
  organizationsFindFirst: vi.fn(),
  membershipsFindFirst: vi.fn(),
  insertValues: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  db: {
    query: {
      apps: { findFirst: appsFindFirst, findMany: appsFindMany },
      appTransfers: { findFirst: transfersFindFirst },
      envVars: { findMany: envVarsFindMany },
      organizations: { findFirst: organizationsFindFirst },
      memberships: { findFirst: membershipsFindFirst },
    },
    insert: () => ({ values: insertValues }),
  },
}));

vi.mock("nanoid", () => ({ nanoid: () => "transfer-1" }));

vi.mock("@/lib/api/verify-access", () => ({
  verifyOrgAccess: vi.fn().mockResolvedValue({
    organization: { id: "org-source" },
    membership: { role: "owner" },
    session: { user: { id: "user-1" } },
  }),
}));

vi.mock("@/lib/api/with-rate-limit", () => ({
  withRateLimit: (handler: (...args: never[]) => unknown) => handler,
}));

vi.mock("@/lib/api/error-response", () => ({
  handleRouteError: (error: unknown) => {
    throw error;
  },
}));

vi.mock("@/lib/activity", () => ({ recordActivity: vi.fn() }));

import { POST } from "@/app/api/v1/organizations/[orgId]/apps/[appId]/transfer/route";
import { POST as respond } from "@/app/api/v1/organizations/[orgId]/transfers/[transferId]/route";

const SOURCE_ORG = "org-source";
const DEST_ORG = "org-destination";
const APP_ID = "app-1";

// The app's env var points at "secret-api", the name being probed for.
const ENV_VARS = [
  {
    id: "env-1",
    appId: APP_ID,
    key: "DB_URL",
    environmentId: null,
    value: "postgres://${secret-api.HOST}/db",
  },
];

function transferTo(destinationOrgId: string) {
  const request = new NextRequest(
    `http://localhost/api/v1/organizations/${SOURCE_ORG}/apps/${APP_ID}/transfer`,
    { method: "POST", body: JSON.stringify({ destinationOrgId }) },
  );
  return POST(request, {
    params: Promise.resolve({ orgId: SOURCE_ORG, appId: APP_ID }),
  });
}

/** Seed the destination org with the given app names and run the transfer. */
async function transferWithDestinationApps(names: string[]) {
  appsFindMany.mockImplementation(({ where }: { where?: Predicate }) =>
    Promise.resolve(
      names
        .map((name) => ({ name, organizationId: DEST_ORG }))
        .filter((row) => matches(row, where)),
    ),
  );

  const response = await transferTo(DEST_ORG);
  return { status: response.status, body: await response.json() };
}

describe("POST /apps/[appId]/transfer — destination org disclosure", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    appsFindFirst.mockResolvedValue({ id: APP_ID, name: "web" });
    envVarsFindMany.mockResolvedValue(ENV_VARS);
    transfersFindFirst.mockResolvedValue(undefined);
    organizationsFindFirst.mockResolvedValue({ id: DEST_ORG });
    insertValues.mockResolvedValue(undefined);
  });

  it("answers identically whether the referenced app exists in the destination", async () => {
    const present = await transferWithDestinationApps(["secret-api"]);
    const absent = await transferWithDestinationApps(["something-else"]);

    expect(present.status).toBe(201);
    expect(present).toEqual(absent);
  });

  it("does not read the destination org's apps", async () => {
    await transferWithDestinationApps(["secret-api"]);

    expect(appsFindMany).not.toHaveBeenCalled();
  });

  it("reports the app's own cross-project refs without resolving them", async () => {
    const { body } = await transferWithDestinationApps(["secret-api"]);

    expect(body.analysis.crossProjectRefs).toEqual([
      {
        key: "DB_URL",
        refApp: "secret-api",
        originalRef: "${secret-api.HOST}",
        currentValue: "postgres://${secret-api.HOST}/db",
      },
    ]);
  });

  it("stores no resolved refs on the pending transfer", async () => {
    await transferWithDestinationApps([]);

    expect(insertValues).toHaveBeenCalledWith(
      expect.objectContaining({ frozenRefs: [] }),
    );
  });

  it("rejects an unknown destination org before touching the app", async () => {
    organizationsFindFirst.mockResolvedValue(undefined);

    const response = await transferTo("org-missing");

    expect(response.status).toBe(404);
    expect(appsFindFirst).not.toHaveBeenCalled();
    expect(insertValues).not.toHaveBeenCalled();
  });
});

// A transfer addressed to another org used to answer 403 where an unknown id
// answered 404, which told the caller the id was real.
describe("POST /transfers/[transferId] — transfer id scope", () => {
  const TRANSFER_ROWS = [
    {
      id: "transfer-foreign",
      appId: APP_ID,
      status: "pending",
      destinationOrgId: "org-elsewhere",
    },
  ];

  beforeEach(() => {
    vi.clearAllMocks();
    membershipsFindFirst.mockResolvedValue({ role: "owner" });
    transfersFindFirst.mockImplementation(({ where }: { where?: Predicate }) =>
      Promise.resolve(TRANSFER_ROWS.find((row) => matches(row, where))),
    );
  });

  async function respondTo(transferId: string) {
    const request = new NextRequest(
      `http://localhost/api/v1/organizations/${SOURCE_ORG}/transfers/${transferId}`,
      { method: "POST", body: JSON.stringify({ action: "accept" }) },
    );
    const response = await respond(request, {
      params: Promise.resolve({ orgId: SOURCE_ORG, transferId }),
    });
    return { status: response.status, body: await response.json() };
  }

  it("answers identically for another org's transfer and an unknown id", async () => {
    const foreign = await respondTo("transfer-foreign");
    const unknown = await respondTo("transfer-missing");

    expect(foreign.status).toBe(404);
    expect(foreign).toEqual(unknown);
  });
});
