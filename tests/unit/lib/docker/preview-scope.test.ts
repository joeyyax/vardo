import { describe, it, expect, beforeEach, vi } from "vitest";

process.env.ENCRYPTION_MASTER_KEY = "1".repeat(64);

// A PR on tools-api once cloned and deployed every app in its "AI"
// project, notes-api included. A preview covers the PR repo's apps,
// their compose children and their declared dependencies — nothing else.

const { inserts, appsFindMany, deployGroupMock } = vi.hoisted(() => ({
  inserts: [] as { table: unknown; values: Record<string, unknown> }[],
  appsFindMany: vi.fn(),
  deployGroupMock: vi.fn(),
}));

vi.mock("@/lib/db", () => {
  return {
    db: {
      query: {
        apps: { findMany: appsFindMany },
        projects: { findFirst: vi.fn().mockResolvedValue({ id: "proj-ai", name: "AI" }) },
        organizations: { findFirst: vi.fn().mockResolvedValue({ baseDomain: "example.com" }) },
        groupEnvironments: { findFirst: vi.fn().mockResolvedValue(null) },
        domains: {
          findMany: vi.fn(async () => [{ id: "d1", domain: "prod.example.com", appId: "x" }]),
        },
        envVars: { findMany: vi.fn().mockResolvedValue([]) },
      },
      insert: vi.fn((table: unknown) => ({
        values: vi.fn(async (values: Record<string, unknown>) => {
          inserts.push({ table, values });
        }),
      })),
    },
  };
});
vi.mock("@/lib/redis", () => {
  const down = () => Promise.reject(new Error("redis down"));
  return { redis: { get: down, set: down, del: down, eval: down } };
});
vi.mock("@/lib/config/features", () => ({ isFeatureEnabledAsync: vi.fn().mockResolvedValue(true) }));
vi.mock("@/lib/docker/deploy-group", () => ({ deployGroup: deployGroupMock }));

import { createPreview } from "@/lib/docker/preview";
import { environments, domains } from "@/lib/db/schema";
import { normalizeGitRepo, previewScope } from "@/lib/docker/preview-scope";

const base = { projectId: "proj-ai", organizationId: "org-1", cloneStrategy: "clone", dependsOn: null, parentAppId: null };
const PROJECT_APPS = [
  { ...base, id: "svc", name: "tools-api", gitUrl: "git@github.com:acme/tools-api.git", dependsOn: ["redis", "pg"] },
  { ...base, id: "svc-worker", name: "tools-api-worker", gitUrl: null, parentAppId: "svc" },
  { ...base, id: "redis", name: "redis", gitUrl: null },
  { ...base, id: "pg", name: "pg", gitUrl: null, cloneStrategy: "skip" },
  { ...base, id: "ks", name: "notes-api", gitUrl: "https://github.com/acme/notes-api.git" },
  { ...base, id: "ks-embed", name: "notes-api-embed", gitUrl: null, parentAppId: "ks" },
  { ...base, id: "llama", name: "llm-proxy", gitUrl: "https://github.com/acme/llm-proxy" },
];

beforeEach(() => {
  vi.clearAllMocks();
  inserts.length = 0;
  appsFindMany.mockResolvedValue(PROJECT_APPS);
  deployGroupMock.mockResolvedValue({ success: true, results: [], totalDurationMs: 0 });
});

const openPr = () =>
  createPreview({
    repoFullName: "acme/tools-api",
    prNumber: 25,
    prUrl: "https://github.com/acme/tools-api/pull/25",
    branch: "feat/x",
    organizationIds: ["org-1"],
  });

describe("createPreview scope", () => {
  it("creates environments only for the repo's app, its children and its deps", async () => {
    await openPr();

    const envApps = inserts.filter((i) => i.table === environments).map((i) => i.values.appId);
    expect(envApps.sort()).toEqual(["redis", "svc", "svc-worker"]);
  });

  it("puts the PR branch on the repo's app only", async () => {
    await openPr();

    const branches = Object.fromEntries(
      inserts.filter((i) => i.table === environments).map((i) => [i.values.appId, i.values.gitBranch]),
    );
    expect(branches).toEqual({ svc: "feat/x", "svc-worker": undefined, redis: undefined });
  });

  it("inserts no domain row on the production app", async () => {
    await openPr();

    expect(inserts.filter((i) => i.table === domains)).toEqual([]);
  });

  it("matches the repo whatever form the git URL takes", async () => {
    const result = await openPr();
    expect(result).not.toBeNull();
  });
});

describe("previewScope", () => {
  it("previews a matched compose child through its parent", () => {
    const apps = [
      { ...base, id: "p", name: "stack", gitUrl: null },
      { ...base, id: "c", name: "stack-web", gitUrl: "https://github.com/o/web.git", parentAppId: "p" },
      { ...base, id: "other", name: "other", gitUrl: null },
    ];
    expect([...previewScope(apps, "o/web")].sort()).toEqual(["c", "p"]);
  });

  it("follows dependencies transitively", () => {
    const apps = [
      { ...base, id: "a", name: "a", gitUrl: "https://github.com/o/a", dependsOn: ["b"] },
      { ...base, id: "b", name: "b", gitUrl: null, dependsOn: ["c"] },
      { ...base, id: "c", name: "c", gitUrl: null },
      { ...base, id: "d", name: "d", gitUrl: null },
    ];
    expect([...previewScope(apps, "o/a")].sort()).toEqual(["a", "b", "c"]);
  });
});

describe("normalizeGitRepo", () => {
  it.each([
    "https://github.com/Acme/Tools-API.git",
    "https://github.com/acme/tools-api",
    "https://github.com/acme/tools-api/",
    "git@github.com:acme/tools-api.git",
    "ssh://git@github.com/acme/tools-api.git",
  ])("normalizes %s", (url) => {
    expect(normalizeGitRepo(url)).toBe("github.com/acme/tools-api");
  });

  it("does not match a repo whose name extends the PR repo's", () => {
    expect(normalizeGitRepo("https://github.com/acme/tools-api-old.git")).not.toBe(
      "github.com/acme/tools-api",
    );
  });
});

describe("preview org scope", () => {
  it("takes no app when no org may hold the preview", async () => {
    appsFindMany.mockClear();
    const result = await createPreview({
      repoFullName: "acme/tools-api",
      prNumber: 26,
      prUrl: "https://github.com/acme/tools-api/pull/26",
      branch: "feat/x",
      organizationIds: [],
    });
    expect(result).toBeNull();
    expect(appsFindMany).not.toHaveBeenCalled();
  });
});
