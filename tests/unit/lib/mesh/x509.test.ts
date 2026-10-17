// The builder's certificates: a CA, server and client certs Node and Go both accept, and nothing signed by another CA.

import { describe, it, expect } from "vitest";
import { X509Certificate } from "node:crypto";
import { certInfo, createCertAuthority, generateEd25519, issueCertificate, issuedBy, normalizeEd25519Spki } from "@/lib/mesh/x509";

const HOUR = 3600_000;
const ca = createCertAuthority("vardo-mesh-builder CA", 24 * HOUR);

describe("x509", () => {
  it("makes a self-signed CA that may only sign certificates", () => {
    const cert = new X509Certificate(ca.cert);
    expect(cert.ca).toBe(true);
    expect(cert.subject).toContain("CN=vardo-mesh-builder CA");
    expect(cert.verify(cert.publicKey)).toBe(true);
    expect(cert.keyUsage).toBeUndefined();
  });

  it("issues a server certificate for the builder's name", () => {
    const key = generateEd25519();
    const pem = issueCertificate(ca, { publicKey: key.publicKey, commonName: "vardo-mesh-builder", usage: "server", validMs: HOUR, dnsNames: ["vardo-mesh-builder"], ips: ["10.99.0.2"] });
    const cert = new X509Certificate(pem);
    expect(cert.ca).toBe(false);
    expect(cert.subjectAltName).toBe("DNS:vardo-mesh-builder, IP Address:10.99.0.2");
    expect(cert.checkHost("vardo-mesh-builder")).toBe("vardo-mesh-builder");
    expect(cert.keyUsage).toEqual(["1.3.6.1.5.5.7.3.1"]);
    expect(issuedBy(pem, ca.cert)).toBe(true);
  });

  it("issues a client certificate for a peer's key, valid only for its window", () => {
    const key = generateEd25519();
    const now = new Date("2026-10-17T08:00:00Z");
    const pem = issueCertificate(ca, { publicKey: key.publicKey, commonName: "vardo-peer-p1", usage: "client", validMs: 6 * HOUR, now });
    const info = certInfo(pem)!;
    expect(new X509Certificate(pem).keyUsage).toEqual(["1.3.6.1.5.5.7.3.2"]);
    expect(info.commonName).toBe("vardo-peer-p1");
    expect(normalizeEd25519Spki(info.publicKey)).toBe(key.publicKey);
    expect(info.notAfter.toISOString()).toBe("2026-10-17T14:00:00.000Z");
    expect(issuedBy(pem, ca.cert, new Date("2026-10-17T07:50:00Z"))).toBe(false);
    expect(issuedBy(pem, ca.cert, new Date("2026-10-17T13:59:00Z"))).toBe(true);
    expect(issuedBy(pem, ca.cert, new Date("2026-10-17T14:01:00Z"))).toBe(false);
  });

  it("refuses a certificate from another CA and a key that isn't Ed25519", () => {
    const other = createCertAuthority("rogue", HOUR);
    const pem = issueCertificate(other, { publicKey: generateEd25519().publicKey, commonName: "x", usage: "client", validMs: HOUR });
    expect(issuedBy(pem, ca.cert)).toBe(false);
    expect(normalizeEd25519Spki("-----BEGIN PUBLIC KEY-----\nnope\n-----END PUBLIC KEY-----\n")).toBeNull();
    expect(() => issueCertificate(ca, { publicKey: "ssh-ed25519 AAAA", commonName: "x", usage: "client", validMs: HOUR })).toThrow(/Ed25519/);
  });
});
