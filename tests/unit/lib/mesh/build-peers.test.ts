// A linked instance builds in its isolated builder once it sent a certificate for this instance's key, and waits until then.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { createCertAuthority, generateEd25519, issueCertificate } from "@/lib/mesh/x509";

const HOUR = 3600_000;
const peerCa = createCertAuthority("vardo-mesh-builder CA", 24 * HOUR);
const ours = generateEd25519();

const state = vi.hoisted(() => ({ rows: [] as Record<string, unknown>[] }));
vi.mock("@/lib/db", () => ({ db: { query: { meshPeers: { findMany: async () => state.rows } } } }));
vi.mock("@/lib/mesh/builder-tls", () => ({ builderClientKey: async () => ours }));

const { meshBuildPeers } = await import("@/lib/mesh/build-peers");

const cert = (publicKey = ours.publicKey, validMs = HOUR) => issueCertificate(peerCa, { publicKey, commonName: "vardo-peer-us", usage: "client", validMs });
const row = (over: Record<string, unknown> = {}) => ({
  id: "lh", name: "Long House", internalIp: "10.99.0.2", peerAcceptsBuilds: true,
  peerBuilderPort: null, peerBuilderCa: null, peerBuilderCert: null, ...over,
});

beforeEach(() => {
  state.rows = [];
});

describe("meshBuildPeers", () => {
  it("uses the peer's isolated builder once it certified this instance", async () => {
    state.rows = [row({ peerBuilderPort: 1234, peerBuilderCa: peerCa.cert, peerBuilderCert: cert() })];
    const [peer] = await meshBuildPeers();
    expect(peer.builder).toEqual({ host: "10.99.0.2", port: 1234, serverName: "vardo-mesh-builder", ca: peerCa.cert, cert: state.rows[0].peerBuilderCert, key: ours.privateKey });
    expect(peer.port).toBe(1234);
    expect(peer.waiting).toBeNull();
  });

  it("waits for a peer that sent no builder", async () => {
    state.rows = [row()];
    const [peer] = await meshBuildPeers();
    expect(peer.builder).toBeNull();
    expect(peer.port).toBe(1234);
    expect(peer.waiting).toBe("Long House hasn't offered its isolated builder yet");
  });

  it("waits when the builder certificate is for another key", async () => {
    state.rows = [row({ peerBuilderPort: 1234, peerBuilderCa: peerCa.cert, peerBuilderCert: cert(generateEd25519().publicKey) })];
    const [peer] = await meshBuildPeers();
    expect(peer.builder).toBeNull();
    expect(peer.waiting).toMatch(/builder certificate/);
  });

  it("offers nothing to a peer that doesn't accept builds from here", async () => {
    state.rows = [row({ peerAcceptsBuilds: false, peerBuilderPort: 1234, peerBuilderCa: peerCa.cert, peerBuilderCert: cert() })];
    const [peer] = await meshBuildPeers();
    expect(peer.builder).toBeNull();
    expect(peer.waiting).toBe("Long House doesn't accept builds from here");
  });
});
