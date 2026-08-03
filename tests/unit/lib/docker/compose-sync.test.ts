import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Mocks — declared before imports so vitest hoisting works correctly
// ---------------------------------------------------------------------------

const mockInsert = vi.fn();
const mockUpdate = vi.fn();
const mockFindMany = vi.fn();
const mockFindFirst = vi.fn().mockResolvedValue({ isSystemManaged: false });
const mockExecute = vi.fn().mockResolvedValue(undefined);

vi.mock("@/lib/db", () => ({
  db: {
    query: {
      apps: {
        findMany: (...args: unknown[]) => mockFindMany(...args),
        findFirst: (...args: unknown[]) => mockFindFirst(...args),
      },
    },
    transaction: vi.fn(),
    insert: (...args: unknown[]) => mockInsert(...args),
    update: (...args: unknown[]) => mockUpdate(...args),
    execute: (...args: unknown[]) => mockExecute(...args),
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
  beforeEach(() => {
    vi.clearAllMocks();

    // No existing children — all services will be inserted
    mockFindMany.mockResolvedValue([]);
    mockFindFirst.mockResolvedValue({ isSystemManaged: false });

    // The code now uses db.execute(sql`...`) for inserts, not db.insert().values()
  });

  it("sets projectId on new child apps when parent has a project", async () => {
    await syncComposeServices({
      ...BASE_OPTS,
      projectId: "project-abc",
      compose: TWO_SERVICE_COMPOSE,
    });

    // One execute call per service (raw SQL insert)
    expect(mockExecute).toHaveBeenCalledTimes(2);

    // The sql template tag stores interpolated values directly in queryChunks
    // (non-object entries are parameter values; objects with .value are SQL text fragments)
    for (const call of mockExecute.mock.calls) {
      const sqlObj = call[0];
      const chunks: unknown[] = sqlObj?.queryChunks ?? [];
      const paramValues = chunks.filter(
        (c: unknown) => !(typeof c === "object" && c !== null && "value" in (c as Record<string, unknown>)),
      );
      expect(paramValues).toContain("project-abc");
    }
  });

});

// ---------------------------------------------------------------------------
// syncComposeServices — system-managed inheritance
// ---------------------------------------------------------------------------

describe("syncComposeServices — system-managed inheritance", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFindMany.mockResolvedValue([]);
    mockFindFirst.mockResolvedValue({ isSystemManaged: true });
  });

  it("marks new children system-managed when the parent is", async () => {
    await syncComposeServices({
      ...BASE_OPTS,
      projectId: "project-abc",
      compose: TWO_SERVICE_COMPOSE,
    });

    expect(mockExecute).toHaveBeenCalledTimes(2);
    for (const call of mockExecute.mock.calls) {
      const chunks: unknown[] = call[0]?.queryChunks ?? [];
      const paramValues = chunks.filter(
        (c: unknown) => !(typeof c === "object" && c !== null && "value" in (c as Record<string, unknown>)),
      );
      expect(paramValues).toContain(true);
    }
  });

  it("carries the flag onto children that already exist", async () => {
    mockFindMany.mockResolvedValue([
      { id: "child-web", name: "myapp-web", composeService: "web", status: "active" },
      { id: "child-db", name: "myapp-db", composeService: "db", status: "active" },
    ]);
    const updateChain = makeUpdateChain();
    mockUpdate.mockReturnValue({ set: updateChain.set });

    await syncComposeServices({
      ...BASE_OPTS,
      projectId: "project-abc",
      compose: TWO_SERVICE_COMPOSE,
    });

    const activeCalls = (updateChain.set.mock.calls as Array<[Record<string, unknown>]>).filter(
      ([vals]) => vals.status === "active",
    );
    expect(activeCalls).toHaveLength(2);
    for (const [vals] of activeCalls) {
      expect(vals).toMatchObject({ isSystemManaged: true });
    }
  });

  it("leaves children of an ordinary parent unmanaged", async () => {
    mockFindFirst.mockResolvedValue({ isSystemManaged: false });

    await syncComposeServices({
      ...BASE_OPTS,
      projectId: "project-abc",
      compose: TWO_SERVICE_COMPOSE,
    });

    for (const call of mockExecute.mock.calls) {
      const chunks: unknown[] = call[0]?.queryChunks ?? [];
      const paramValues = chunks.filter(
        (c: unknown) => !(typeof c === "object" && c !== null && "value" in (c as Record<string, unknown>)),
      );
      expect(paramValues).toContain(false);
      expect(paramValues).not.toContain(true);
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

    mockFindFirst.mockResolvedValue({ isSystemManaged: false });

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

// ---------------------------------------------------------------------------
// syncComposeServices — resource limits are UI-owned, not compose-mirrored
// ---------------------------------------------------------------------------

describe("syncComposeServices — child cpuLimit/memoryLimit", () => {
  const COMPOSE_WITH_LIMITS: ComposeFile = {
    services: {
      web: {
        name: "web",
        image: "nginx:latest",
        deploy: { resources: { limits: { cpus: "1", memory: "512M" } } },
      },
      db: { name: "db", image: "postgres:16" },
    },
  };

  it("never touches cpuLimit/memoryLimit when updating an existing child, even when compose declares a limit", async () => {
    mockFindFirst.mockResolvedValue({ isSystemManaged: false });
    mockFindMany.mockResolvedValue([
      { id: "child-web", name: "myapp-web", composeService: "web", status: "active" },
      { id: "child-db", name: "myapp-db", composeService: "db", status: "active" },
    ]);
    const updateChain = makeUpdateChain();
    mockUpdate.mockReturnValue({ set: updateChain.set });
    vi.mocked(db.transaction).mockImplementation(
      async (callback) =>
        callback(db as unknown as Parameters<Parameters<typeof db.transaction>[0]>[0]),
    );

    await syncComposeServices({
      ...BASE_OPTS,
      projectId: "project-abc",
      compose: COMPOSE_WITH_LIMITS,
    });

    const activeCalls = (updateChain.set.mock.calls as Array<[Record<string, unknown>]>).filter(
      ([vals]) => vals.status === "active",
    );
    expect(activeCalls).toHaveLength(2);
    for (const [vals] of activeCalls) {
      // A UI-set limit on the child must survive a deploy untouched -- the sync
      // update never carries cpuLimit/memoryLimit at all, compose-declared or not.
      expect(vals).not.toHaveProperty("cpuLimit");
      expect(vals).not.toHaveProperty("memoryLimit");
    }
  });

  it("inserts new children with null cpuLimit/memoryLimit even when compose declares a limit", async () => {
    mockFindFirst.mockResolvedValue({ isSystemManaged: false });
    mockFindMany.mockResolvedValue([]);

    await syncComposeServices({
      ...BASE_OPTS,
      projectId: "project-abc",
      compose: COMPOSE_WITH_LIMITS,
    });

    expect(mockExecute).toHaveBeenCalledTimes(2);
    for (const call of mockExecute.mock.calls) {
      const chunks: unknown[] = call[0]?.queryChunks ?? [];
      const paramValues = chunks.filter(
        (c: unknown) => !(typeof c === "object" && c !== null && "value" in (c as Record<string, unknown>)),
      );
      // Matches app creation elsewhere: cpuLimit/memoryLimit start null and are
      // only ever set through an explicit UI edit, never seeded from compose.
      expect(paramValues.filter((v) => v === null).length).toBeGreaterThanOrEqual(2);
    }
  });
});
