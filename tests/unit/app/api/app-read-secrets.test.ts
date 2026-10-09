// App reads never carry env ciphertext; compose env values need `env.reveal`.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { tokenScopeCapabilities } from "@/lib/auth/permissions";

const { mockVerifyOrgAccess, appsFindFirst, appsFindMany, mockUpdate } = vi.hoisted(() => ({
  mockVerifyOrgAccess: vi.fn(),
  appsFindFirst: vi.fn(),
  appsFindMany: vi.fn(),
  mockUpdate: vi.fn(),
}));

vi.mock("@/lib/api/verify-access", () => ({ verifyOrgAccess: mockVerifyOrgAccess }));
vi.mock("@/lib/api/with-rate-limit", async () => (await import("@/tests/helpers/mocks")).withRateLimitModule());
vi.mock("@/lib/db", () => ({
  db: {
    query: {
      apps: { findFirst: appsFindFirst, findMany: appsFindMany },
      projects: { findFirst: vi.fn() },
    },
    update: () => ({ set: (values: unknown) => ({ where: () => ({ returning: () => mockUpdate(values) }) }) }),
    select: () => ({ from: () => ({ where: () => Promise.resolve([{ count: 1 }]) }) }),
  },
}));
vi.mock("@/lib/activity", () => ({ recordActivity: vi.fn() }));

const appRoute = await import("@/app/api/v1/organizations/[orgId]/apps/[appId]/route");
const listRoute = await import("@/app/api/v1/organizations/[orgId]/apps/route");

const COMPOSE = "services:\n  db:\n    image: postgres\n    environment:\n      POSTGRES_PASSWORD: inline-secret-1\n      POSTGRES_USER: app\n";

function appRow() {
  return {
    id: "app-1",
    name: "api",
    organizationId: "org-1",
    projectId: null,
    isSystemManaged: false,
    composeContent: COMPOSE,
    envContent: "v1:ciphertext",
    deployments: [
      {
        id: "dep-1",
        envSnapshot: "v1:snapshot-ciphertext",
        configSnapshot: { cpuLimit: null, composeContent: COMPOSE },
      },
    ],
    domains: [],
    envVars: [],
  };
}

const appParams = { params: Promise.resolve({ orgId: "org-1", appId: "app-1" }) };
const orgParams = { params: Promise.resolve({ orgId: "org-1" }) };

function as(role: string) {
  mockVerifyOrgAccess.mockResolvedValue({
    organization: { id: "org-1" },
    membership: { role },
    session: { user: { id: "user-1" } },
  });
}

async function getApp() {
  const res = await appRoute.GET(new NextRequest("http://localhost/api/v1/organizations/org-1/apps/app-1"), appParams);
  expect(res.status).toBe(200);
  return (await res.json()).app;
}

beforeEach(() => {
  vi.clearAllMocks();
  appsFindFirst.mockResolvedValue(appRow());
  appsFindMany.mockResolvedValue([appRow()]);
});

describe("GET app", () => {
  it("masks compose env and drops ciphertext for a member", async () => {
    as("member");
    const app = await getApp();
    const body = JSON.stringify(app);
    expect(body).not.toContain("inline-secret-1");
    expect(body).not.toContain("ciphertext");
    expect(app.envContent).toBeUndefined();
    expect(app.deployments[0].envSnapshot).toBeUndefined();
    expect(app.composeContent).toContain("POSTGRES_PASSWORD");
  });

  it("masks compose env for a read-only viewer", async () => {
    as("viewer");
    expect(JSON.stringify(await getApp())).not.toContain("inline-secret-1");
  });

  it("returns compose as saved for an admin, still without ciphertext", async () => {
    as("admin");
    const app = await getApp();
    expect(app.composeContent).toBe(COMPOSE);
    expect(app.deployments[0].configSnapshot.composeContent).toBe(COMPOSE);
    expect(JSON.stringify(app)).not.toContain("ciphertext");
  });

  it("masks compose for a read-scoped token on an admin account", async () => {
    mockVerifyOrgAccess.mockResolvedValue({
      organization: { id: "org-1" },
      membership: { role: "admin", scopes: tokenScopeCapabilities("read", null) },
      session: { user: { id: "user-1" } },
    });
    const app = await getApp();
    expect(JSON.stringify(app)).not.toContain("inline-secret-1");
  });
});

describe("GET apps", () => {
  it("masks compose env and drops ciphertext for a member", async () => {
    as("member");
    const res = await listRoute.GET(new NextRequest("http://localhost/api/v1/organizations/org-1/apps"), orgParams);
    const body = JSON.stringify(await res.json());
    expect(body).not.toContain("inline-secret-1");
    expect(body).not.toContain("ciphertext");
  });
});

describe("PATCH app", () => {
  it("keeps saved values when a member sends the masked compose back", async () => {
    as("member");
    const masked = (await getApp()).composeContent as string;
    mockUpdate.mockImplementation((values: { composeContent: string }) => [{ ...appRow(), ...values }]);

    const res = await appRoute.PATCH(
      new NextRequest("http://localhost/api/v1/organizations/org-1/apps/app-1", {
        method: "PATCH",
        body: JSON.stringify({ composeContent: masked.replace("image: postgres", "image: postgres:17") }),
      }),
      appParams,
    );
    expect(res.status).toBe(200);
    const saved = mockUpdate.mock.calls[0][0].composeContent as string;
    expect(saved).toContain("inline-secret-1");
    expect(saved).toContain("postgres:17");
    expect(JSON.stringify(await res.json())).not.toContain("inline-secret-1");
  });
});
