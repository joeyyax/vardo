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
    writes: [] as { table: string; values: Record<string, unknown> }[],
  };
  const tableName = (t: unknown) => (t as { [k: symbol]: string })[Symbol.for("drizzle:Name")];
  const query = {
    appTransfers: {
      findFirst: async () => state.transfer,
      findMany: async () => (state.transfer ? [state.transfer] : []),
    },
    apps: {
      findMany: async (opts: { columns?: Record<string, boolean> }) => {
        if (opts?.columns?.envContent) return state.apps;
        if (opts?.columns?.organizationId) return state.apps;
        if (opts?.columns?.id) return state.children;
        return [];
      },
      findFirst: async () => state.apps[0],
    },
    envVars: { findMany: async () => state.envVars },
    deployments: { findMany: async () => state.deployments },
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
  const insert = () => ({
    values: () => ({ onConflictDoUpdate: () => ({ returning: async () => [{ id: "proj-dest" }] }) }),
  });
  const tx = { query, update, insert };
  const db = { ...tx, transaction: async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx) };
  return { state, db };
});

vi.mock("@/lib/db", () => ({ db: fake.db }));

import { acceptTransfer, repairTransferredSecrets } from "@/lib/transfers/engine";
import { encrypt, decrypt } from "@/lib/crypto/encrypt";

const SRC = "org-src";
const DEST = "org-dest";

function writesTo(table: string) {
  return fake.state.writes.filter((w) => w.table === table).map((w) => w.values);
}

describe("acceptTransfer", () => {
  beforeEach(() => {
    fake.state.writes.length = 0;
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

  it("re-encrypts deployment env snapshots so rollback still works", async () => {
    await acceptTransfer("t-1", "user-1");

    const snap = writesTo("deployment")[0].envSnapshot as string;
    expect(decrypt(snap, DEST)).toBe("A=0");
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
    fake.state.transfer = { appId: "app-1", sourceOrgId: SRC, status: "accepted" };
    fake.state.envVars = [];
    fake.state.deployments = [];
  });

  it("rewrites env stranded under the source org's key", async () => {
    fake.state.apps = [{ id: "app-1", organizationId: DEST, envContent: encrypt("A=1", SRC) }];

    expect(await repairTransferredSecrets()).toBe(1);
    expect(decrypt(writesTo("app")[0].envContent as string, DEST)).toBe("A=1");
  });

  it("leaves env the current org can already read", async () => {
    fake.state.apps = [{ id: "app-1", organizationId: DEST, envContent: encrypt("A=1", DEST) }];

    expect(await repairTransferredSecrets()).toBe(0);
    expect(fake.state.writes).toEqual([]);
  });
});
