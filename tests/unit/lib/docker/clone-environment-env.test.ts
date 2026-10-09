import { describe, it, expect, vi, beforeEach } from "vitest";

process.env.ENCRYPTION_MASTER_KEY = "1".repeat(64);

// Creating a preview snapshots each app's env into the new environment, with
// production hostnames rewritten and the clone strategy applied.

const { dbMock, inserts, projectApps } = vi.hoisted(() => {
  const inserts: { table: unknown; values: Record<string, unknown> | Record<string, unknown>[] }[] = [];
  const projectApps: Record<string, unknown>[] = [];
  const dbMock = {
    insert: vi.fn((table: unknown) => ({
      values: vi.fn(async (values: Record<string, unknown>) => {
        inserts.push({ table, values });
      }),
    })),
    query: {
      projects: { findFirst: vi.fn().mockResolvedValue({ id: "proj", organizationId: "org-1" }) },
      organizations: { findFirst: vi.fn().mockResolvedValue({ baseDomain: "example.com" }) },
      apps: { findMany: vi.fn(async () => projectApps) },
      domains: {
        findMany: vi.fn(async () => [
          { appId: "web", domain: "web.example.com" },
          { appId: "api", domain: "api.example.com" },
          { appId: "cdn", domain: "cdn.example.com" },
        ]),
      },
      envVars: { findMany: vi.fn().mockResolvedValue([]) },
    },
  };
  return { dbMock, inserts, projectApps };
});

vi.mock("@/lib/db", () => ({ db: dbMock }));

import { createGroupEnvironment } from "@/lib/docker/clone";
import { environments, environmentEnv } from "@/lib/db/schema";
import { encrypt, decrypt } from "@/lib/crypto/encrypt";
import { parseEnvToMap } from "@/lib/env/parse-env";

const app = (id: string, cloneStrategy: string, env: string) => ({
  id,
  name: id,
  projectId: "proj",
  organizationId: "org-1",
  cloneStrategy,
  envContent: encrypt(env, "org-1"),
});

function snapshotFor(appId: string): string | undefined {
  const env = inserts.find((i) => i.table === environments && (i.values as { appId: string }).appId === appId);
  if (!env) return undefined;
  const envId = (env.values as { id: string }).id;
  const row = inserts.find((i) => i.table === environmentEnv && (i.values as { environmentId: string }).environmentId === envId);
  return row ? decrypt((row.values as { envContent: string }).envContent, "org-1") : undefined;
}

beforeEach(() => {
  vi.clearAllMocks();
  inserts.length = 0;
  projectApps.length = 0;
  projectApps.push(
    app(
      "web",
      "clone",
      [
        "API_URL=https://api.example.com/v1",
        "SELF=https://web.example.com",
        "CDN_URL=https://cdn.example.com",
        "PARTNER=https://myapi.example.com",
        "DATABASE_URL=${db.DATABASE_URL}",
        "SESSION_SECRET=prod-session",
      ].join("\n"),
    ),
    app("api", "clone", "PORT=4000"),
    app("db", "empty", "POSTGRES_USER=app\nPOSTGRES_PASSWORD=prod-pass"),
    app(
      "worker",
      "empty",
      "DB_PASSWORD=prod-pass\nAPI_SECRET=other\nEMPTY_SECRET=\nREF_PASSWORD=${db.POSTGRES_PASSWORD}",
    ),
    app("cdn", "skip", "TOKEN=x"),
  );
});

describe("createGroupEnvironment env snapshot", () => {
  const create = () =>
    createGroupEnvironment({
      projectId: "proj",
      organizationId: "org-1",
      name: "pr-7",
      type: "preview",
      prNumber: 7,
    });

  it("rewrites production hostnames of cloned apps to their preview hostnames", async () => {
    await create();

    expect(snapshotFor("web")!.split("\n")).toEqual(
      [
        "API_URL=https://api-pr-7.example.com/v1",
        "SELF=https://web-pr-7.example.com",
        // cdn is skipped, so it keeps pointing at production.
        "CDN_URL=https://cdn.example.com",
        "PARTNER=https://myapi.example.com",
        "DATABASE_URL=${db.DATABASE_URL}",
        expect.stringMatching(/^SESSION_SECRET=[A-Za-z0-9_-]{32}$/),
      ],
    );
  });

  it("never copies a production secret value into a preview, whatever the strategy", async () => {
    await create();

    expect(parseEnvToMap(snapshotFor("web")!).SESSION_SECRET).not.toBe("prod-session");
    expect(parseEnvToMap(snapshotFor("api")!).PORT).toBe("4000");
  });

  it("keeps a cloned app's secrets in a staging environment", async () => {
    await createGroupEnvironment({ projectId: "proj", organizationId: "org-1", name: "staging", type: "staging" });

    expect(parseEnvToMap(snapshotFor("web")!).SESSION_SECRET).toBe("prod-session");
  });

  it("generates fresh secrets for the empty strategy, one per production value across the environment", async () => {
    await create();

    const db = parseEnvToMap(snapshotFor("db")!);
    const worker = parseEnvToMap(snapshotFor("worker")!);
    expect(db.POSTGRES_USER).toBe("app");
    expect(db.POSTGRES_PASSWORD).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(db.POSTGRES_PASSWORD).not.toBe("prod-pass");
    expect(worker.DB_PASSWORD).toBe(db.POSTGRES_PASSWORD);
    expect(worker.API_SECRET).not.toBe(db.POSTGRES_PASSWORD);
    expect(worker.EMPTY_SECRET).toBe("");
    expect(worker.REF_PASSWORD).toBe("${db.POSTGRES_PASSWORD}");
  });

  it("generates different secrets for each new environment", async () => {
    await create();
    const first = parseEnvToMap(snapshotFor("db")!).POSTGRES_PASSWORD;
    inserts.length = 0;
    await create();

    expect(parseEnvToMap(snapshotFor("db")!).POSTGRES_PASSWORD).not.toBe(first);
  });

  it("snapshots nothing for skip", async () => {
    const result = await create();

    expect(snapshotFor("cdn")).toBeUndefined();
    expect(result.projectEnvironments.find((e) => e.appId === "web")?.envVarCount).toBe(6);
  });
});
