// /projects/[...slug] server component
//
// Mesh peers are system-level, not org-scoped. The page fetched every peer and
// handed the list to any org member, despite a comment saying admins only.

import { describe, it, expect, vi, beforeEach } from "vitest";

const {
  mockGetCurrentOrg,
  mockIsOrgAdmin,
  mockIsFeatureEnabledAsync,
  projectsFindFirst,
  meshPeersFindMany,
  projectInstancesFindMany,
} = vi.hoisted(() => ({
  mockGetCurrentOrg: vi.fn(),
  mockIsOrgAdmin: vi.fn(),
  mockIsFeatureEnabledAsync: vi.fn(),
  projectsFindFirst: vi.fn(),
  meshPeersFindMany: vi.fn(),
  projectInstancesFindMany: vi.fn(),
}));

vi.mock("@/lib/auth/session", () => ({ getCurrentOrg: mockGetCurrentOrg }));
vi.mock("@/lib/auth/permissions", () => ({ isOrgAdmin: mockIsOrgAdmin }));
vi.mock("@/lib/config/features", () => ({ isFeatureEnabledAsync: mockIsFeatureEnabledAsync }));
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
  mockIsFeatureEnabledAsync.mockResolvedValue(true);
  projectsFindFirst.mockResolvedValue({ id: "proj-1", name: "my-project", apps: [] });
  meshPeersFindMany.mockResolvedValue(PEERS);
  projectInstancesFindMany.mockResolvedValue([]);
});

async function render() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const el: any = await ProjectDetailPage({ params: Promise.resolve({ slug: ["my-project"] }) });
  return el.props as { meshPeers: unknown[]; isAdmin: boolean };
}

describe("projects/[...slug] — mesh peer visibility", () => {
  it("gives a non-admin member no peers", async () => {
    mockIsOrgAdmin.mockReturnValue(false);

    const props = await render();

    expect(props.isAdmin).toBe(false);
    expect(props.meshPeers).toEqual([]);
    expect(meshPeersFindMany).not.toHaveBeenCalled();
  });

  it("gives an org admin the peer list", async () => {
    mockIsOrgAdmin.mockReturnValue(true);

    const props = await render();

    expect(props.isAdmin).toBe(true);
    expect(props.meshPeers).toEqual(PEERS);
  });

  it("withholds peers from an admin when mesh is off", async () => {
    mockIsOrgAdmin.mockReturnValue(true);
    mockIsFeatureEnabledAsync.mockImplementation(async (flag: string) => flag !== "mesh");

    const props = await render();

    expect(props.meshPeers).toEqual([]);
  });
});
