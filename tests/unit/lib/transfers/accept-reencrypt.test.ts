import { describe, it, expect, vi, beforeEach } from "vitest";

process.env.ENCRYPTION_MASTER_KEY ??= "b".repeat(64);

// ---------------------------------------------------------------------------
// Secrets are encrypted under a key derived from the org id. Accepting a
// transfer has to rewrite them under the destination org's key, for the app and
// its compose children, or the app arrives with env vars nobody can read.
// ---------------------------------------------------------------------------

const fake = vi.hoisted(() => {
  const state = {
    transfer: null as null | Record<string, unknown>,
    apps: [] as Record<string, unknown>[],
    children: [] as Record<string, unknown>[],
    envVars: [] as Record<string, unknown>[],
    deployments: [] as Record<string, unknown>[],
    environmentEnv: [] as Record<string, unknown>[],
    keyedApps: [] as Record<string, unknown>[],
    deployKeys: [] as Record<string, unknown>[],
    writes: [] as { table: string; values: Record<string, unknown> }[],
    inserts: [] as { table: string; values: Record<string, unknown> }[],
  };
  const tableName = (t: unknown) => (t as { [k: symbol]: string })[Symbol.for("drizzle:Name")];
  const query = {
    appTransfers: {
      findFirst: async () => state.transfer,
      findMany: async () => (state.transfer ? [state.transfer] : []),
    },
    apps: {
      findMany: async (opts: { columns?: Record<string, boolean> }) => {
        if (opts?.columns?.gitKeyId) return state.keyedApps;
        if (opts?.columns?.envContent) return state.apps;
        if (opts?.columns?.organizationId) return state.apps;
        if (opts?.columns?.id) return state.children;
        return [];
      },
      findFirst: async () => state.apps[0],
    },
    envVars: { findMany: async () => state.envVars },
    deployments: { findMany: async () => state.deployments },
    deployKeys: { findFirst: async () => state.deployKeys.shift() ?? null },
  };
  const update = (t: unknown) => ({
    set: (values: Record<string, unknown>) => {
      state.writes.push({ table: tableName(t), values });
      const where = () => {
        const p = Promise.resolve(undefined) as Promise<unknown> & { returning: () => Promise<unknown[]> };
        p.returning = async () => [{ id: "t-1" }];
        return p;
      };
      return { where };
    },
  });
  const insert = (t: unknown) => ({
    values: (values: Record<string, unknown>) => {
      state.inserts.push({ table: tableName(t), values });
      return { onConflictDoUpdate: () => ({ returning: async () => [{ id: "proj-dest" }] }) };
    },
  });
  const select = () => ({ from: () => ({ innerJoin: () => ({ where: async () => state.environmentEnv }) }) });
  const tx = { query, update, insert, select };
  const db = { ...tx, transaction: async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx) };
  return { state, db };
});

vi.mock("@/lib/db", () => ({ db: fake.db }));
vi.mock("@/lib/backups/transfer", () => ({
  releaseAppsFromOrgJobs: async () => ({ unlinked: 0, deletedJobIds: [] }),
  coverAppsInOrg: async () => [],
}));

import { acceptTransfer, repairTransferredSecrets } from "@/lib/transfers/engine";
import { encrypt, decrypt } from "@/lib/crypto/encrypt";

const SRC = "org-src";
const DEST = "org-dest";

function writesTo(table: string) {
  return fake.state.writes.filter((w) => w.table === table).map((w) => w.values);
}

function deployKey(orgId: string) {
  return { id: "key-src", organizationId: orgId, name: "gh", publicKey: "ssh-ed25519 AAA", privateKey: encrypt("PEM", orgId) };
}

describe("acceptTransfer", () => {
  beforeEach(() => {
    fake.state.writes.length = 0;
    fake.state.inserts.length = 0;
    fake.state.keyedApps = [];
    fake.state.deployKeys = [];
    fake.state.transfer = { id: "t-1", appId: "app-1", sourceOrgId: SRC, destinationOrgId: DEST, status: "pending" };
    fake.state.apps = [
      { id: "app-1", name: "web", envContent: encrypt("A=1", SRC) },
      { id: "child-1", name: "web-db", envContent: encrypt("B=2", SRC) },
    ];
    fake.state.children = [{ id: "child-1" }];
    fake.state.envVars = [
      { id: "v-1", key: "SECRET", value: encrypt("s3cret", SRC) },
      { id: "v-2", key: "PLAIN", value: "visible" },
    ];
    fake.state.deployments = [{ id: "d-1", envSnapshot: encrypt("A=0", SRC) }];
    fake.state.environmentEnv = [{ environmentId: "env-pr-7", name: "pr-7", envContent: encrypt("A=7", SRC) }];
  });

  it("re-encrypts a preview's own env", async () => {
    await acceptTransfer("t-1", "user-1");

    const env = writesTo("environment_env")[0].envContent as string;
    expect(decrypt(env, DEST)).toBe("A=7");
  });

  it("re-encrypts env content of the app and its compose children under the destination org's key", async () => {
    await acceptTransfer("t-1", "user-1");

    const env = writesTo("app").filter((v) => "envContent" in v).map((v) => v.envContent as string);
    expect(env.map((e) => decrypt(e, DEST)).sort()).toEqual(["A=1", "B=2"]);
  });

  it("re-encrypts secret env vars and leaves plaintext ones alone", async () => {
    await acceptTransfer("t-1", "user-1");

    const vars = writesTo("env_var");
    expect(vars).toHaveLength(1);
    expect(decrypt(vars[0].value as string, DEST)).toBe("s3cret");
  });

  it("moves the app's backup history to the destination org", async () => {
    await acceptTransfer("t-1", "user-1");

    expect(writesTo("backup")).toEqual([{ organizationId: DEST }]);
  });

  it("re-encrypts deployment env snapshots so rollback still works", async () => {
    await acceptTransfer("t-1", "user-1");

    const snap = writesTo("deployment")[0].envSnapshot as string;
    expect(decrypt(snap, DEST)).toBe("A=0");
  });

  it("gives the app a copy of its deploy key owned by the destination org", async () => {
    fake.state.keyedApps = [
      { id: "app-1", gitKeyId: "key-src" },
      { id: "child-1", gitKeyId: "key-src" },
    ];
    fake.state.deployKeys = [deployKey(SRC)];

    await acceptTransfer("t-1", "user-1");

    const copies = fake.state.inserts.filter((i) => i.table === "deploy_key").map((i) => i.values);
    expect(copies).toHaveLength(1);
    expect(copies[0]).toMatchObject({ organizationId: DEST, publicKey: "ssh-ed25519 AAA" });
    expect(decrypt(copies[0].privateKey as string, DEST)).toBe("PEM");
    const repointed = writesTo("app").filter((v) => "gitKeyId" in v).map((v) => v.gitKeyId);
    expect(repointed).toEqual([copies[0].id, copies[0].id]);
  });

  it("drops a deploy key it cannot read instead of failing the transfer", async () => {
    fake.state.keyedApps = [{ id: "app-1", gitKeyId: "key-src" }];
    fake.state.deployKeys = [{ ...deployKey(SRC), privateKey: encrypt("PEM", "some-other-org") }];

    await acceptTransfer("t-1", "user-1");

    expect(fake.state.inserts.some((i) => i.table === "deploy_key")).toBe(false);
    expect(writesTo("app").find((v) => "gitKeyId" in v)?.gitKeyId).toBeNull();
  });

  it("aborts before moving anything when a live secret cannot be read", async () => {
    fake.state.apps[0].envContent = encrypt("A=1", "some-other-org");

    await expect(acceptTransfer("t-1", "user-1")).rejects.toThrow(/cannot be decrypted/);
    expect(writesTo("app").some((v) => v.organizationId === DEST)).toBe(false);
  });
});

describe("repairTransferredSecrets", () => {
  beforeEach(() => {
    fake.state.writes.length = 0;
    fake.state.inserts.length = 0;
    fake.state.keyedApps = [];
    fake.state.deployKeys = [];
    fake.state.transfer = { appId: "app-1", sourceOrgId: SRC, status: "accepted" };
    fake.state.envVars = [];
    fake.state.deployments = [];
    fake.state.environmentEnv = [];
  });

  it("rewrites env stranded under the source org's key", async () => {
    fake.state.apps = [{ id: "app-1", organizationId: DEST, envContent: encrypt("A=1", SRC) }];

    expect(await repairTransferredSecrets()).toBe(1);
    expect(decrypt(writesTo("app")[0].envContent as string, DEST)).toBe("A=1");
  });

  it("copies a deploy key still owned by the source org", async () => {
    fake.state.apps = [{ id: "app-1", organizationId: DEST, envContent: null }];
    fake.state.keyedApps = [{ id: "app-1", gitKeyId: "key-src" }];
    fake.state.deployKeys = [deployKey(SRC)];

    expect(await repairTransferredSecrets()).toBe(1);
    const copy = fake.state.inserts.find((i) => i.table === "deploy_key")!.values;
    expect(decrypt(copy.privateKey as string, DEST)).toBe("PEM");
    expect(writesTo("app")[0].gitKeyId).toBe(copy.id);
  });

  it("leaves a deploy key the app's org already owns", async () => {
    fake.state.apps = [{ id: "app-1", organizationId: DEST, envContent: null }];
    fake.state.keyedApps = [{ id: "app-1", gitKeyId: "key-src" }];
    fake.state.deployKeys = [deployKey(DEST)];

    expect(await repairTransferredSecrets()).toBe(0);
    expect(fake.state.writes).toEqual([]);
  });

  it("leaves env the current org can already read", async () => {
    fake.state.apps = [{ id: "app-1", organizationId: DEST, envContent: encrypt("A=1", DEST) }];

    expect(await repairTransferredSecrets()).toBe(0);
    expect(fake.state.writes).toEqual([]);
  });
});
