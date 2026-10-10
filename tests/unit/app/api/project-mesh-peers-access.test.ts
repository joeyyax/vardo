// /projects/[...slug] server component
//
// Mesh peers are instance-wide. Instance admins see every peer, org admins only
// the peers bound to their org (#875), members none.

import { describe, it, expect, vi, beforeEach } from "vitest";

const {
  mockGetCurrentOrg,
  mockIsAppAdmin,
  mockIsFeatureEnabledAsync,
  projectsFindFirst,
  meshPeersFindMany,
  projectInstancesFindMany,
} = vi.hoisted(() => ({
  mockGetCurrentOrg: vi.fn(),
  mockIsAppAdmin: vi.fn(),
  mockIsFeatureEnabledAsync: vi.fn(),
  projectsFindFirst: vi.fn(),
  meshPeersFindMany: vi.fn(),
  projectInstancesFindMany: vi.fn(),
}));

vi.mock("@/lib/auth/session", () => ({ getCurrentOrg: mockGetCurrentOrg, getSession: vi.fn(async () => null) }));
vi.mock("@/lib/projects/load-apps", () => ({ loadProjectsApps: vi.fn(async () => []) }));
vi.mock("@/lib/config/features", () => ({ isFeatureEnabledAsync: mockIsFeatureEnabledAsync }));
vi.mock("@/lib/auth/admin", () => ({
  canImportContainers: vi.fn(async () => false),
  isAppAdmin: mockIsAppAdmin,
}));
vi.mock("next/navigation", () => ({
  redirect: vi.fn(() => { throw new Error("REDIRECT"); }),
  notFound: vi.fn(() => { throw new Error("NOT_FOUND"); }),
}));
vi.mock("@/app/(authenticated)/projects/[...slug]/project-detail", () => ({
  ProjectDetail: (props: Record<string, unknown>) => props,
}));
vi.mock("@/lib/db", () => ({
  db: {
    query: {
      projects: { findFirst: projectsFindFirst },
      meshPeers: { findMany: meshPeersFindMany },
      projectInstances: { findMany: projectInstancesFindMany },
    },
  },
}));

const ProjectDetailPage = (
  await import("@/app/(authenticated)/projects/[...slug]/page")
).default;

const PEERS = [{ id: "peer-1", name: "node-a", type: "hub", status: "up", connectionType: "wg" }];

beforeEach(() => {
  vi.clearAllMocks();
  mockGetCurrentOrg.mockResolvedValue({
    organization: { id: "org-1" },
    membership: { role: "member" },
  });
  mockIsAppAdmin.mockResolvedValue(false);
  mockIsFeatureEnabledAsync.mockResolvedValue(true);
  projectsFindFirst.mockResolvedValue({ id: "proj-1", name: "my-project", apps: [] });
  meshPeersFindMany.mockResolvedValue(PEERS);
  projectInstancesFindMany.mockResolvedValue([]);
});

async function render() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const el: any = await ProjectDetailPage({ params: Promise.resolve({ slug: ["my-project"] }) });
  return el.props as { meshPeers: unknown[]; canDelete: boolean; isInstanceAdmin: boolean };
}

function asRole(role: string) {
  mockGetCurrentOrg.mockResolvedValue({ organization: { id: "org-1" }, membership: { role } });
}

describe("projects/[...slug] — mesh peer visibility", () => {
  it("gives a non-admin member no peers", async () => {
    asRole("member");

    const props = await render();

    expect(props.canDelete).toBe(false);
    expect(props.meshPeers).toEqual([]);
    expect(meshPeersFindMany).not.toHaveBeenCalled();
  });

  it("gives an org admin only the peers bound to their org", async () => {
    asRole("admin");

    const props = await render();

    expect(props.canDelete).toBe(true);
    expect(props.meshPeers).toEqual(PEERS);
    const { where, columns } = meshPeersFindMany.mock.calls[0][0];
    expect(where({ organizationId: "col" }, { eq: (a: unknown, b: unknown) => [a, b] })).toEqual(["col", "org-1"]);
    expect(columns).toEqual({ id: true, name: true, type: true, status: true, connectionType: true });
  });

  it("gives an instance admin every peer, whatever their org role", async () => {
    asRole("member");
    mockIsAppAdmin.mockResolvedValue(true);

    const props = await render();

    expect(props.isInstanceAdmin).toBe(true);
    expect(props.meshPeers).toEqual(PEERS);
    expect(meshPeersFindMany.mock.calls[0][0].where).toBeUndefined();
  });

  it("never selects endpoints, tokens or keys", async () => {
    asRole("owner");

    await render();

    const { columns } = meshPeersFindMany.mock.calls[0][0];
    for (const secret of ["endpoint", "publicKey", "tokenHash", "outboundToken", "apiUrl", "internalIp"]) {
      expect(columns).not.toHaveProperty(secret);
    }
  });

  it("withholds peers from an admin when mesh is off", async () => {
    asRole("admin");
    mockIsFeatureEnabledAsync.mockImplementation(async (flag: string) => flag !== "mesh");

    const props = await render();

    expect(props.meshPeers).toEqual([]);
  });
});
