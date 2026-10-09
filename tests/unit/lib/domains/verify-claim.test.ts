// runCheck evicts squatters in the same transaction that records the proof (#897).

import { describe, it, expect, vi, beforeEach } from "vitest";

const { state } = vi.hoisted(() => ({
  state: {
    loaded: { domain: "acme.com", token: "vardo-t", verifiedAt: null as Date | null, orgId: "owner" },
    log: [] as string[],
    claims: [] as { orgId: string; host: string; zone: boolean }[],
    evicted: [] as unknown[],
  },
}));

vi.mock("@/lib/domains/claim", () => ({
  evictSquatters: async (tx: { inTx?: boolean }, claim: { orgId: string; host: string; zone: boolean }) => {
    state.log.push(tx.inTx ? "evict:tx" : "evict:no-tx");
    state.claims.push(claim);
    return [{ id: "x", domain: claim.host, appId: "a9", appName: "squat", orgId: "squatter" }];
  },
  notifyEvicted: (rows: unknown[]) => {
    state.log.push("notify");
    state.evicted = rows;
  },
}));
vi.mock("@/lib/db", () => {
  const make = (inTx: boolean) => {
    const chain = {
      from: () => chain,
      innerJoin: () => chain,
      where: () => Promise.resolve([{ ...state.loaded, organizationId: state.loaded.orgId, verificationToken: state.loaded.token, baseDomain: state.loaded.domain, baseDomainToken: state.loaded.token, baseDomainVerifiedAt: state.loaded.verifiedAt, id: state.loaded.orgId, appId: "a1" }]),
    };
    return {
      inTx,
      select: () => chain,
      update: () => ({ set: () => ({ where: async () => { state.log.push(inTx ? "save:tx" : "save:no-tx"); } }) }),
    };
  };
  const plain = make(false);
  return {
    db: {
      ...plain,
      transaction: async <T>(fn: (tx: unknown) => Promise<T>) => {
        state.log.push("begin");
        const out = await fn(make(true));
        state.log.push("commit");
        return out;
      },
    },
  };
});

import { runCheck } from "@/lib/domains/verify";

const found = (token: string) => async () => [[token]];

beforeEach(() => {
  state.loaded = { domain: "acme.com", token: "vardo-t", verifiedAt: null, orgId: "owner" };
  state.log = [];
  state.claims = [];
  state.evicted = [];
});

describe("runCheck eviction", () => {
  it("verifies, evicts and commits in one transaction, then notifies", async () => {
    const out = await runCheck({ kind: "app-domain", id: "d1" }, { resolveTxt: found("vardo-t") });
    expect(out?.verifiedAt).toBeInstanceOf(Date);
    expect(state.log[0]).toBe("begin");
    expect(state.log).toContain("evict:tx");
    expect(state.log.slice(-2)).toEqual(["commit", "notify"]);
    expect(state.log).not.toContain("save:no-tx");
    expect(state.claims).toEqual([{ orgId: "owner", host: "acme.com", zone: false }]);
  });

  it("claims the whole zone for an org domain or base domain", async () => {
    await runCheck({ kind: "org-domain", id: "z1" }, { resolveTxt: found("vardo-t") });
    await runCheck({ kind: "org-base", id: "owner" }, { resolveTxt: found("vardo-t") });
    expect(state.claims.map((c) => c.zone)).toEqual([true, true]);
  });

  it("evicts later squatters on a recheck of an already verified row", async () => {
    state.loaded.verifiedAt = new Date("2026-01-01");
    await runCheck({ kind: "app-domain", id: "d1" }, { resolveTxt: found("vardo-t") });
    expect(state.log).toEqual(["begin", "evict:tx", "commit", "notify"]);
  });

  it("evicts nothing when the record is missing or the lookup fails", async () => {
    await runCheck({ kind: "app-domain", id: "d1" }, { resolveTxt: found("other") });
    await runCheck({ kind: "app-domain", id: "d1" }, {
      resolveTxt: async () => { throw Object.assign(new Error("x"), { code: "ETIMEOUT" }); },
    });
    expect(state.claims).toEqual([]);
    expect(state.log).not.toContain("notify");
  });
});
