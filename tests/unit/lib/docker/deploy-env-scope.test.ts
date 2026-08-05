import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// The environmentId on a deploy request is caller-supplied. Resolving it by id
// alone lets an environment on another app — in another organization — decide
// the deploy's name, branch and type, and `local` grants bind mounts and the
// Docker socket.
// ---------------------------------------------------------------------------

type Predicate =
  | { op: "eq"; col: string; val: unknown }
  | { op: "and"; parts: Predicate[] };

function matches(row: Record<string, unknown>, pred: Predicate | undefined): boolean {
  if (!pred) return true;
  if (pred.op === "and") return pred.parts.every((p) => matches(row, p));
  return row[pred.col] === pred.val;
}

vi.mock("drizzle-orm", () => ({
  eq: (col: string, val: unknown) => ({ op: "eq", col, val }),
  and: (...parts: Predicate[]) => ({ op: "and", parts }),
}));

vi.mock("@/lib/db/schema", () => ({
  environments: { id: "id", appId: "appId", isDefault: "isDefault" },
}));

const { mockEnvFindFirst } = vi.hoisted(() => ({ mockEnvFindFirst: vi.fn() }));

vi.mock("@/lib/db", () => ({
  db: { query: { environments: { findFirst: mockEnvFindFirst } } },
}));

import { resolveDeployEnv, type DeployEnvLoader } from "@/lib/docker/resolve-env";

// Same shape, different owner: one environment on the app being deployed, one
// on an app the caller has no access to.
const ENV_ROWS = [
  { id: "env-own", appId: "app-1", name: "staging", type: "staging", gitBranch: "develop" },
  { id: "env-foreign", appId: "app-2", name: "sandbox", type: "local", gitBranch: "main" },
];

const PRODUCTION = { name: "production", type: "production", gitBranch: null };

describe("resolveDeployEnv", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockEnvFindFirst.mockImplementation(({ where }: { where?: Predicate }) =>
      Promise.resolve(ENV_ROWS.find((row) => matches(row, where)))
    );
  });

  it("scopes the lookup to the app being deployed", async () => {
    await resolveDeployEnv("app-1", "env-own");

    const { where } = mockEnvFindFirst.mock.calls[0][0];
    expect(where).toEqual({
      op: "and",
      parts: [
        { op: "eq", col: "id", val: "env-own" },
        { op: "eq", col: "appId", val: "app-1" },
      ],
    });
  });

  it("resolves an environment belonging to the app being deployed", async () => {
    await expect(resolveDeployEnv("app-1", "env-own")).resolves.toEqual({
      name: "staging",
      type: "staging",
      gitBranch: "develop",
    });
  });

  it("falls back to production for an environment on another app", async () => {
    await expect(resolveDeployEnv("app-1", "env-foreign")).resolves.toEqual(PRODUCTION);
  });

  it("does not take the local type from another app's environment", async () => {
    const env = await resolveDeployEnv("app-1", "env-foreign");
    expect(env.type).not.toBe("local");
  });

  it("falls back to production for an id that matches nothing", async () => {
    await expect(resolveDeployEnv("app-1", "env-missing")).resolves.toEqual(PRODUCTION);
  });

  it("does not query at all when no environment was named", async () => {
    const load = vi.fn<DeployEnvLoader>();
    await expect(resolveDeployEnv("app-1", undefined, load)).resolves.toEqual(PRODUCTION);
    expect(load).not.toHaveBeenCalled();
    expect(mockEnvFindFirst).not.toHaveBeenCalled();
  });
});
