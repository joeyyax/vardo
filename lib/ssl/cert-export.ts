// Gives an app read-only copies of its own domains' certificates from Traefik's ACME stores.
// The console reads the stores and writes only the qualifying certs into the app's own volume,
// so no app container ever sees acme.json.

import { spawn } from "child_process";
import { createHash, createPrivateKey, X509Certificate } from "crypto";
import { eq, isNotNull } from "drizzle-orm";
import { db } from "@/lib/db";
import { apps, domains, organizations } from "@/lib/db/schema";
import { loadInstanceHosts, loadVerifiedZones } from "@/lib/domains/context";
import { coveredByZone, isRoutable, refusedHost } from "@/lib/domains/ownership";
import { dockerEnv } from "@/lib/docker/docker-env";
import { resolveDefaultEnv } from "@/lib/docker/resolve-env";
import { volumePrefix } from "@/lib/docker/volume-prefix";
import { logger } from "@/lib/logger";

const log = logger.child("cert-export");

export const CERTS_MOUNT_PATH = "/certs";
/** Compose volume key; deploy externalizes it as `<app>-<env>_vardo-certs`. */
export const CERTS_VOLUME_KEY = "vardo-certs";

export function certsVolumeName(appName: string, envName: string): string {
  return `${volumePrefix(appName, envName)}_${CERTS_VOLUME_KEY}`;
}

const TRAEFIK_CONTAINER = () => process.env.VARDO_TRAEFIK_CONTAINER || "vardo-traefik";
const ACME_DIR = "/letsencrypt";
const HOST_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;

export type AcmeCert = { resolver: string; certificate: string; key: string };

type AcmeStore = Record<string, { Certificates?: { certificate?: string; key?: string }[] | null } | undefined>;

/** Certificates in one Traefik ACME store. Unreadable entries are skipped. */
export function parseAcmeStore(json: string): AcmeCert[] {
  let store: AcmeStore;
  try {
    store = JSON.parse(json) as AcmeStore;
  } catch {
    return [];
  }
  const out: AcmeCert[] = [];
  for (const [resolver, entry] of Object.entries(store ?? {})) {
    for (const c of entry?.Certificates ?? []) {
      if (!c?.certificate || !c.key) continue;
      out.push({
        resolver,
        certificate: Buffer.from(c.certificate, "base64").toString("utf8"),
        key: Buffer.from(c.key, "base64").toString("utf8"),
      });
    }
  }
  return out;
}

export type ExportedCert = { host: string; fullchain: string; privkey: string; notAfter: Date };

/** DNS names a certificate covers, from its SAN extension. */
function dnsNames(cert: X509Certificate): string[] {
  return (cert.subjectAltName ?? "")
    .split(/,\s*/)
    .filter((s) => s.startsWith("DNS:"))
    .map((s) => s.slice(4).toLowerCase());
}

/**
 * Certificates whose every name is in `eligible`, newest per host.
 * A wildcard, an expired cert or a key that doesn't match is never exported.
 */
export function selectCertificates(certs: AcmeCert[], eligible: Set<string>, now = new Date()): ExportedCert[] {
  const best = new Map<string, ExportedCert>();
  for (const c of certs) {
    let leaf: X509Certificate;
    try {
      leaf = new X509Certificate(c.certificate);
      if (!leaf.checkPrivateKey(createPrivateKey(c.key))) continue;
    } catch {
      continue;
    }
    const notAfter = new Date(leaf.validTo);
    if (notAfter <= now) continue;
    const names = dnsNames(leaf);
    if (names.length === 0) continue;
    if (!names.every((n) => !n.startsWith("*.") && eligible.has(n) && HOST_RE.test(n))) continue;
    for (const host of names) {
      const prev = best.get(host);
      if (!prev || prev.notAfter < notAfter) {
        best.set(host, { host, fullchain: c.certificate, privkey: c.key, notAfter });
      }
    }
  }
  return [...best.values()].sort((a, b) => a.host.localeCompare(b.host));
}

/**
 * Hosts whose certs the app may read: its own domain rows that pass #891.
 * Untrusted orgs need proof on the host itself; a free subdomain of the base domain doesn't count.
 */
export async function eligibleHosts(app: { id: string; organizationId: string }): Promise<Set<string>> {
  const [org] = await db
    .select({ trusted: organizations.trusted })
    .from(organizations)
    .where(eq(organizations.id, app.organizationId));
  const rows = await db
    .select({ domain: domains.domain, verifiedAt: domains.verifiedAt })
    .from(domains)
    .where(eq(domains.appId, app.id));
  const inst = await loadInstanceHosts();
  const zones = await loadVerifiedZones(app.organizationId);
  const trusted = org?.trusted ?? false;

  const hosts = new Set<string>();
  for (const row of rows) {
    const ok = trusted
      ? isRoutable(row, inst, { trusted }, zones)
      : !refusedHost(row.domain, inst) && (row.verifiedAt !== null || coveredByZone(row.domain, zones));
    if (ok) hosts.add(row.domain.toLowerCase());
  }
  return hosts;
}

/** Entries of a ustar archive, as `docker cp` writes it. PAX headers are skipped. */
export function readTar(buf: Buffer): { name: string; data: Buffer }[] {
  const out: { name: string; data: Buffer }[] = [];
  let off = 0;
  while (off + 512 <= buf.length) {
    const header = buf.subarray(off, off + 512);
    if (header.every((b) => b === 0)) break;
    const field = (start: number, len: number) => header.subarray(start, start + len).toString("utf8").split("\0")[0];
    const size = parseInt(field(124, 12).trim() || "0", 8);
    const type = field(156, 1);
    const prefix = field(345, 155);
    const name = prefix ? `${prefix}/${field(0, 100)}` : field(0, 100);
    const start = off + 512;
    if (type === "0" || type === "") out.push({ name, data: buf.subarray(start, start + size) });
    off = start + Math.ceil(size / 512) * 512;
  }
  return out;
}

function runDocker(args: string[], input?: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn("docker", args, { env: dockerEnv(), stdio: [input ? "pipe" : "ignore", "pipe", "pipe"] });
    const chunks: Buffer[] = [];
    let stderr = "";
    child.stdout!.on("data", (c: Buffer) => chunks.push(c));
    child.stderr!.on("data", (c) => {
      if (stderr.length < 2000) stderr += String(c);
    });
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0 ? resolve(Buffer.concat(chunks)) : reject(new Error(`docker ${args[0]} exited ${code}: ${stderr.trim()}`)),
    );
    if (input && child.stdin) child.stdin.end(input);
  });
}

/** Every certificate in Traefik's ACME stores. */
export async function readTraefikCertificates(): Promise<AcmeCert[]> {
  const tar = await runDocker(["cp", `${TRAEFIK_CONTAINER()}:${ACME_DIR}`, "-"]);
  return readTar(tar)
    .filter((e) => /(^|\/)acme-[^/]*\.json$/.test(e.name))
    .flatMap((e) => parseAcmeStore(e.data.toString("utf8")));
}

// Hosts arrive as positional parameters, never inside the script. Key first, so a reader never pairs a new chain with an old key for long.
const WRITE_SCRIPT = [
  "set -e",
  "umask 022",
  'h="$1"',
  'mkdir -p "/certs/$h"',
  // One base64 line each, so the shell's read takes exactly one file.
  "read -r chain",
  "read -r key",
  'printf "%s" "$chain" | base64 -d > "/certs/$h/.fullchain.tmp"',
  'printf "%s" "$key" | base64 -d > "/certs/$h/.privkey.tmp"',
  'mv -f "/certs/$h/.privkey.tmp" "/certs/$h/privkey.pem"',
  'mv -f "/certs/$h/.fullchain.tmp" "/certs/$h/fullchain.pem"',
].join("\n");

const PRUNE_SCRIPT = [
  "cd /certs",
  "for d in * .[!.]*; do",
  '  [ -e "$d" ] || continue',
  "  keep=0",
  '  for k in "$@"; do [ "$d" = "$k" ] && keep=1; done',
  '  [ "$keep" = 1 ] || rm -rf -- "$d"',
  "done",
].join("\n");

const written = new Map<string, string>();

function fingerprint(certs: ExportedCert[]): string {
  const h = createHash("sha256");
  for (const c of certs) h.update(c.host).update("\0").update(c.fullchain).update("\0").update(c.privkey).update("\0");
  return h.digest("hex");
}

/** Write the selected certs into a volume and remove any host no longer selected. Skips an unchanged set. */
export async function writeCertsToVolume(volume: string, certs: ExportedCert[]): Promise<boolean> {
  const print = fingerprint(certs);
  if (written.get(volume) === print) return false;
  const base = ["run", "--rm", "--network", "none", "-v", `${volume}:/certs`];
  for (const c of certs) {
    const input = Buffer.from(`${Buffer.from(c.fullchain).toString("base64")}\n${Buffer.from(c.privkey).toString("base64")}\n`);
    await runDocker([...base, "-i", "alpine", "sh", "-c", WRITE_SCRIPT, "sh", c.host], input);
  }
  await runDocker([...base, "alpine", "sh", "-c", PRUNE_SCRIPT, "sh", ...certs.map((c) => c.host)]);
  written.set(volume, print);
  return true;
}

/** Bring one app's cert volume up to date. Returns the hosts it now holds, or null when the app has it off. */
export async function syncAppCerts(appId: string, logFn: (msg: string) => void = (m) => log.info(m)): Promise<string[] | null> {
  const app = await db.query.apps.findFirst({
    where: eq(apps.id, appId),
    columns: { id: true, name: true, organizationId: true, certServices: true },
  });
  if (!app?.certServices?.length) return null;
  const env = await resolveDefaultEnv(app.id);
  const volume = certsVolumeName(app.name, env.name);

  const eligible = await eligibleHosts(app);
  const selected = selectCertificates(await readTraefikCertificates(), eligible);
  await runDocker(["volume", "create", volume]);
  if (await writeCertsToVolume(volume, selected)) {
    logFn(
      selected.length > 0
        ? `[certs] ${app.name}: ${selected.map((c) => c.host).join(", ")} at ${CERTS_MOUNT_PATH}`
        : `[certs] ${app.name}: no issued certificate covers only this app's verified domains yet`,
    );
  }
  return selected.map((c) => c.host);
}

/** Every opted-in app. Errors are logged per app. */
export async function syncAllCerts(): Promise<void> {
  const rows = await db.select({ id: apps.id, name: apps.name }).from(apps).where(isNotNull(apps.certServices));
  for (const row of rows) {
    try {
      await syncAppCerts(row.id);
    } catch (err) {
      log.warn(`${row.name}: ${err instanceof Error ? err.message : err}`);
    }
  }
}

let timer: NodeJS.Timeout | null = null;

/** Picks up renewals. Traefik renews 30 days out, so ten minutes is plenty. */
export function startCertExportScheduler(intervalMs = 10 * 60_000): void {
  if (timer) return;
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await syncAllCerts();
    } catch (err) {
      log.warn(`sync failed: ${err instanceof Error ? err.message : err}`);
    } finally {
      running = false;
    }
  };
  timer = setInterval(tick, intervalMs);
  void tick();
}
