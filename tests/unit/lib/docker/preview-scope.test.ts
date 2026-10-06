import { describe, it, expect, beforeEach, vi } from "vitest";

// A PR on tools-api once cloned and deployed every app in the homelab "AI"
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
vi.mock("@/lib/config/features", () => ({ isFeatureEnabledAsync: vi.fn().mockResolvedValue(true) }));
vi.mock("@/lib/docker/deploy-group", () => ({ deployGroup: deployGroupMock }));

import { createPreview } from "@/lib/docker/preview";
import { environments } from "@/lib/db/schema";
import { normalizeGitRepo, previewScope } from "@/lib/docker/preview-scope";

const base = { projectId: "proj-ai", organizationId: "org-1", cloneStrategy: "clone", dependsOn: null, parentAppId: null };
const PROJECT_APPS = [
  { ...base, id: "svc", name: "tools-api", gitUrl: "git@github.com:joeyyax/tools-api.git", dependsOn: ["redis", "pg"] },
  { ...base, id: "svc-worker", name: "tools-api-worker", gitUrl: null, parentAppId: "svc" },
  { ...base, id: "redis", name: "redis", gitUrl: null },
  { ...base, id: "pg", name: "pg", gitUrl: null, cloneStrategy: "skip" },
  { ...base, id: "ks", name: "notes-api", gitUrl: "https://github.com/joeyyax/notes-api.git" },
  { ...base, id: "ks-embed", name: "notes-api-embed", gitUrl: null, parentAppId: "ks" },
  { ...base, id: "llama", name: "llm-proxy", gitUrl: "https://github.com/joeyyax/llm-proxy" },
];

beforeEach(() => {
  vi.clearAllMocks();
  inserts.length = 0;
  appsFindMany.mockResolvedValue(PROJECT_APPS);
  deployGroupMock.mockResolvedValue({ success: true, results: [], totalDurationMs: 0 });
});

const openPr = () =>
  createPreview({
    repoFullName: "joeyyax/tools-api",
    prNumber: 25,
    prUrl: "https://github.com/joeyyax/tools-api/pull/25",
    branch: "feat/x",
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
    "https://github.com/acme/tools-api.git",
    "https://github.com/joeyyax/tools-api",
    "https://github.com/joeyyax/tools-api/",
    "git@github.com:joeyyax/tools-api.git",
    "ssh://git@github.com/joeyyax/tools-api.git",
  ])("normalizes %s", (url) => {
    expect(normalizeGitRepo(url)).toBe("github.com/joeyyax/tools-api");
  });

  it("does not match a repo whose name extends the PR repo's", () => {
    expect(normalizeGitRepo("https://github.com/joeyyax/tools-api-old.git")).not.toBe(
      "github.com/joeyyax/tools-api",
    );
  });
});
