// Builder certificates over the key exchange: issued only while builds are accepted, renewed past half-life, refused otherwise.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { createCertAuthority, generateEd25519, issueCertificate, certInfo } from "@/lib/mesh/x509";

const HOUR = 3600_000;
const ca = createCertAuthority("vardo-mesh-builder CA", 24 * 365 * HOUR);
const peerKey = generateEd25519();

const state = vi.hoisted(() => ({ updates: [] as Record<string, unknown>[] }));

vi.mock("@/lib/db", () => ({
  db: { update: () => ({ set: (v: Record<string, unknown>) => ({ where: async () => void state.updates.push(v) }) }) },
}));
vi.mock("@/lib/mesh/builder-forward", () => ({ reconcileBuilderForward: async () => null }));
vi.mock("@/lib/mesh/builder-tls", async (orig) => ({
  ...(await orig<typeof import("@/lib/mesh/builder-tls")>()),
  builderCa: async () => ca,
  builderClientKey: async () => peerKey,
}));

const { builderOffer, peerBuilderColumns } = await import("@/lib/mesh/builder-exchange");
const { CLIENT_CERT_MS, needsReissue, issueClientCert } = await import("@/lib/mesh/builder-tls");

const running = async () => true;
const now = new Date("2026-10-17T08:00:00Z");
const peer = (over: Record<string, unknown> = {}) => ({ id: "p1", acceptBuilds: true, peerBuilderKey: peerKey.publicKey, builderCert: null as string | null, ...over });

beforeEach(() => {
  state.updates.length = 0;
});

describe("builderOffer", () => {
  it("issues a short-lived client certificate for the peer's key and stores it", async () => {
    const offer = await builderOffer(peer(), { now, running });
    expect(offer).toMatchObject({ port: 1234, ca: ca.cert });
    const info = certInfo(offer!.cert)!;
    expect(info.commonName).toBe("vardo-peer-p1");
    expect(info.notAfter.getTime() - now.getTime()).toBe(CLIENT_CERT_MS);
    expect(state.updates).toEqual([expect.objectContaining({ builderCert: offer!.cert })]);
  });

  it("keeps a certificate with more than half its life left", async () => {
    const cert = issueClientCert(ca, "p1", peerKey.publicKey, now);
    const offer = await builderOffer(peer({ builderCert: cert }), { now: new Date(now.getTime() + 2 * HOUR), running });
    expect(offer!.cert).toBe(cert);
    expect(state.updates).toEqual([]);
  });

  it("renews past half its life, and for a new key", async () => {
    const cert = issueClientCert(ca, "p1", peerKey.publicKey, now);
    const later = await builderOffer(peer({ builderCert: cert }), { now: new Date(now.getTime() + 4 * HOUR), running });
    expect(later!.cert).not.toBe(cert);
    const other = generateEd25519();
    expect(needsReissue(cert, ca.cert, other.publicKey, now)).toBe(true);
  });

  it("refuses once the link stops accepting builds, and forgets the certificate", async () => {
    const cert = issueClientCert(ca, "p1", peerKey.publicKey, now);
    expect(await builderOffer(peer({ acceptBuilds: false, builderCert: cert }), { now, running })).toBeNull();
    expect(state.updates).toEqual([expect.objectContaining({ builderCert: null })]);
  });

  it("refuses without a builder running here or a key from the peer", async () => {
    expect(await builderOffer(peer(), { now, running: async () => false })).toBeNull();
    expect(await builderOffer(peer({ peerBuilderKey: "ssh-ed25519 AAAA" }), { now, running })).toBeNull();
    expect(state.updates).toEqual([]);
  });
});

describe("peerBuilderColumns", () => {
  const cert = issueCertificate(ca, { publicKey: peerKey.publicKey, commonName: "x", usage: "client", validMs: HOUR });

  it("stores the peer's key and a builder whose certificate its CA signed", () => {
    expect(peerBuilderColumns({ builderKey: peerKey.publicKey, builder: { port: 1234, ca: ca.cert, cert } })).toEqual({
      peerBuilderKey: peerKey.publicKey, peerBuilderPort: 1234, peerBuilderCa: ca.cert, peerBuilderCert: cert,
    });
  });

  it("ignores a certificate from another CA, clears on null and leaves an older peer's columns alone", () => {
    const rogue = createCertAuthority("rogue", HOUR);
    expect(peerBuilderColumns({ builder: { port: 1234, ca: rogue.cert, cert } })).toEqual({});
    expect(peerBuilderColumns({ builderKey: null, builder: null })).toEqual({ peerBuilderKey: null, peerBuilderPort: null, peerBuilderCa: null, peerBuilderCert: null });
    expect(peerBuilderColumns({ sshKey: "x", acceptsBuilds: true })).toEqual({});
  });
});
