import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ---------------------------------------------------------------------------
// Hoisted mock factories
// ---------------------------------------------------------------------------

const { dbMock } = vi.hoisted(() => {
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
  return { dbMock };
});

vi.mock("@/lib/db", () => ({ db: dbMock }));

vi.mock("@/lib/system-settings", () => ({
  getInstanceConfig: vi.fn(async () => ({ baseDomain: "example.com" })),
}));

vi.mock("child_process", () => ({
  execFile: vi.fn(),
}));

vi.mock("fs/promises", () => ({
  mkdir: vi.fn(async () => undefined),
  writeFile: vi.fn(async () => undefined),
  rm: vi.fn(async () => undefined),
}));

// ---------------------------------------------------------------------------
// Imports after mocks
// ---------------------------------------------------------------------------

import {
  buildEnvFile,
  buildPreviewCompose,
  getSystemManagedApp,
  createVardoPreview,
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
    expect(content).toContain("DATABASE_URL=postgres://user:pass@localhost/db");
  });

  it("includes REDIS_URL when set", () => {
    process.env.REDIS_URL = "redis://localhost:6379";
    const content = buildEnvFile();
    expect(content).toContain("REDIS_URL=redis://localhost:6379");
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
    expect(content).toContain("DATABASE_URL=postgres://preview/db");
    expect(content).not.toContain("postgres://prod/db");
  });

  it("prefers PREVIEW_REDIS_URL over REDIS_URL", () => {
    process.env.REDIS_URL = "redis://prod:6379";
    process.env.PREVIEW_REDIS_URL = "redis://preview:6379";
    const content = buildEnvFile();
    expect(content).toContain("REDIS_URL=redis://preview:6379");
    expect(content).not.toContain("redis://prod:6379");
  });

  it("uses DATABASE_URL when PREVIEW_DATABASE_URL is not set", () => {
    process.env.DATABASE_URL = "postgres://prod/db";
    const content = buildEnvFile();
    expect(content).toContain("DATABASE_URL=postgres://prod/db");
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
    const fakeApp = { id: "app-1", isSystemManaged: true, gitUrl: "https://github.com/acme/vardo.git" };
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
