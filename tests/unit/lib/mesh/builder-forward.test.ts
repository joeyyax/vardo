// The builder port's DNAT: one rule per peer it runs builds for, from that peer's tunnel address only.

import { describe, it, expect, vi } from "vitest";

vi.mock("@/lib/db", () => ({ db: {} }));

const { planBuilderDnat, staleMasquerades } = await import("@/lib/mesh/builder-forward");

const rule = (src: string, ip: string) => `-A PREROUTING -s ${src}/32 -i wg0 -p tcp -m tcp --dport 1234 -j DNAT --to-destination ${ip}:1234`;

describe("planBuilderDnat", () => {
  it("adds a rule per accepted peer address", () => {
    expect(planBuilderDnat("-P PREROUTING ACCEPT\n", "10.88.0.7", ["10.99.0.2", "10.99.0.5"])).toEqual([
      ["-t", "nat", "-A", "PREROUTING", "-s", "10.99.0.2/32", "-i", "wg0", "-p", "tcp", "--dport", "1234", "-j", "DNAT", "--to-destination", "10.88.0.7:1234"],
      ["-t", "nat", "-A", "PREROUTING", "-s", "10.99.0.5/32", "-i", "wg0", "-p", "tcp", "--dport", "1234", "-j", "DNAT", "--to-destination", "10.88.0.7:1234"],
    ]);
  });

  it("keeps current rules and drops a peer that no longer may build here", () => {
    const out = [rule("10.99.0.2", "10.88.0.7"), rule("10.99.0.5", "10.88.0.7")].join("\n");
    expect(planBuilderDnat(out, "10.88.0.7", ["10.99.0.2"])).toEqual([["-t", "nat", "-D", ...rule("10.99.0.5", "10.88.0.7").split(" ").slice(1)]]);
  });

  it("repoints rules at a moved builder and closes the port when it's gone", () => {
    const out = rule("10.99.0.2", "10.88.0.4");
    expect(planBuilderDnat(out, "10.88.0.7", ["10.99.0.2"]).map((a) => a[2])).toEqual(["-D", "-A"]);
    expect(planBuilderDnat(out, null, [])).toEqual([["-t", "nat", "-D", ...out.split(" ").slice(1)]]);
  });

  it("never matches a rule open to every source", () => {
    const open = "-A PREROUTING -i wg0 -p tcp -m tcp --dport 1234 -j DNAT --to-destination 10.88.0.7:1234";
    expect(planBuilderDnat(open, "10.88.0.7", ["10.99.0.2"]).map((a) => a[2])).toEqual(["-D", "-A"]);
  });
});

describe("staleMasquerades", () => {
  it("removes masquerades that point at another address", () => {
    const out = [
      "-A POSTROUTING -s 10.99.0.0/24 -d 10.88.0.4/32 -p tcp -m tcp --dport 1234 -j MASQUERADE",
      "-A POSTROUTING -s 10.99.0.0/24 -d 10.88.0.7/32 -p tcp -m tcp --dport 1234 -j MASQUERADE",
      "-A POSTROUTING -s 10.99.0.0/24 -d 10.88.0.4/32 -p tcp -m tcp --dport 443 -j MASQUERADE",
    ].join("\n");
    expect(staleMasquerades(out, "10.88.0.7").map((a) => a[7])).toEqual(["10.88.0.4/32"]);
  });
});
