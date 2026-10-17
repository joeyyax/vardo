// A peer that builds in the isolated builder loses its mesh SSH key; an older peer keeps it.

import { describe, it, expect, vi } from "vitest";

const state = vi.hoisted(() => ({ running: true }));
vi.mock("@/lib/db", () => ({
  db: {
    query: {
      meshPeers: {
        findMany: async () => [
          { id: "new", internalIp: "10.99.0.2", peerSshKey: "k1", builderCert: "-----BEGIN CERTIFICATE-----" },
          { id: "old", internalIp: "10.99.0.3", peerSshKey: "k2", builderCert: null },
        ],
      },
    },
  },
}));
vi.mock("@/lib/mesh/builder-tls", () => ({ meshBuilderRunning: async () => state.running }));

const { buildPeers } = await import("@/lib/mesh/ssh-endpoint");

describe("buildPeers", () => {
  it("keeps only peers without a builder certificate while the builder runs", async () => {
    expect((await buildPeers()).map((p) => p.id)).toEqual(["old"]);
  });

  it("keeps every accepted peer when the builder isn't running here", async () => {
    state.running = false;
    expect((await buildPeers()).map((p) => p.id)).toEqual(["new", "old"]);
  });
});
