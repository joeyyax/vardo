import { describe, it, expect, vi, beforeEach } from "vitest";

// A repo build reuses an image by build key: the host's first, then the build registry's.

const { findMany, execCalls, local } = vi.hoisted(() => ({
  findMany: vi.fn(),
  execCalls: [] as string[][],
  local: new Set<string>(),
}));

vi.mock("@/lib/db", () => ({ db: { query: { deployments: { findMany } } } }));
vi.mock("@/lib/utils/exec", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/utils/exec")>()),
  execFileAsync: vi.fn(async (_cmd: string, args: string[]) => {
    execCalls.push(args);
    if (args[0] === "image" && args[1] === "inspect" && !local.has(args.at(-1)!)) throw new Error("No such image");
    return { stdout: "", stderr: "" };
  }),
}));

const { reuseImage } = await import("@/lib/docker/deploy-steps/prepare-repo");
import type { DeployContext } from "@/lib/docker/deploy-context";
import type { RegistryOps } from "@/lib/docker/build-registry";

const KEY = "c".repeat(64);
const logs: string[] = [];
const ctx = { appId: "app-1", deploymentId: "dep-new", app: { name: "notes-api" }, log: (l: string) => logs.push(l) } as unknown as DeployContext;

function registry(has: boolean) {
  const calls: string[] = [];
  const ops: RegistryOps = {
    ref: (repo, key) => `localhost:5001/${repo}:${key}`,
    pull: async (ref) => (calls.push(`pull ${ref}`), has),
    push: async () => true,
    untag: async (ref) => {
      calls.push(`untag ${ref}`);
    },
  };
  return { ops, calls };
}

beforeEach(() => {
  execCalls.length = 0;
  logs.length = 0;
  local.clear();
  findMany.mockResolvedValue([{ id: "dep-old-1234", buildPlan: null }]);
});

describe("reuseImage", () => {
  it("prefers the host's image and leaves the registry alone", async () => {
    local.add("host/notes-api:dep-old-");
    const { ops, calls } = registry(true);
    const reused = await reuseImage(ctx, KEY, "host/notes-api:dep-new", ops);
    expect(reused?.id).toBe("dep-old-1234");
    expect(calls).toEqual([]);
  });

  it("pulls from the build registry when the host has no image, tags it and drops the pulled tag", async () => {
    const { ops, calls } = registry(true);
    const ref = `localhost:5001/notes-api:${KEY}`;
    const reused = await reuseImage(ctx, KEY, "host/notes-api:dep-new", ops);
    expect(reused).toEqual({ id: null, buildPlan: null });
    expect(execCalls).toContainEqual(["tag", ref, "host/notes-api:dep-new"]);
    expect(calls).toEqual([`pull ${ref}`, `untag ${ref}`]);
  });

  it("pulls even when no earlier deploy on this instance recorded the key", async () => {
    findMany.mockResolvedValue([]);
    const { ops } = registry(true);
    expect(await reuseImage(ctx, KEY, "host/notes-api:dep-new", ops)).toEqual({ id: null, buildPlan: null });
  });

  it("builds when neither has it, or no registry is configured", async () => {
    expect(await reuseImage(ctx, KEY, "host/notes-api:dep-new", registry(false).ops)).toBeNull();
    expect(await reuseImage(ctx, KEY, "host/notes-api:dep-new", null)).toBeNull();
  });
});
