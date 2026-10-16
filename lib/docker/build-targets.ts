// Build targets: Docker hosts beside this one that builds overflow to, in order. Off when none are set.

import { access, chmod, constants, mkdir, mkdtemp, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { delimiter, join } from "path";
import { getSystemSettingRaw, setSystemSetting } from "@/lib/system-settings";
import { execFileAsync } from "@/lib/utils/exec";
import { dockerEnv } from "./docker-env";

export const BUILD_TARGETS_SETTING = "build_targets";

export const MAX_TARGET_BUILDS = 16;

/** A Docker daemon reached over SSH. `kind` leaves room for targets started on demand. */
export type BuildTarget = {
  id: string;
  kind: "ssh";
  name: string;
  host: string;
  port: number;
  user: string;
  privateKey: string;
  /** known_hosts lines pinned on the first test; null until then. */
  hostKey: string | null;
  maxConcurrent: number;
};

const HOSTNAME = /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*$/i;
const IPV4 = /^\d{1,3}(?:\.\d{1,3}){3}$/;
const IPV6 = /^[0-9a-f:]+$/i;
const USER = /^[a-z_][a-z0-9_.-]{0,31}$/i;

export function isValidTargetHost(host: string): boolean {
  return host.length <= 253 && (HOSTNAME.test(host) || IPV4.test(host) || (host.includes(":") && IPV6.test(host)));
}

export function isValidTargetUser(user: string): boolean {
  return USER.test(user);
}

function parseTarget(raw: unknown): BuildTarget | null {
  const t = raw as Partial<BuildTarget> | null;
  if (!t || typeof t.id !== "string" || typeof t.host !== "string" || typeof t.user !== "string") return null;
  if (!isValidTargetHost(t.host) || !isValidTargetUser(t.user) || typeof t.privateKey !== "string") return null;
  const port = Number(t.port ?? 22);
  const max = Number(t.maxConcurrent ?? 1);
  return {
    id: t.id,
    kind: "ssh",
    name: typeof t.name === "string" && t.name ? t.name : t.host,
    host: t.host,
    port: Number.isInteger(port) && port > 0 && port < 65536 ? port : 22,
    user: t.user,
    privateKey: t.privateKey,
    hostKey: typeof t.hostKey === "string" && t.hostKey.trim() ? t.hostKey : null,
    maxConcurrent: Number.isInteger(max) ? Math.min(Math.max(max, 0), MAX_TARGET_BUILDS) : 1,
  };
}

/** Targets in overflow order, decrypted. */
export async function getBuildTargets(): Promise<BuildTarget[]> {
  const raw = await getSystemSettingRaw(BUILD_TARGETS_SETTING);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as { targets?: unknown[] };
    return (parsed.targets ?? []).map(parseTarget).filter((t): t is BuildTarget => t !== null);
  } catch {
    return [];
  }
}

/** Saves the targets encrypted, private keys included. */
export async function setBuildTargets(targets: BuildTarget[]): Promise<void> {
  await setSystemSetting(BUILD_TARGETS_SETTING, targets.length > 0 ? JSON.stringify({ targets }) : "");
}

/** `ssh://user@host:port` for DOCKER_HOST. */
export function targetDockerHost(target: Pick<BuildTarget, "user" | "host" | "port">): string {
  const host = target.host.includes(":") ? `[${target.host}]` : target.host;
  return `ssh://${target.user}@${host}:${target.port}`;
}

/** How the deploy log names a target. */
export function describeTarget(target: Pick<BuildTarget, "name" | "user" | "host" | "port">): string {
  return `${target.name} (${targetDockerHost(target).slice("ssh://".length)})`;
}

/** ssh_config for a session: this key and pinned host key only, never a prompt. */
export function sshConfig(dir: string): string {
  const q = (p: string) => `"${p}"`;
  return [
    "Host *",
    `  IdentityFile ${q(join(dir, "id"))}`,
    "  IdentitiesOnly yes",
    `  UserKnownHostsFile ${q(join(dir, "known_hosts"))}`,
    "  GlobalKnownHostsFile /dev/null",
    "  StrictHostKeyChecking yes",
    "  BatchMode yes",
    "  ConnectTimeout 10",
    "  ServerAliveInterval 15",
    "  ServerAliveCountMax 4",
    "",
  ].join("\n");
}

/** The real `ssh` on PATH. */
async function findSsh(path = process.env.PATH ?? ""): Promise<string> {
  for (const dir of path.split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, "ssh");
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch { /* next */ }
  }
  throw new BuilderError("no ssh client on this server (install openssh-client)");
}

export type DockerSession = {
  /** Merged into a docker CLI child's env; never into process.env. */
  env: Record<string, string>;
  close: () => Promise<void>;
};

/**
 * Temp key, pinned known_hosts and an `ssh` wrapper that reads them, first on PATH.
 * The docker CLI runs `ssh` for `ssh://` hosts, so the wrapper carries the key.
 */
export async function openSshSession(target: BuildTarget): Promise<DockerSession> {
  if (!target.hostKey) throw new BuilderError(`${target.name} has no pinned host key; test it in settings first`);
  const ssh = await findSsh();
  const dir = await mkdtemp(join(tmpdir(), "vardo-ssh-"));
  try {
    const key = target.privateKey.endsWith("\n") ? target.privateKey : `${target.privateKey}\n`;
    await writeFile(join(dir, "id"), key, { mode: 0o600 });
    await chmod(join(dir, "id"), 0o600);
    await writeFile(join(dir, "known_hosts"), `${target.hostKey.trim()}\n`, { mode: 0o600 });
    await writeFile(join(dir, "config"), sshConfig(dir), { mode: 0o600 });
    const bin = join(dir, "bin");
    await mkdir(bin, { mode: 0o700 });
    await writeFile(join(bin, "ssh"), `#!/bin/sh\nexec "${ssh}" -F "${join(dir, "config")}" "$@"\n`, { mode: 0o700 });
    await chmod(join(bin, "ssh"), 0o700);
    return {
      env: { DOCKER_HOST: targetDockerHost(target), PATH: [bin, process.env.PATH ?? ""].join(delimiter) },
      close: () => rm(dir, { recursive: true, force: true }).catch(() => {}),
    };
  } catch (err) {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
    throw err;
  }
}

/** `base` pointed at the session's daemon, without settings that would send the build to this host's builder. */
export function remoteEnv(base: NodeJS.ProcessEnv, session: DockerSession): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base, ...session.env };
  for (const key of ["DOCKER_CONTEXT", "BUILDX_BUILDER", "BUILDKIT_HOST", "DOCKER_TLS_VERIFY", "DOCKER_CERT_PATH"]) delete env[key];
  return env;
}

/** A failure of the builder, not the app: unreachable, SSH refused, out of disk. The build retries locally. */
export class BuilderError extends Error {
  constructor(
    readonly reason: string,
    readonly cause?: unknown,
  ) {
    super(reason);
    this.name = "BuilderError";
  }
}

const BUILDER_FAILURES: [RegExp, string][] = [
  [/Host key verification failed|REMOTE HOST IDENTIFICATION HAS CHANGED/i, "its SSH host key doesn't match the pinned one"],
  [/Permission denied \(publickey|Too many authentication failures/i, "SSH refused the key"],
  [/Could not resolve hostname|Name or service not known/i, "its hostname doesn't resolve"],
  [/ssh: connect to host|Connection (?:refused|timed out)|Operation timed out|No route to host|Network is unreachable|kex_exchange_identification/i, "it's unreachable"],
  [/Connection (?:reset|closed)|Broken pipe|error during connect|commandconn|dial-stdio|transport is closing|rpc error: code = Unavailable|error reading from server: EOF/i, "the connection to it dropped"],
  [/Cannot connect to the Docker daemon|docker: (?:command )?not found|docker: No such file/i, "its Docker daemon isn't answering"],
  [/no space left on device|disk quota exceeded/i, "it's out of disk"],
];

/** Why a remote build's error is the builder's fault, or null when it's the app's. */
export function builderFailureReason(message: string): string | null {
  for (const [pattern, reason] of BUILDER_FAILURES) if (pattern.test(message)) return reason;
  return null;
}

function errorText(err: unknown): string {
  const e = err as { stderr?: unknown; message?: unknown };
  return [typeof e?.message === "string" ? e.message : String(err), typeof e?.stderr === "string" ? e.stderr : ""].join("\n");
}

/** Runs `run` against the target's daemon; a builder-caused failure comes out as a BuilderError. */
export async function onTarget<T>(
  target: BuildTarget,
  run: (session: DockerSession) => Promise<T>,
  open: (target: BuildTarget) => Promise<DockerSession> = openSshSession,
): Promise<T> {
  const session = await open(target).catch((err) => {
    throw err instanceof BuilderError ? err : new BuilderError(`couldn't set up SSH: ${errorText(err).split("\n")[0]}`, err);
  });
  try {
    return await run(session);
  } catch (err) {
    if (err instanceof BuilderError) throw err;
    const reason = builderFailureReason(errorText(err));
    throw reason ? new BuilderError(reason, err) : err;
  } finally {
    await session.close();
  }
}

const HEALTH_TIMEOUT = 8_000;
const HEALTH_TTL_MS = 30_000;

/** The target's Docker server version; throws when it can't be reached. */
export async function targetDockerVersion(target: BuildTarget, timeout = HEALTH_TIMEOUT): Promise<string> {
  return onTarget(target, async (session) => {
    const { stdout } = await execFileAsync("docker", ["version", "--format", "{{.Server.Version}}"], {
      env: remoteEnv(dockerEnv(), session),
      timeout,
    });
    return String(stdout).trim();
  });
}

const health = new Map<string, { at: number; ok: boolean }>();
const inflight = new Map<string, Promise<boolean>>();

function healthKey(t: BuildTarget): string {
  return `${t.id}|${targetDockerHost(t)}|${t.hostKey ?? ""}`;
}

/** Whether a target answered lately. The first call waits for a check; a stale result refreshes in the background. */
export async function isTargetReady(
  target: BuildTarget,
  check: (t: BuildTarget) => Promise<unknown> = targetDockerVersion,
): Promise<boolean> {
  if (!target.hostKey || target.maxConcurrent < 1) return false;
  const key = healthKey(target);
  const entry = health.get(key);
  if (entry && Date.now() - entry.at < HEALTH_TTL_MS) return entry.ok;
  let pending = inflight.get(key);
  if (!pending) {
    pending = check(target).then(() => true, () => false).then((ok) => {
      health.set(key, { at: Date.now(), ok });
      inflight.delete(key);
      return ok;
    });
    inflight.set(key, pending);
  }
  return entry ? entry.ok : pending;
}

/** Marks a target down until its next check, as after a builder failure. */
export function markTargetDown(target: BuildTarget): void {
  health.set(healthKey(target), { at: Date.now(), ok: false });
}

/** Test hook. */
export function resetTargetHealth(): void {
  health.clear();
  inflight.clear();
}

/** `ssh-keyscan` lines for a host, in known_hosts form. */
export async function scanHostKey(host: string, port: number): Promise<string> {
  const { stdout } = await execFileAsync("ssh-keyscan", ["-T", "5", "-p", String(port), "--", host], { timeout: 15_000 });
  const lines = String(stdout).split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
  if (lines.length === 0) throw new Error(`${host}:${port} offered no SSH host key`);
  return lines.join("\n");
}

/** SHA256 fingerprints of known_hosts lines, as `ssh-keygen -l` prints them. */
export async function hostKeyFingerprints(hostKey: string): Promise<string[]> {
  const dir = await mkdtemp(join(tmpdir(), "vardo-kh-"));
  try {
    const file = join(dir, "known_hosts");
    await writeFile(file, `${hostKey.trim()}\n`, { mode: 0o600 });
    const { stdout } = await execFileAsync("ssh-keygen", ["-l", "-f", file], { timeout: 10_000 });
    return String(stdout).split("\n").map((l) => l.trim()).filter(Boolean)
      .map((l) => {
        const [, fp, type] = l.match(/^\d+\s+(\S+)\s+.*\s+\((\w+)\)$/) ?? [];
        return fp ? `${fp} (${type})` : l;
      });
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/** Configured targets that can take a build, in order. */
export async function configuredTargets(): Promise<BuildTarget[]> {
  return (await getBuildTargets().catch(() => [])).filter((t) => t.hostKey && t.maxConcurrent > 0);
}
