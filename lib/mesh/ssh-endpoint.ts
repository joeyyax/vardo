// This instance's side of mesh SSH: its client key, the endpoint's host key and which peers it lets in.

import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { meshPeers, systemSettings } from "@/lib/db/schema";
import { encryptSystem } from "@/lib/crypto/encrypt";
import { getSystemSettingRaw, invalidateSettingsCache } from "@/lib/system-settings";
import { execFileAsync } from "@/lib/utils/exec";
import { redactError } from "@/lib/redact";
import { dockerEnv } from "@/lib/docker/docker-env";
import { ownMeshAddress } from "./heartbeat";
import { MESH_SSH_CONTAINER } from "./constants";
import { meshBuilderRunning } from "./builder-tls";

export const CLIENT_KEY_SETTING = "mesh_ssh_client_key";

/** The command every peer key is forced to. */
export const DIAL_STDIO = "docker system dial-stdio";

const KEY_DIR = "/etc/ssh/vardo";
const AUTHORIZED_KEYS = `${KEY_DIR}/authorized_keys`;
const HOST_KEY_PUB = `${KEY_DIR}/ssh_host_ed25519_key.pub`;

const ED25519 = /^ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAI[A-Za-z0-9+/]{43}$/;
const PEER_ID = /^[A-Za-z0-9_-]{1,64}$/;

/** `ssh-ed25519 <base64>` from a public key line, without its comment; null for anything else. */
export function normalizeEd25519(line: unknown): string | null {
  if (typeof line !== "string" || line.length > 512) return null;
  const [type, blob] = line.trim().split(/\s+/);
  const key = `${type} ${blob}`;
  return ED25519.test(key) ? key : null;
}

export type ClientKey = { privateKey: string; publicKey: string };

function parseClientKey(raw: string | null): ClientKey | null {
  if (!raw) return null;
  try {
    const k = JSON.parse(raw) as Partial<ClientKey>;
    const publicKey = normalizeEd25519(k.publicKey);
    if (!publicKey || typeof k.privateKey !== "string" || !k.privateKey.includes("PRIVATE KEY")) return null;
    return { privateKey: k.privateKey, publicKey };
  } catch {
    return null;
  }
}

/** A new ed25519 keypair from ssh-keygen. */
export async function generateClientKey(): Promise<ClientKey> {
  const dir = await mkdtemp(join(tmpdir(), "vardo-meshkey-"));
  try {
    const file = join(dir, "id");
    await execFileAsync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-C", "vardo-mesh", "-f", file], { timeout: 15_000 });
    const publicKey = normalizeEd25519(await readFile(`${file}.pub`, "utf8"));
    if (!publicKey) throw new Error("ssh-keygen wrote an unexpected public key");
    return { privateKey: await readFile(file, "utf8"), publicKey };
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/** This instance's SSH client key for peers' endpoints, created on first use. */
export async function meshClientKey(): Promise<ClientKey> {
  const existing = parseClientKey(await getSystemSettingRaw(CLIENT_KEY_SETTING));
  if (existing) return existing;
  const fresh = await generateClientKey();
  // The console and worker can race here; the first write wins.
  await db
    .insert(systemSettings)
    .values({ key: CLIENT_KEY_SETTING, value: encryptSystem(JSON.stringify(fresh)) })
    .onConflictDoNothing({ target: systemSettings.key });
  invalidateSettingsCache(CLIENT_KEY_SETTING);
  const stored = parseClientKey(await getSystemSettingRaw(CLIENT_KEY_SETTING));
  if (!stored) throw new Error("Couldn't store the mesh SSH client key");
  return stored;
}

const HOST_KEY_TTL_MS = 60_000;
const globalForHostKey = globalThis as unknown as { __vardo_mesh_host_key?: { at: number; key: string | null } };

/** The endpoint's host key as its container reports it, or null when it isn't running. */
export async function meshSshHostKey(): Promise<string | null> {
  const cached = globalForHostKey.__vardo_mesh_host_key;
  if (cached && Date.now() - cached.at < HOST_KEY_TTL_MS) return cached.key;
  let key: string | null = null;
  try {
    const { stdout } = await execFileAsync("docker", ["exec", MESH_SSH_CONTAINER, "cat", HOST_KEY_PUB], { env: dockerEnv(), timeout: 10_000 });
    key = normalizeEd25519(stdout);
  } catch {
    key = null;
  }
  globalForHostKey.__vardo_mesh_host_key = { at: Date.now(), key };
  return key;
}

/** Test hook. */
export function resetHostKeyCache(): void {
  globalForHostKey.__vardo_mesh_host_key = undefined;
}

export type KeyedPeer = { id: string; internalIp: string; peerSshKey: string | null };

/** authorized_keys for `peers`: each key only from its tunnel address and only for dial-stdio. */
export function renderAuthorizedKeys(peers: KeyedPeer[]): string {
  const lines = ["# Managed by Vardo: linked instances that run builds here. Each key runs only docker system dial-stdio."];
  for (const peer of [...peers].sort((a, b) => a.id.localeCompare(b.id))) {
    const key = normalizeEd25519(peer.peerSshKey);
    const ip = ownMeshAddress(peer.internalIp);
    if (!key || !ip || !PEER_ID.test(peer.id)) continue;
    lines.push(`from="${ip}",restrict,command="${DIAL_STDIO}" ${key} vardo-peer-${peer.id}`);
  }
  return `${lines.join("\n")}\n`;
}

/** Direct peers this instance runs builds for over SSH: those without a certificate for the running builder. */
export async function buildPeers(): Promise<KeyedPeer[]> {
  const rows = await db.query.meshPeers.findMany({
    where: and(eq(meshPeers.connectionType, "direct"), eq(meshPeers.acceptBuilds, true)),
    columns: { id: true, internalIp: true, peerSshKey: true, builderCert: true },
  });
  const builder = rows.some((r) => r.builderCert) && (await meshBuilderRunning());
  return rows.filter((r) => !(builder && r.builderCert)).map(({ id, internalIp, peerSshKey }) => ({ id, internalIp, peerSshKey }));
}

function writeInContainer(content: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      "docker",
      ["exec", "-i", MESH_SSH_CONTAINER, "sh", "-c", `umask 022 && cat > ${AUTHORIZED_KEYS}.tmp && mv -f ${AUTHORIZED_KEYS}.tmp ${AUTHORIZED_KEYS}`],
      { env: dockerEnv(), timeout: 15_000 },
      (err) => (err ? reject(redactError(err)) : resolve()),
    );
    child.stdin?.end(content);
  });
}

/** Rewrites the endpoint's authorized_keys from the database. "absent" when the endpoint isn't running here. */
export async function syncAuthorizedKeys(peers?: KeyedPeer[]): Promise<"written" | "unchanged" | "absent"> {
  const want = renderAuthorizedKeys(peers ?? (await buildPeers()));
  let have: string;
  try {
    ({ stdout: have } = await execFileAsync("docker", ["exec", MESH_SSH_CONTAINER, "cat", AUTHORIZED_KEYS], { env: dockerEnv(), timeout: 10_000 }));
  } catch (err) {
    const text = String((err as { stderr?: string })?.stderr ?? (err as Error)?.message ?? err);
    if (/No such container|is not running/i.test(text)) return "absent";
    have = "";
  }
  if (have === want) return "unchanged";
  await writeInContainer(want);
  return "written";
}
