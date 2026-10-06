import { describe, it, expect, vi, beforeEach } from "vitest";

process.env.ENCRYPTION_MASTER_KEY = "1".repeat(64);

// A preview's `${db.DATABASE_URL}` resolves against db's own preview, not
// production's database. With no preview of db, it keeps production's value
// and says so in the deploy log.

const { dbMock, state } = vi.hoisted(() => {
  const state: {
    refEnv: { id: string; domain: string | null } | undefined;
    snapshot: string | undefined;
    prodEnv: string;
  } = { refEnv: undefined, snapshot: undefined, prodEnv: "" };
  const dbMock = {
    query: {
      apps: {
        findFirst: vi.fn(async () => ({
          id: "db",
          name: "db",
          displayName: "DB",
          organizationId: "org-1",
          projectId: "proj",
          containerPort: 5432,
          gitUrl: null,
          gitBranch: null,
          imageName: "postgres:17",
          envContent: state.prodEnv,
          domains: [{ domain: "db.example.com" }],
        })),
      },
      environments: { findFirst: vi.fn(async () => state.refEnv) },
      environmentEnv: {
        findFirst: vi.fn(async () =>
          state.snapshot ? { environmentId: state.refEnv?.id, envContent: state.snapshot } : undefined,
        ),
      },
    },
  };
  return { dbMock, state };
});

vi.mock("@/lib/db", () => ({ db: dbMock }));

import { externalVarResolver } from "@/lib/docker/deploy-steps/external-var";
import { encrypt } from "@/lib/crypto/encrypt";

const PROD_URL = "postgres://app:prod-pass@db.example.com:5432/app";
const PREVIEW_URL = "postgres://app:pr-pass@db-pr-7.example.com:5432/app";

let lines: string[];
const previewResolver = () =>
  externalVarResolver({
    organizationId: "org-1",
    projectId: "proj",
    groupEnvironmentId: "ge-1",
    environmentName: "pr-7",
    log: (l: string) => lines.push(l),
  });

beforeEach(() => {
  vi.clearAllMocks();
  lines = [];
  state.prodEnv = encrypt(`DATABASE_URL=${PROD_URL}`, "org-1");
  state.refEnv = undefined;
  state.snapshot = undefined;
});

describe("externalVarResolver in a preview", () => {
  it("resolves a sibling's var from the sibling's preview", async () => {
    state.refEnv = { id: "env-db-pr-7", domain: "db-pr-7.example.com" };
    state.snapshot = encrypt(`DATABASE_URL=${PREVIEW_URL}`, "org-1");

    const resolve = previewResolver();

    expect(await resolve("db", "DATABASE_URL")).toBe(PREVIEW_URL);
    expect(await resolve("db", "url")).toBe("https://db-pr-7.example.com");
    expect(lines).toEqual([]);
  });

  it("keeps production's value and warns when the sibling has no preview", async () => {
    const resolve = previewResolver();

    expect(await resolve("db", "DATABASE_URL")).toBe(PROD_URL);
    expect(lines.join("\n")).toMatch(/Warning: \$\{db\.DATABASE_URL\} points at production's db — it has no pr-7 environment/);
  });

  it("resolves production references unchanged outside an environment", async () => {
    const resolve = externalVarResolver({ organizationId: "org-1", projectId: "proj" });

    expect(await resolve("db", "DATABASE_URL")).toBe(PROD_URL);
    expect(await resolve("db", "url")).toBe("https://db.example.com");
    expect(dbMock.query.environments.findFirst).not.toHaveBeenCalled();
  });
});
