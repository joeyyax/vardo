import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ---------------------------------------------------------------------------
// Hoisted mock factories
// ---------------------------------------------------------------------------

const { dbMock, execFileAsyncMock, execFileMock } = vi.hoisted(() => {
  // Builder chain returned by db.select()
  const limitFn = vi.fn(async () => [{ id: "org-1" }]);
  const orderByFn = vi.fn(() => ({ limit: limitFn }));
  const fromFn = vi.fn(() => ({ orderBy: orderByFn }));

  const dbMock = {
    query: {
      apps: {
        findFirst: vi.fn(),
      },
    },
    select: vi.fn(() => ({ from: fromFn })),
    _internals: { limitFn, orderByFn, fromFn },
  };

  // The source code calls `promisify(execFile)` which uses execFile's custom
  // promisify symbol (nodejs.util.promisify.custom) to resolve with
  // { stdout, stderr }. We expose execFileAsyncMock so tests can control
  // what the promisified call resolves/rejects with.
  const execFileAsyncMock = vi.fn().mockResolvedValue({ stdout: "", stderr: "" });
  const execFileMock = vi.fn();
  Object.defineProperty(execFileMock, Symbol.for("nodejs.util.promisify.custom"), {
    value: execFileAsyncMock,
    configurable: true,
    writable: true,
  });

  return { dbMock, execFileAsyncMock, execFileMock };
});

vi.mock("@/lib/db", () => ({ db: dbMock }));

vi.mock("@/lib/system-settings", () => ({
  getInstanceConfig: vi.fn(async () => ({ baseDomain: "example.com" })),
}));

vi.mock("child_process", () => ({
  execFile: execFileMock,
}));

vi.mock("fs/promises", () => ({
  mkdir: vi.fn(async () => undefined),
  writeFile: vi.fn(async () => undefined),
  rm: vi.fn(async () => undefined),
}));

// ---------------------------------------------------------------------------
// Imports after mocks
// ---------------------------------------------------------------------------

import { rm, mkdir, writeFile } from "fs/promises";
import { getInstanceConfig } from "@/lib/system-settings";

import {
  buildEnvFile,
  buildPreviewCompose,
  getSystemManagedApp,
  createVardoPreview,
  destroyVardoPreview,
  cleanupStaleSelfPreviews,
} from "@/lib/docker/self-preview";

// ---------------------------------------------------------------------------
// buildEnvFile
// ---------------------------------------------------------------------------

describe("buildEnvFile", () => {
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const key of ["DATABASE_URL", "REDIS_URL", "PREVIEW_DATABASE_URL", "PREVIEW_REDIS_URL", "ENCRYPTION_MASTER_KEY", "BETTER_AUTH_SECRET"]) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of Object.keys(savedEnv)) {
      if (savedEnv[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = savedEnv[key];
      }
    }
  });

  it("always includes VARDO_PREVIEW=true", () => {
    const content = buildEnvFile();
    expect(content).toContain("VARDO_PREVIEW=true");
  });

  it("always includes SKIP_MIGRATIONS=true", () => {
    const content = buildEnvFile();
    expect(content).toContain("SKIP_MIGRATIONS=true");
  });

  it("never includes ENCRYPTION_MASTER_KEY even when set in env", () => {
    process.env.ENCRYPTION_MASTER_KEY = "super-secret-encryption-key";
    const content = buildEnvFile();
    expect(content).not.toContain("ENCRYPTION_MASTER_KEY");
    expect(content).not.toContain("super-secret-encryption-key");
  });

  it("never includes BETTER_AUTH_SECRET even when set in env", () => {
    process.env.BETTER_AUTH_SECRET = "super-secret-auth-key";
    const content = buildEnvFile();
    expect(content).not.toContain("BETTER_AUTH_SECRET");
    expect(content).not.toContain("super-secret-auth-key");
  });

  it("includes DATABASE_URL when set", () => {
    process.env.DATABASE_URL = "postgres://user:pass@localhost/db";
    const content = buildEnvFile();
    expect(content).toContain('DATABASE_URL="postgres://user:pass@localhost/db"');
  });

  it("includes REDIS_URL when set", () => {
    process.env.REDIS_URL = "redis://localhost:6379";
    const content = buildEnvFile();
    expect(content).toContain('REDIS_URL="redis://localhost:6379"');
  });

  it("omits keys that are not set", () => {
    const content = buildEnvFile();
    expect(content).not.toContain("DATABASE_URL");
    expect(content).not.toContain("REDIS_URL");
  });

  it("prefers PREVIEW_DATABASE_URL over DATABASE_URL", () => {
    process.env.DATABASE_URL = "postgres://prod/db";
    process.env.PREVIEW_DATABASE_URL = "postgres://preview/db";
    const content = buildEnvFile();
    expect(content).toContain('DATABASE_URL="postgres://preview/db"');
    expect(content).not.toContain("postgres://prod/db");
  });

  it("prefers PREVIEW_REDIS_URL over REDIS_URL", () => {
    process.env.REDIS_URL = "redis://prod:6379";
    process.env.PREVIEW_REDIS_URL = "redis://preview:6379";
    const content = buildEnvFile();
    expect(content).toContain('REDIS_URL="redis://preview:6379"');
    expect(content).not.toContain("redis://prod:6379");
  });

  it("uses DATABASE_URL when PREVIEW_DATABASE_URL is not set", () => {
    process.env.DATABASE_URL = "postgres://prod/db";
    const content = buildEnvFile();
    expect(content).toContain('DATABASE_URL="postgres://prod/db"');
  });

  it("sanitizes newlines in values to prevent env file injection", () => {
    process.env.DATABASE_URL = "postgres://user:pass@host/db\nINJECTED=evil";
    const content = buildEnvFile();
    // The sanitized value must not create a separate line for INJECTED
    const lines = content.split("\n").filter(Boolean);
    const injectedLine = lines.find((l) => l === "INJECTED=evil" || l.startsWith("INJECTED="));
    expect(injectedLine).toBeUndefined();
    // DATABASE_URL should still appear as a single line
    const dbLine = lines.find((l) => l.startsWith("DATABASE_URL="));
    expect(dbLine).toBeDefined();
  });

  it("ends with a trailing newline", () => {
    const content = buildEnvFile();
    expect(content.endsWith("\n")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// buildPreviewCompose
// ---------------------------------------------------------------------------

describe("buildPreviewCompose", () => {
  it("includes the domain in the Traefik router rule", () => {
    const content = buildPreviewCompose({ domain: "vardo-pr-42.example.com", routerName: "vardo-pr-42" });
    expect(content).toContain("Host(`vardo-pr-42.example.com`)");
  });

  it("uses the routerName for Traefik labels", () => {
    const content = buildPreviewCompose({ domain: "vardo-pr-42.example.com", routerName: "vardo-pr-42" });
    expect(content).toContain("traefik.http.routers.vardo-pr-42.rule");
    expect(content).toContain("traefik.http.routers.vardo-pr-42.tls=true");
    expect(content).toContain("traefik.http.services.vardo-pr-42.loadbalancer.server.port=3000");
  });

  it("references the vardo-network as external", () => {
    const content = buildPreviewCompose({ domain: "vardo-pr-1.example.com", routerName: "vardo-pr-1" });
    expect(content).toContain("vardo-network");
    expect(content).toContain("external: true");
  });

  it("references the .preview.env file", () => {
    const content = buildPreviewCompose({ domain: "vardo-pr-1.example.com", routerName: "vardo-pr-1" });
    expect(content).toContain(".preview.env");
  });

  it("enables TLS with the le cert resolver", () => {
    const content = buildPreviewCompose({ domain: "vardo-pr-1.example.com", routerName: "vardo-pr-1" });
    expect(content).toContain("tls.certresolver=le");
  });
});

// ---------------------------------------------------------------------------
// getSystemManagedApp
// ---------------------------------------------------------------------------

describe("getSystemManagedApp", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: org exists
    const limitFn = vi.fn(async () => [{ id: "org-1" }]);
    const orderByFn = vi.fn(() => ({ limit: limitFn }));
    const fromFn = vi.fn(() => ({ orderBy: orderByFn }));
    dbMock.select.mockReturnValue({ from: fromFn });
  });

  it("queries by git_url constructed from repoFullName", async () => {
    dbMock.query.apps.findFirst.mockResolvedValue(null);
    await getSystemManagedApp("acme/vardo");
    expect(dbMock.query.apps.findFirst).toHaveBeenCalledOnce();
    // The where clause is a Drizzle SQL expression with circular references.
    // Use a circular-safe serializer to find the gitUrl string inside it.
    const callArg = dbMock.query.apps.findFirst.mock.calls[0][0];
    const seen = new WeakSet();
    const encoded = JSON.stringify(callArg, (_k, v) => {
      if (typeof v === "symbol" || typeof v === "function") return undefined;
      if (typeof v === "object" && v !== null) {
        if (seen.has(v)) return "[Circular]";
        seen.add(v);
      }
      return v;
    });
    expect(encoded).toContain("https://github.com/acme/vardo");
  });

  it("constructs distinct URLs for different repos", async () => {
    dbMock.query.apps.findFirst.mockResolvedValue(null);
    await getSystemManagedApp("acme/vardo");

    // Reset and call with a different repo
    vi.clearAllMocks();
    const limitFn = vi.fn(async () => [{ id: "org-1" }]);
    const orderByFn = vi.fn(() => ({ limit: limitFn }));
    const fromFn = vi.fn(() => ({ orderBy: orderByFn }));
    dbMock.select.mockReturnValue({ from: fromFn });
    dbMock.query.apps.findFirst.mockResolvedValue(null);
    await getSystemManagedApp("other/repo");

    const callArg = dbMock.query.apps.findFirst.mock.calls[0][0];
    const seen = new WeakSet();
    const encoded = JSON.stringify(callArg, (_k, v) => {
      if (typeof v === "symbol" || typeof v === "function") return undefined;
      if (typeof v === "object" && v !== null) {
        if (seen.has(v)) return "[Circular]";
        seen.add(v);
      }
      return v;
    });
    expect(encoded).toContain("https://github.com/other/repo");
    expect(encoded).not.toContain("acme/vardo");
  });

  it("returns null when no organization exists", async () => {
    const limitFn = vi.fn(async () => []);
    const orderByFn = vi.fn(() => ({ limit: limitFn }));
    const fromFn = vi.fn(() => ({ orderBy: orderByFn }));
    dbMock.select.mockReturnValue({ from: fromFn });

    const result = await getSystemManagedApp("acme/vardo");
    expect(result).toBeNull();
    expect(dbMock.query.apps.findFirst).not.toHaveBeenCalled();
  });

  it("returns null when no matching app exists", async () => {
    dbMock.query.apps.findFirst.mockResolvedValue(null);
    const result = await getSystemManagedApp("acme/vardo");
    expect(result).toBeNull();
  });

  it("returns the app when a system-managed app is found", async () => {
    const fakeApp = { id: "app-1", isSystemManaged: true, gitUrl: "https://github.com/acme/vardo" };
    dbMock.query.apps.findFirst.mockResolvedValue(fakeApp);
    const result = await getSystemManagedApp("acme/vardo");
    expect(result).toEqual(fakeApp);
  });
});

// ---------------------------------------------------------------------------
// createVardoPreview — validation
// ---------------------------------------------------------------------------

describe("createVardoPreview input validation", () => {
  it("rejects a non-integer prNumber", async () => {
    await expect(
      createVardoPreview({ prNumber: 1.5, branch: "feat/test", repoFullName: "acme/vardo" })
    ).rejects.toThrow("Invalid PR number");
  });

  it("rejects prNumber of zero", async () => {
    await expect(
      createVardoPreview({ prNumber: 0, branch: "feat/test", repoFullName: "acme/vardo" })
    ).rejects.toThrow("Invalid PR number");
  });

  it("rejects a negative prNumber", async () => {
    await expect(
      createVardoPreview({ prNumber: -1, branch: "feat/test", repoFullName: "acme/vardo" })
    ).rejects.toThrow("Invalid PR number");
  });

  it("rejects a branch name starting with a dash", async () => {
    await expect(
      createVardoPreview({ prNumber: 42, branch: "--upload-pack=malicious-cmd", repoFullName: "acme/vardo" })
    ).rejects.toThrow("Invalid branch name");
  });

  it("rejects any branch name starting with -", async () => {
    await expect(
      createVardoPreview({ prNumber: 42, branch: "-bad", repoFullName: "acme/vardo" })
    ).rejects.toThrow("Invalid branch name");
  });

  it("rejects branch names with disallowed characters", async () => {
    await expect(
      createVardoPreview({ prNumber: 42, branch: "feat/bad branch", repoFullName: "acme/vardo" })
    ).rejects.toThrow("Invalid branch name");
    await expect(
      createVardoPreview({ prNumber: 42, branch: "feat/bad;injection", repoFullName: "acme/vardo" })
    ).rejects.toThrow("Invalid branch name");
  });

  it("rejects NaN as prNumber", async () => {
    await expect(
      createVardoPreview({ prNumber: NaN, branch: "feat/test", repoFullName: "acme/vardo" })
    ).rejects.toThrow("Invalid PR number");
  });

  it("rejects repoFullName missing a slash", async () => {
    await expect(
      createVardoPreview({ prNumber: 42, branch: "feat/test", repoFullName: "nodash" })
    ).rejects.toThrow("Invalid repo name");
  });

  it("rejects repoFullName with shell-special characters", async () => {
    await expect(
      createVardoPreview({ prNumber: 42, branch: "feat/test", repoFullName: "acme/vardo;evil" })
    ).rejects.toThrow("Invalid repo name");
    await expect(
      createVardoPreview({ prNumber: 42, branch: "feat/test", repoFullName: "acme/vardo\nevil" })
    ).rejects.toThrow("Invalid repo name");
  });

  it("rejects repoFullName with spaces", async () => {
    await expect(
      createVardoPreview({ prNumber: 42, branch: "feat/test", repoFullName: "acme/my repo" })
    ).rejects.toThrow("Invalid repo name");
  });

  it("rejects an invalid baseDomain from instance config", async () => {
    const { getInstanceConfig } = await import("@/lib/system-settings");
    vi.mocked(getInstanceConfig).mockResolvedValueOnce({ baseDomain: "evil\ndomain.com" } as never);
    await expect(
      createVardoPreview({ prNumber: 42, branch: "feat/test", repoFullName: "acme/vardo" })
    ).rejects.toThrow("Invalid baseDomain");
  });
});

// ---------------------------------------------------------------------------
// createVardoPreview — happy path
// ---------------------------------------------------------------------------

// Helper: make the promisified execFile succeed with empty output.
// Uses execFileAsyncMock (the promisify.custom implementation) so that the
// source code's `promisify(execFile)` resolves with { stdout, stderr }.
function makeExecSucceed() {
  execFileAsyncMock.mockResolvedValue({ stdout: "", stderr: "" });
}

describe("createVardoPreview — happy path", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getInstanceConfig).mockResolvedValue({ baseDomain: "example.com" } as never);
    makeExecSucceed();
  });

  it("returns the correct domain and projectName for a valid input", async () => {
    const result = await createVardoPreview({
      prNumber: 42,
      branch: "feat/my-feature",
      repoFullName: "acme/vardo",
    });

    expect(result.domain).toBe("vardo-pr-42.example.com");
    expect(result.projectName).toBe("vardo-preview-pr-42");
  });

  it("creates the preview directory and writes env and compose files", async () => {
    await createVardoPreview({
      prNumber: 42,
      branch: "feat/my-feature",
      repoFullName: "acme/vardo",
    });

    expect(vi.mocked(mkdir)).toHaveBeenCalled();
    // Two writeFile calls: env file and compose file
    expect(vi.mocked(writeFile)).toHaveBeenCalledTimes(2);
  });

  it("clones the repo and runs docker compose up", async () => {
    await createVardoPreview({
      prNumber: 42,
      branch: "feat/my-feature",
      repoFullName: "acme/vardo",
    });

    expect(execFileAsyncMock).toHaveBeenCalledWith(
      "git",
      expect.arrayContaining(["clone", "--branch", "feat/my-feature"]),
      expect.any(Object)
    );
    expect(execFileAsyncMock).toHaveBeenCalledWith(
      "docker",
      expect.arrayContaining(["compose", "up", "-d", "--build"]),
      expect.any(Object)
    );
  });

  it("throws when docker compose up fails", async () => {
    // execFileAsync call order: 1=docker-down (teardown), 2=git-clone, 3=docker-up (fail)
    execFileAsyncMock
      .mockResolvedValueOnce({ stdout: "", stderr: "" }) // docker compose down
      .mockResolvedValueOnce({ stdout: "", stderr: "" }) // git clone
      .mockRejectedValueOnce(new Error("build failed"));  // docker compose up

    await expect(
      createVardoPreview({ prNumber: 42, branch: "feat/my-feature", repoFullName: "acme/vardo" })
    ).rejects.toThrow("Vardo preview build failed for PR #42");
  });
});

// ---------------------------------------------------------------------------
// destroyVardoPreview
// ---------------------------------------------------------------------------

describe("destroyVardoPreview", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    makeExecSucceed();
  });

  it("calls docker compose down with the correct project name", async () => {
    await destroyVardoPreview(42);

    expect(execFileAsyncMock).toHaveBeenCalledWith(
      "docker",
      expect.arrayContaining(["compose", "-p", "vardo-preview-pr-42", "down", "--volumes"]),
      expect.any(Object)
    );
  });

  it("removes the temp directory after tearing down containers", async () => {
    await destroyVardoPreview(42);
    expect(vi.mocked(rm)).toHaveBeenCalled();
  });

  it("still removes the temp dir even when docker compose down fails", async () => {
    // docker compose down fails (containers already gone or docker not running)
    execFileAsyncMock.mockRejectedValueOnce(new Error("no such project"));

    // Should not throw — _teardown swallows errors
    await destroyVardoPreview(99);
    expect(vi.mocked(rm)).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// cleanupStaleSelfPreviews
// ---------------------------------------------------------------------------

describe("cleanupStaleSelfPreviews", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: all execFileAsync calls succeed with empty output
    execFileAsyncMock.mockResolvedValue({ stdout: "", stderr: "" });
  });

  it("returns 0 when docker ps fails", async () => {
    execFileAsyncMock.mockRejectedValueOnce(new Error("docker not found"));

    const result = await cleanupStaleSelfPreviews();
    expect(result).toBe(0);
  });

  it("returns 0 when no preview containers are running", async () => {
    execFileAsyncMock.mockResolvedValueOnce({ stdout: "", stderr: "" });

    const result = await cleanupStaleSelfPreviews();
    expect(result).toBe(0);
  });

  it("destroys containers older than maxAgeHours", async () => {
    // 100 hours ago — well past the 72-hour default threshold
    const staleDate = new Date(Date.now() - 100 * 60 * 60 * 1000).toISOString();
    const psOutput = `vardo-preview-pr-42-vardo-1\t${staleDate}`;

    execFileAsyncMock
      .mockResolvedValueOnce({ stdout: psOutput, stderr: "" }) // docker ps
      .mockResolvedValue({ stdout: "", stderr: "" }); // docker compose down

    const result = await cleanupStaleSelfPreviews();
    expect(result).toBe(1);
  });

  it("does not destroy containers younger than maxAgeHours", async () => {
    // 1 hour ago — well within the 72-hour threshold
    const recentDate = new Date(Date.now() - 1 * 60 * 60 * 1000).toISOString();
    const psOutput = `vardo-preview-pr-43-vardo-1\t${recentDate}`;

    execFileAsyncMock.mockResolvedValueOnce({ stdout: psOutput, stderr: "" });

    const result = await cleanupStaleSelfPreviews(72);
    expect(result).toBe(0);
  });

  it("counts each PR number only once even with multiple containers", async () => {
    const staleDate = new Date(Date.now() - 100 * 60 * 60 * 1000).toISOString();
    const psOutput = [
      `vardo-preview-pr-42-vardo-1\t${staleDate}`,
      `vardo-preview-pr-42-redis-1\t${staleDate}`, // same PR, different service
    ].join("\n");

    execFileAsyncMock
      .mockResolvedValueOnce({ stdout: psOutput, stderr: "" }) // docker ps
      .mockResolvedValue({ stdout: "", stderr: "" }); // docker compose down

    const result = await cleanupStaleSelfPreviews();
    expect(result).toBe(1); // PR #42 cleaned once despite two containers
  });

  it("respects a custom maxAgeHours threshold", async () => {
    // 5 hours ago — stale under a 2-hour threshold but not the default 72
    const date5HoursAgo = new Date(Date.now() - 5 * 60 * 60 * 1000).toISOString();
    const psOutput = `vardo-preview-pr-55-vardo-1\t${date5HoursAgo}`;

    execFileAsyncMock
      .mockResolvedValueOnce({ stdout: psOutput, stderr: "" }) // docker ps
      .mockResolvedValue({ stdout: "", stderr: "" }); // docker compose down

    const result = await cleanupStaleSelfPreviews(2); // 2-hour threshold
    expect(result).toBe(1);
  });
});
