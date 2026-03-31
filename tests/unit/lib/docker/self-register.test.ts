import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ---------------------------------------------------------------------------
// Hoisted mock factories
// ---------------------------------------------------------------------------

const { dbMock, isFeatureEnabledMock, readFileMock, execFileAsyncMock, execFileMock, parseComposeMock } = vi.hoisted(() => {
  // Chainable select: .select().from().orderBy().limit()
  const limitFn = vi.fn(async () => [{ id: "org-1" }]);
  const orderByFn = vi.fn(() => ({ limit: limitFn }));
  const fromFn = vi.fn(() => ({ orderBy: orderByFn }));
  const selectFn = vi.fn(() => ({ from: fromFn }));

  // Chainable insert: .insert().values().onConflictDoUpdate().returning()
  // Also thenable so `await db.insert().values().onConflictDoUpdate()` works.
  const makeInsertChain = (returnRows: unknown[]) => {
    const returning = vi.fn().mockResolvedValue(returnRows);
    const onConflictDoUpdate = vi.fn().mockReturnValue({
      returning,
      then: (resolve: (v: unknown) => void) => Promise.resolve(returnRows).then(resolve),
    });
    const values = vi.fn().mockReturnValue({ onConflictDoUpdate });
    return { values };
  };

  // Default: project insert returns proj-1, app inserts return app-1
  const insertResponses: unknown[][] = [
    [{ id: "proj-1" }], // project upsert
    [{ id: "app-1" }],  // parent app upsert
  ];

  const insertFn = vi.fn().mockImplementation(() => {
    const rows = insertResponses.shift() ?? [];
    return makeInsertChain(rows);
  });

  const dbMock = {
    select: selectFn,
    insert: insertFn,
    _limitFn: limitFn,
    _insertResponses: insertResponses,
    _makeInsertChain: makeInsertChain,
  };

  const isFeatureEnabledMock = vi.fn();
  const readFileMock = vi.fn();
  const parseComposeMock = vi.fn(() => ({
    services: { postgres: {}, redis: {}, traefik: {} },
  }));

  // self-register.ts uses `promisify(execFile)`. Attach a custom promisify
  // symbol so the promisified function resolves with { stdout, stderr }.
  const execFileAsyncMock = vi.fn().mockResolvedValue({ stdout: "", stderr: "" });
  const execFileMock = vi.fn();
  Object.defineProperty(execFileMock, Symbol.for("nodejs.util.promisify.custom"), {
    value: execFileAsyncMock,
    configurable: true,
    writable: true,
  });

  return { dbMock, isFeatureEnabledMock, readFileMock, execFileAsyncMock, execFileMock, parseComposeMock };
});

vi.mock("@/lib/db", () => ({ db: dbMock }));
vi.mock("@/lib/config/features", () => ({ isFeatureEnabledAsync: isFeatureEnabledMock }));
vi.mock("@/lib/docker/compose", () => ({ parseCompose: parseComposeMock }));
vi.mock("@/lib/logger", () => ({
  logger: { child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) },
}));
vi.mock("nanoid", () => ({ nanoid: () => "test-id" }));

vi.mock("fs/promises", () => ({ readFile: readFileMock }));
vi.mock("child_process", () => ({ execFile: execFileMock }));

// ---------------------------------------------------------------------------
// Imports after mocks
// ---------------------------------------------------------------------------

import { ensureVardoProject } from "@/lib/docker/self-register";

// ---------------------------------------------------------------------------
// ensureVardoProject — early returns
// ---------------------------------------------------------------------------

describe("ensureVardoProject", () => {
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    vi.clearAllMocks();
    savedEnv["VARDO_DIR"] = process.env["VARDO_DIR"];
    delete process.env["VARDO_DIR"];

    // Reset insert queue
    dbMock._insertResponses.splice(0);
    dbMock._insertResponses.push([{ id: "proj-1" }], [{ id: "app-1" }]);

    // Reset select chain to return org-1 by default
    const limitFn = vi.fn(async () => [{ id: "org-1" }]);
    const orderByFn = vi.fn(() => ({ limit: limitFn }));
    const fromFn = vi.fn(() => ({ orderBy: orderByFn }));
    dbMock.select.mockImplementation(() => ({ from: fromFn }));

    // Default: git commands return a URL then a branch
    execFileAsyncMock
      .mockResolvedValueOnce({ stdout: "https://github.com/acme/vardo.git\n", stderr: "" })
      .mockResolvedValue({ stdout: "main\n", stderr: "" });
  });

  afterEach(() => {
    if (savedEnv["VARDO_DIR"] === undefined) {
      delete process.env["VARDO_DIR"];
    } else {
      process.env["VARDO_DIR"] = savedEnv["VARDO_DIR"];
    }
  });

  it("returns without touching the DB when selfManagement feature is disabled", async () => {
    isFeatureEnabledMock.mockResolvedValue(false);

    await ensureVardoProject();

    expect(dbMock.insert).not.toHaveBeenCalled();
    expect(readFileMock).not.toHaveBeenCalled();
  });

  it("returns without touching the DB when VARDO_DIR is not set", async () => {
    isFeatureEnabledMock.mockResolvedValue(true);
    // VARDO_DIR is deleted in beforeEach

    await ensureVardoProject();

    expect(dbMock.insert).not.toHaveBeenCalled();
    expect(readFileMock).not.toHaveBeenCalled();
  });

  it("throws when the compose file cannot be read", async () => {
    isFeatureEnabledMock.mockResolvedValue(true);
    process.env["VARDO_DIR"] = "/opt/vardo";
    readFileMock.mockRejectedValue(new Error("ENOENT: no such file or directory"));

    await expect(ensureVardoProject()).rejects.toThrow("ENOENT");
    expect(dbMock.insert).not.toHaveBeenCalled();
  });

  it("returns without upserting when no organization exists", async () => {
    isFeatureEnabledMock.mockResolvedValue(true);
    process.env["VARDO_DIR"] = "/opt/vardo";
    readFileMock.mockResolvedValue("services:\n  vardo:\n    image: vardo\n");

    // No org found
    const emptyLimitFn = vi.fn(async () => []);
    const emptyOrderByFn = vi.fn(() => ({ limit: emptyLimitFn }));
    const emptyFromFn = vi.fn(() => ({ orderBy: emptyOrderByFn }));
    dbMock.select.mockImplementation(() => ({ from: emptyFromFn }));

    await ensureVardoProject();

    expect(dbMock.insert).not.toHaveBeenCalled();
  });

  it("upserts the project and parent app on the happy path", async () => {
    isFeatureEnabledMock.mockResolvedValue(true);
    process.env["VARDO_DIR"] = "/opt/vardo";
    readFileMock.mockResolvedValue("services:\n  vardo:\n    image: vardo\n");

    execFileAsyncMock
      .mockResolvedValueOnce({ stdout: "https://github.com/acme/vardo.git\n", stderr: "" })
      .mockResolvedValueOnce({ stdout: "main\n", stderr: "" });

    await ensureVardoProject();

    expect(dbMock.insert).toHaveBeenCalled();
  });

  it("proceeds without git info when git commands fail", async () => {
    isFeatureEnabledMock.mockResolvedValue(true);
    process.env["VARDO_DIR"] = "/opt/vardo";
    readFileMock.mockResolvedValue("services:\n  vardo:\n    image: vardo\n");

    // git commands fail — not a git repo
    execFileAsyncMock.mockRejectedValue(new Error("not a git repository"));

    // Should still complete (git failure is caught internally)
    await ensureVardoProject();

    expect(dbMock.insert).toHaveBeenCalled();
  });
});
