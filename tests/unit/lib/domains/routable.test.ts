// Deploy-time gate (#891).

import { describe, it, expect, vi, beforeEach } from "vitest";

const { rows } = vi.hoisted(() => ({ rows: { proven: [] as { domain: string }[], zones: [] as string[] } }));

vi.mock("@/lib/domains/context", () => ({
  loadInstanceHosts: async () => ({ base: "vardo.test", console: ["console.vardo.test"] }),
  loadVerifiedZones: async () => rows.zones,
}));
vi.mock("@/lib/db", () => {
  const chain = { from: () => chain, innerJoin: () => chain, where: () => Promise.resolve(rows.proven) };
  return { db: { select: () => chain } };
});

import { splitRoutable } from "@/lib/domains/routable";

const org = { id: "o1", trusted: false };
const d = (domain: string, verifiedAt: Date | null = null) => ({ domain, verifiedAt });
const hosts = (list: { domain: string }[]) => list.map((r) => r.domain);

beforeEach(() => {
  rows.proven = [];
  rows.zones = [];
});

describe("splitRoutable", () => {
  it("drops an untrusted org's unverified domain and keeps the verified one", async () => {
    const out = await splitRoutable([d("a.com"), d("b.com", new Date()), d("x.vardo.test")], org);
    expect(hosts(out.routable)).toEqual(["b.com", "x.vardo.test"]);
    expect(hosts(out.dropped)).toEqual(["a.com"]);
  });

  it("lets an environment host borrow a verified domain row or a verified zone", async () => {
    rows.proven = [{ domain: "Env.a.com" }];
    rows.zones = ["b.com"];
    const out = await splitRoutable([d("env.a.com"), d("www.b.com"), d("c.com")], org);
    expect(hosts(out.routable)).toEqual(["env.a.com", "www.b.com"]);
  });

  it("routes trusted orgs but never the console host or the base domain", async () => {
    const out = await splitRoutable([d("a.com"), d("console.vardo.test"), d("vardo.test")], { ...org, trusted: true });
    expect(hosts(out.routable)).toEqual(["a.com"]);
  });

  it("leaves the system-managed org alone", async () => {
    const out = await splitRoutable([d("console.vardo.test")], { ...org, isSystemManaged: true });
    expect(out.dropped).toEqual([]);
  });
});
