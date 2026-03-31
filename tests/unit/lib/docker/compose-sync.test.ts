import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Mocks — declared before imports so vitest hoisting works correctly
// ---------------------------------------------------------------------------

const mockInsert = vi.fn();
const mockUpdate = vi.fn();
const mockFindMany = vi.fn();

vi.mock("@/lib/db", () => ({
  db: {
    query: {
      apps: {
        findMany: (...args: unknown[]) => mockFindMany(...args),
      },
    },
    transaction: vi.fn(),
    insert: (...args: unknown[]) => mockInsert(...args),
    update: (...args: unknown[]) => mockUpdate(...args),
  },
}));

vi.mock("nanoid", () => ({
  nanoid: () => "test-id",
}));

import { syncComposeServices } from "@/lib/docker/compose-sync";
import { db } from "@/lib/db";
import type { ComposeFile } from "@/lib/docker/compose";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeInsertChain() {
  const values = vi.fn().mockReturnValue({ returning: vi.fn().mockResolvedValue([]) });
  return { values };
}

function makeUpdateChain() {
  const where = vi.fn().mockResolvedValue(undefined);
  const set = vi.fn().mockReturnValue({ where });
  return { set, where };
}

/** A minimal two-service compose file for test purposes */
const TWO_SERVICE_COMPOSE: ComposeFile = {
  services: {
    web: { name: "web", image: "nginx:latest" },
    db: { name: "db", image: "postgres:16" },
  },
};

const BASE_OPTS = {
  parentAppId: "parent-1",
  organizationId: "org-1",
  parentAppName: "myapp",
};

// ---------------------------------------------------------------------------
// syncComposeServices — projectId on insert (new children)
// ---------------------------------------------------------------------------

describe("syncComposeServices — projectId on insert (new children)", () => {
  let insertChain: ReturnType<typeof makeInsertChain>;

  beforeEach(() => {
    vi.clearAllMocks();

    // No existing children — all services will be inserted
    mockFindMany.mockResolvedValue([]);

    insertChain = makeInsertChain();
    mockInsert.mockReturnValue({ values: insertChain.values });

    vi.mocked(db.transaction).mockImplementation(
      async (callback) =>
        callback(db as unknown as Parameters<Parameters<typeof db.transaction>[0]>[0]),
    );
  });

  it("sets projectId on new child apps when parent has a project", async () => {
    await syncComposeServices({
      ...BASE_OPTS,
      projectId: "project-abc",
      compose: TWO_SERVICE_COMPOSE,
    });

    // One insert call per service
    expect(insertChain.values.mock.calls).toHaveLength(2);

    for (const [args] of insertChain.values.mock.calls) {
      expect(args).toMatchObject({ projectId: "project-abc" });
    }
  });

  it("sets null projectId on new child apps when parent has no project", async () => {
    await syncComposeServices({
      ...BASE_OPTS,
      projectId: null,
      compose: TWO_SERVICE_COMPOSE,
    });

    for (const [args] of insertChain.values.mock.calls) {
      expect(args).toMatchObject({ projectId: null });
    }
  });
});

// ---------------------------------------------------------------------------
// syncComposeServices — projectId on update (existing children)
// ---------------------------------------------------------------------------

describe("syncComposeServices — projectId on update (existing children)", () => {
  let updateChain: ReturnType<typeof makeUpdateChain>;

  beforeEach(() => {
    vi.clearAllMocks();

    // Return existing children so the update path is exercised
    mockFindMany.mockResolvedValue([
      { id: "child-web", name: "myapp-web", composeService: "web", status: "active" },
      { id: "child-db", name: "myapp-db", composeService: "db", status: "active" },
    ]);

    updateChain = makeUpdateChain();
    mockUpdate.mockReturnValue({ set: updateChain.set });

    vi.mocked(db.transaction).mockImplementation(
      async (callback) =>
        callback(db as unknown as Parameters<Parameters<typeof db.transaction>[0]>[0]),
    );
  });

  it("propagates projectId when updating existing child apps", async () => {
    await syncComposeServices({
      ...BASE_OPTS,
      projectId: "project-xyz",
      compose: TWO_SERVICE_COMPOSE,
    });

    // Two service updates — both must include projectId
    const activeCalls = (updateChain.set.mock.calls as Array<[Record<string, unknown>]>).filter(
      ([vals]) => vals.status === "active",
    );
    expect(activeCalls).toHaveLength(2);

    for (const [vals] of activeCalls) {
      expect(vals).toMatchObject({ projectId: "project-xyz" });
    }
  });

  it("propagates null projectId when parent project is removed", async () => {
    await syncComposeServices({
      ...BASE_OPTS,
      projectId: null,
      compose: TWO_SERVICE_COMPOSE,
    });

    const activeCalls = (updateChain.set.mock.calls as Array<[Record<string, unknown>]>).filter(
      ([vals]) => vals.status === "active",
    );

    for (const [vals] of activeCalls) {
      expect(vals).toMatchObject({ projectId: null });
    }
  });

  it("does not include projectId in the orphan stopped update", async () => {
    // Add a child for a service no longer in the compose file
    mockFindMany.mockResolvedValue([
      { id: "child-web", name: "myapp-web", composeService: "web", status: "active" },
      { id: "child-db", name: "myapp-db", composeService: "db", status: "active" },
      { id: "child-old", name: "myapp-old", composeService: "old-svc", status: "active" },
    ]);

    await syncComposeServices({
      ...BASE_OPTS,
      projectId: "project-xyz",
      compose: TWO_SERVICE_COMPOSE,
    });

    // The orphan stop update must only set status — no projectId
    const stoppedCalls = (updateChain.set.mock.calls as Array<[Record<string, unknown>]>).filter(
      ([vals]) => vals.status === "stopped",
    );
    expect(stoppedCalls).toHaveLength(1);
    expect(stoppedCalls[0][0]).not.toHaveProperty("projectId");
  });
});
