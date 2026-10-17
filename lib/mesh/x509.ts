// Minimal Ed25519 X.509: a CA and the certificates it signs for the mesh builder's TLS.

import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, sign, X509Certificate, type KeyObject } from "node:crypto";

export type KeyPair = { privateKey: string; publicKey: string };
export type CertAuthority = { key: string; cert: string };
export type CertUsage = "ca" | "server" | "client";

function len(n: number): Buffer {
  if (n < 0x80) return Buffer.from([n]);
  const bytes: number[] = [];
  for (let v = n; v > 0; v >>= 8) bytes.unshift(v & 0xff);
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

const tlv = (tag: number, ...parts: Buffer[]) => {
  const body = Buffer.concat(parts);
  return Buffer.concat([Buffer.from([tag]), len(body.length), body]);
};
const seq = (...parts: Buffer[]) => tlv(0x30, ...parts);
const set = (...parts: Buffer[]) => tlv(0x31, ...parts);
const explicit = (n: number, ...parts: Buffer[]) => tlv(0xa0 + n, ...parts);
const octets = (b: Buffer) => tlv(0x04, b);
const bits = (b: Buffer, unused = 0) => tlv(0x03, Buffer.from([unused]), b);
const bool = (v: boolean) => tlv(0x01, Buffer.from([v ? 0xff : 0]));
const utf8 = (s: string) => tlv(0x0c, Buffer.from(s, "utf8"));

function integer(b: Buffer): Buffer {
  let i = 0;
  while (i < b.length - 1 && b[i] === 0 && b[i + 1] < 0x80) i++;
  const v = b.subarray(i);
  return tlv(0x02, v[0] >= 0x80 ? Buffer.concat([Buffer.from([0]), v]) : v);
}

function oid(dotted: string): Buffer {
  const [a, b, ...rest] = dotted.split(".").map(Number);
  const out = [a * 40 + b];
  for (const n of rest) {
    const chunk = [n & 0x7f];
    for (let v = n >> 7; v > 0; v >>= 7) chunk.unshift(0x80 | (v & 0x7f));
    out.push(...chunk);
  }
  return tlv(0x06, Buffer.from(out));
}

function time(d: Date): Buffer {
  const iso = d.toISOString().replace(/[-:T]/g, "").slice(0, 14);
  return d.getUTCFullYear() < 2050 ? tlv(0x17, Buffer.from(`${iso.slice(2)}Z`)) : tlv(0x18, Buffer.from(`${iso}Z`));
}

const ED25519 = seq(oid("1.3.101.112"));
const name = (cn: string) => seq(set(seq(oid("2.5.4.10"), utf8("Vardo"))), set(seq(oid("2.5.4.3"), utf8(cn))));
const ext = (id: string, critical: boolean, value: Buffer) => seq(oid(id), ...(critical ? [bool(true)] : []), octets(value));

function ipBytes(ip: string): Buffer {
  const parts = ip.split(".").map(Number);
  if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) throw new Error(`Invalid IPv4 address: ${ip}`);
  return Buffer.from(parts);
}

function rawPublicKey(spki: Buffer): Buffer {
  return spki.subarray(spki.length - 32);
}

/** The key's SPKI PEM when it's an Ed25519 public key, else null. */
export function normalizeEd25519Spki(pem: unknown): string | null {
  if (typeof pem !== "string" || pem.length > 1024 || !pem.includes("BEGIN PUBLIC KEY")) return null;
  try {
    const key = createPublicKey(pem);
    return key.asymmetricKeyType === "ed25519" ? String(key.export({ type: "spki", format: "pem" })) : null;
  } catch {
    return null;
  }
}

export function generateEd25519(): KeyPair {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  return {
    privateKey: String(privateKey.export({ type: "pkcs8", format: "pem" })),
    publicKey: String(publicKey.export({ type: "spki", format: "pem" })),
  };
}

export type IssueOpts = {
  /** The subject's public key, SPKI PEM. */
  publicKey: string;
  commonName: string;
  usage: CertUsage;
  validMs: number;
  dnsNames?: string[];
  ips?: string[];
  now?: Date;
};

function tbsFor(opts: IssueOpts, issuer: { name: Buffer; keyId: Buffer }, subjectSpki: Buffer): Buffer {
  const now = opts.now ?? new Date();
  const notBefore = new Date(now.getTime() - 5 * 60_000);
  const notAfter = new Date(now.getTime() + opts.validMs);
  const keyId = createHash("sha1").update(rawPublicKey(subjectSpki)).digest();
  const extensions = [ext("2.5.29.14", false, octets(keyId)), ext("2.5.29.35", false, seq(tlv(0x80, issuer.keyId)))];
  if (opts.usage === "ca") {
    extensions.push(ext("2.5.29.19", true, seq(bool(true), integer(Buffer.from([0])))));
    extensions.push(ext("2.5.29.15", true, bits(Buffer.from([0x06]), 1)));
  } else {
    extensions.push(ext("2.5.29.19", true, seq()));
    extensions.push(ext("2.5.29.15", true, bits(Buffer.from([0x80]), 7)));
    extensions.push(ext("2.5.29.37", false, seq(oid(opts.usage === "server" ? "1.3.6.1.5.5.7.3.1" : "1.3.6.1.5.5.7.3.2"))));
    const sans = [...(opts.dnsNames ?? []).map((d) => tlv(0x82, Buffer.from(d, "ascii"))), ...(opts.ips ?? []).map((ip) => tlv(0x87, ipBytes(ip)))];
    if (sans.length > 0) extensions.push(ext("2.5.29.17", false, seq(...sans)));
  }
  const serial = randomBytes(16);
  serial[0] = (serial[0] & 0x7f) | 0x01;
  return seq(
    explicit(0, integer(Buffer.from([2]))),
    integer(serial),
    ED25519,
    issuer.name,
    seq(time(notBefore), time(notAfter)),
    name(opts.commonName),
    subjectSpki,
    explicit(3, seq(...extensions)),
  );
}

function toPem(der: Buffer): string {
  const b64 = der.toString("base64").match(/.{1,64}/g)!.join("\n");
  return `-----BEGIN CERTIFICATE-----\n${b64}\n-----END CERTIFICATE-----\n`;
}

function signCert(tbs: Buffer, key: KeyObject): string {
  return toPem(seq(tbs, ED25519, bits(sign(null, tbs, key))));
}

/** A new self-signed CA. */
export function createCertAuthority(commonName: string, validMs: number, now?: Date): CertAuthority {
  const pair = generateEd25519();
  const spki = Buffer.from(createPublicKey(pair.publicKey).export({ type: "spki", format: "der" }));
  const keyId = createHash("sha1").update(rawPublicKey(spki)).digest();
  const tbs = tbsFor({ publicKey: pair.publicKey, commonName, usage: "ca", validMs, now }, { name: name(commonName), keyId }, spki);
  return { key: pair.privateKey, cert: signCert(tbs, createPrivateKey(pair.privateKey)) };
}

/** A certificate for `opts.publicKey`, signed by `ca`. */
export function issueCertificate(ca: CertAuthority, opts: IssueOpts): string {
  if (opts.usage === "ca") throw new Error("Use createCertAuthority for a CA");
  const subject = normalizeEd25519Spki(opts.publicKey);
  if (!subject) throw new Error("The subject key isn't an Ed25519 public key");
  const caCert = new X509Certificate(ca.cert);
  const caSpki = Buffer.from(caCert.publicKey.export({ type: "spki", format: "der" }));
  const issuer = { name: subjectName(caCert), keyId: createHash("sha1").update(rawPublicKey(caSpki)).digest() };
  const spki = Buffer.from(createPublicKey(subject).export({ type: "spki", format: "der" }));
  return signCert(tbsFor(opts, issuer, spki), createPrivateKey(ca.key));
}

/** The DER subject Name of a certificate this module made. */
function subjectName(cert: X509Certificate): Buffer {
  const cn = cert.subject.split("\n").find((l) => l.startsWith("CN="))?.slice(3);
  if (!cn) throw new Error("The CA certificate has no common name");
  return name(cn);
}

export type CertInfo = { notAfter: Date; notBefore: Date; commonName: string | null; publicKey: string };

/** Validity and subject of a PEM certificate, or null when it doesn't parse. */
export function certInfo(pem: unknown): CertInfo | null {
  if (typeof pem !== "string" || pem.length > 8192) return null;
  try {
    const cert = new X509Certificate(pem);
    return {
      notAfter: new Date(cert.validTo),
      notBefore: new Date(cert.validFrom),
      commonName: cert.subject.split("\n").find((l) => l.startsWith("CN="))?.slice(3) ?? null,
      publicKey: String(cert.publicKey.export({ type: "spki", format: "pem" })),
    };
  } catch {
    return null;
  }
}

/** Whether `pem` was signed by `caPem` and is valid at `now`. */
export function issuedBy(pem: string, caPem: string, now = new Date()): boolean {
  try {
    const cert = new X509Certificate(pem);
    const ca = new X509Certificate(caPem);
    return cert.checkIssued(ca) && cert.verify(ca.publicKey) && new Date(cert.validFrom) <= now && now < new Date(cert.validTo);
  } catch {
    return false;
  }
}
