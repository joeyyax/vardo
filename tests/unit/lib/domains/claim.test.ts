// Eviction of other orgs' unverified rows when a host is proved (#897).

import { describe, it, expect, vi, beforeEach } from "vitest";

type Row = {
  id: string;
  domain: string;
  appId: string;
  appName: string;
  orgId: string;
  verifiedAt: Date | null;
  trusted: boolean;
  isSystemManaged: boolean;
};

const { state } = vi.hoisted(() => ({
  state: {
    rows: [] as Row[],
    zones: {} as Record<string, string[]>,
    deleted: 0,
    redeployed: 0,
    log: [] as string[],
    emitted: [] as { orgId: string; event: Record<string, unknown> }[],
  },
}));

vi.mock("@/lib/domains/context", () => ({
  loadInstanceHosts: async () => ({ base: "vardo.test", console: ["console.vardo.test"] }),
  loadVerifiedZones: async (orgId: string) => state.zones[orgId] ?? [],
}));
vi.mock("@/lib/notifications/dispatch", () => ({
  emit: (orgId: string, event: Record<string, unknown>) => {
    state.log.push("notify");
    state.emitted.push({ orgId, event });
  },
}));
vi.mock("@/lib/db", () => {
  const chain = { from: () => chain, innerJoin: () => chain, where: () => Promise.resolve(state.rows) };
  const exec = {
    select: () => chain,
    delete: () => ({ where: async () => { state.deleted++; state.log.push("delete"); } }),
    update: () => ({ set: () => ({ where: async () => { state.redeployed++; state.log.push("redeploy"); } }) }),
    insert: () => ({ values: () => ({ returning: async () => { state.log.push("insert"); return [{ id: "new" }]; } }) }),
  };
  return {
    db: {
      ...exec,
      transaction: async <T>(fn: (tx: typeof exec) => Promise<T>) => {
        state.log.push("begin");
        const out = await fn(exec);
        state.log.push("commit");
        return out;
      },
    },
  };
});

import { evictSquatters, hostHoldByOtherOrg, notifyEvicted, withClaim } from "@/lib/domains/claim";
import { db } from "@/lib/db";

const row = (over: Partial<Row>): Row => ({
  id: "d1",
  domain: "acme.com",
  appId: "a1",
  appName: "web",
  orgId: "squatter",
  verifiedAt: null,
  trusted: false,
  isSystemManaged: false,
  ...over,
});
const claim = { orgId: "owner", host: "acme.com", zone: false };
type Tx = Parameters<typeof evictSquatters>[0];

beforeEach(() => {
  state.rows = [];
  state.zones = {};
  state.deleted = 0;
  state.redeployed = 0;
  state.log = [];
  state.emitted = [];
});

describe("evictSquatters", () => {
  it("deletes an untrusted org's unverified row and flags its app to redeploy", async () => {
    state.rows = [row({})];
    const out = await evictSquatters(db as unknown as Tx, claim);
    expect(out).toEqual([{ id: "d1", domain: "acme.com", appId: "a1", appName: "web", orgId: "squatter" }]);
    expect(state.log).toEqual(["delete", "redeploy"]);
  });

  it("never evicts verified rows", async () => {
    state.rows = [row({ verifiedAt: new Date() })];
    expect(await evictSquatters(db as unknown as Tx, claim)).toEqual([]);
    expect(state.deleted).toBe(0);
  });

  it("leaves rows that route for their org: trusted, system-managed, under the instance base or in its verified zone", async () => {
    state.rows = [
      row({ id: "t", trusted: true }),
      row({ id: "s", isSystemManaged: true }),
      row({ id: "b", domain: "app.vardo.test" }),
      row({ id: "z", orgId: "zoned", domain: "www.acme.com" }),
    ];
    state.zones = { zoned: ["acme.com"] };
    expect(await evictSquatters(db as unknown as Tx, { ...claim, zone: true })).toEqual([]);
    expect(state.deleted).toBe(0);
  });
});

describe("hostHoldByOtherOrg", () => {
  it("is free with no other rows, claimable when every row is evictable, taken otherwise", async () => {
    expect(await hostHoldByOtherOrg("acme.com", "owner")).toBe("free");
    state.rows = [row({})];
    expect(await hostHoldByOtherOrg("acme.com", "owner")).toBe("claimable");
    state.rows = [row({}), row({ id: "d2", verifiedAt: new Date() })];
    expect(await hostHoldByOtherOrg("acme.com", "owner")).toBe("taken");
  });
});

describe("notifyEvicted", () => {
  it("sends one domain-claimed event per affected org", () => {
    notifyEvicted([
      { id: "1", domain: "acme.com", appId: "a1", appName: "web", orgId: "o1" },
      { id: "2", domain: "www.acme.com", appId: "a1", appName: "web", orgId: "o1" },
      { id: "3", domain: "acme.com", appId: "a2", appName: "api", orgId: "o2" },
    ]);
    expect(state.emitted.map((e) => e.orgId)).toEqual(["o1", "o2"]);
    expect(state.emitted[0].event).toMatchObject({
      type: "security.domain-claimed",
      domains: ["acme.com", "www.acme.com"],
      appIds: ["a1"],
    });
    expect(String(state.emitted[1].event.message)).toContain("acme.com (api)");
  });
});

describe("withClaim", () => {
  it("evicts, writes and commits before notifying", async () => {
    state.rows = [row({})];
    await withClaim(claim, (exec) => exec.insert({} as never).values({} as never).returning());
    expect(state.log).toEqual(["begin", "delete", "redeploy", "insert", "commit", "notify"]);
  });

  it("writes without a transaction when there's nothing to claim", async () => {
    await withClaim(null, (exec) => exec.insert({} as never).values({} as never).returning());
    expect(state.log).toEqual(["insert"]);
  });
});
