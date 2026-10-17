// The isolated builder's TLS: this instance's builder CA, its client key for peers' builders and the files in its container.

import { execFile } from "node:child_process";
import { db } from "@/lib/db";
import { systemSettings } from "@/lib/db/schema";
import { encryptSystem } from "@/lib/crypto/encrypt";
import { getSystemSettingRaw, invalidateSettingsCache } from "@/lib/system-settings";
import { execFileAsync } from "@/lib/utils/exec";
import { redactError } from "@/lib/redact";
import { dockerEnv } from "@/lib/docker/docker-env";
import { MESH_BUILDER_CONTAINER, MESH_BUILDER_SERVER_NAME, MESH_BUILDER_TLS_DIR } from "./constants";
import {
  certInfo,
  createCertAuthority,
  generateEd25519,
  issueCertificate,
  issuedBy,
  normalizeEd25519Spki,
  type CertAuthority,
  type KeyPair,
} from "./x509";

export const BUILDER_CA_SETTING = "mesh_builder_ca";
export const BUILDER_CLIENT_KEY_SETTING = "mesh_builder_client_key";

const YEAR_MS = 365 * 24 * 3600_000;
const CA_MS = 10 * YEAR_MS;
const SERVER_MS = YEAR_MS;
/** How long a peer's client certificate lasts; it's reissued past half of it. */
export const CLIENT_CERT_MS = 6 * 3600_000;
/** A server certificate with less than this left is replaced. */
const SERVER_RENEW_MS = 30 * 24 * 3600_000;

function parseCa(raw: string | null): CertAuthority | null {
  if (!raw) return null;
  try {
    const ca = JSON.parse(raw) as Partial<CertAuthority>;
    if (typeof ca.key !== "string" || typeof ca.cert !== "string" || !certInfo(ca.cert)) return null;
    return { key: ca.key, cert: ca.cert };
  } catch {
    return null;
  }
}

function parseKey(raw: string | null): KeyPair | null {
  if (!raw) return null;
  try {
    const k = JSON.parse(raw) as Partial<KeyPair>;
    const publicKey = normalizeEd25519Spki(k.publicKey);
    if (!publicKey || typeof k.privateKey !== "string" || !k.privateKey.includes("PRIVATE KEY")) return null;
    return { privateKey: k.privateKey, publicKey };
  } catch {
    return null;
  }
}

/** A system setting created on first use. The console and worker can race; the first write wins. */
async function storedOnce<T>(key: string, parse: (raw: string | null) => T | null, make: () => T): Promise<T> {
  const existing = parse(await getSystemSettingRaw(key));
  if (existing) return existing;
  await db
    .insert(systemSettings)
    .values({ key, value: encryptSystem(JSON.stringify(make())) })
    .onConflictDoNothing({ target: systemSettings.key });
  invalidateSettingsCache(key);
  const stored = parse(await getSystemSettingRaw(key));
  if (!stored) throw new Error(`Couldn't store ${key}`);
  return stored;
}

/** This instance's builder CA. */
export function builderCa(): Promise<CertAuthority> {
  return storedOnce(BUILDER_CA_SETTING, parseCa, () => createCertAuthority(`${MESH_BUILDER_SERVER_NAME} CA`, CA_MS));
}

/** This instance's key for peers' builders; each peer signs a certificate for it. */
export function builderClientKey(): Promise<KeyPair> {
  return storedOnce(BUILDER_CLIENT_KEY_SETTING, parseKey, generateEd25519);
}

/** Whether `cert` should be replaced: missing, not from `ca`, for another key, or past half its life. */
export function needsReissue(cert: string | null | undefined, caCert: string, publicKey: string, now = new Date()): boolean {
  if (!cert || !issuedBy(cert, caCert, now)) return true;
  const info = certInfo(cert)!;
  if (normalizeEd25519Spki(info.publicKey) !== normalizeEd25519Spki(publicKey)) return true;
  const life = info.notAfter.getTime() - info.notBefore.getTime();
  return info.notAfter.getTime() - now.getTime() < life / 2;
}

/** A client certificate for a peer's builder key. */
export function issueClientCert(ca: CertAuthority, peerId: string, publicKey: string, now?: Date): string {
  return issueCertificate(ca, { publicKey, commonName: `vardo-peer-${peerId}`, usage: "client", validMs: CLIENT_CERT_MS, now });
}

const RUNNING_TTL_MS = 30_000;
const globalForBuilder = globalThis as unknown as { __vardo_mesh_builder?: { at: number; running: boolean } };

/** Whether the builder container runs here. */
export async function meshBuilderRunning(): Promise<boolean> {
  const cached = globalForBuilder.__vardo_mesh_builder;
  if (cached && Date.now() - cached.at < RUNNING_TTL_MS) return cached.running;
  const running = await execFileAsync("docker", ["inspect", "-f", "{{.State.Running}}", MESH_BUILDER_CONTAINER], { env: dockerEnv(), timeout: 10_000 })
    .then(({ stdout }) => String(stdout).trim() === "true", () => false);
  globalForBuilder.__vardo_mesh_builder = { at: Date.now(), running };
  return running;
}

type Exec = (args: string[], input?: string) => Promise<string>;

const dockerExec: Exec = (args, input) =>
  new Promise((resolve, reject) => {
    const child = execFile("docker", args, { env: dockerEnv(), timeout: 15_000 }, (err, stdout) => (err ? reject(redactError(err)) : resolve(String(stdout))));
    if (input !== undefined) child.stdin?.end(input);
  });

/** Writes `content` to a file in the builder's TLS directory. */
function writeTls(exec: Exec, file: string, content: string): Promise<string> {
  const path = `${MESH_BUILDER_TLS_DIR}/${file}`;
  return exec(["exec", "-i", MESH_BUILDER_CONTAINER, "sh", "-c", `umask 077 && mkdir -p ${MESH_BUILDER_TLS_DIR} && cat > ${path}.tmp && mv -f ${path}.tmp ${path}`], content);
}

/**
 * Gives the builder this instance's CA and a server certificate from it. It starts listening once they're there;
 * a replaced set restarts it. "absent" when the builder isn't running here.
 */
export async function syncBuilderTls({ exec = dockerExec, now = new Date() }: { exec?: Exec; now?: Date } = {}): Promise<"written" | "unchanged" | "absent"> {
  let haveCa: string;
  let haveCert: string;
  try {
    [haveCa, haveCert] = (await exec(["exec", MESH_BUILDER_CONTAINER, "sh", "-c", `cat ${MESH_BUILDER_TLS_DIR}/ca.pem 2>/dev/null; echo '#'; cat ${MESH_BUILDER_TLS_DIR}/cert.pem 2>/dev/null; true`])).split("#\n");
  } catch (err) {
    if (/No such container|is not running/i.test(String((err as Error)?.message ?? err))) return "absent";
    throw err;
  }
  const ca = await builderCa();
  const certOk = haveCa === ca.cert && issuedBy(haveCert ?? "", ca.cert, now) && certInfo(haveCert)!.notAfter.getTime() - now.getTime() > SERVER_RENEW_MS;
  if (certOk) return "unchanged";

  const server = generateEd25519();
  const cert = issueCertificate(ca, { publicKey: server.publicKey, commonName: MESH_BUILDER_SERVER_NAME, usage: "server", validMs: SERVER_MS, dnsNames: [MESH_BUILDER_SERVER_NAME], now });
  const listening = haveCa.trim() !== "";
  await writeTls(exec, "key.pem", server.privateKey);
  await writeTls(exec, "cert.pem", cert);
  await writeTls(exec, "ca.pem", ca.cert);
  // buildkitd reads its TLS files once, at start.
  if (listening) await exec(["restart", MESH_BUILDER_CONTAINER]);
  return "written";
}
