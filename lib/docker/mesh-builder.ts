// A buildx builder for a linked instance's isolated BuildKit: the remote driver over TLS with this instance's client certificate.

import { chmod, mkdir, mkdtemp, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { execFileAsync } from "@/lib/utils/exec";
import type { MeshBuilderAccess } from "@/lib/mesh/build-peers";
import { MESH_BUILDER_CONTAINER } from "@/lib/mesh/constants";
import { dockerRequest } from "./client";
import { readContainerOomKills } from "./oom-counter";

/** The buildx builder registered per session against a peer's BuildKit. */
export const TARGET_BUILDER = "vardo-target";

const BOOTSTRAP_TIMEOUT = 60_000;

type Exec = (cmd: string, args: string[], opts: Record<string, unknown>) => Promise<{ stdout: string | Buffer }>;

/** `tcp://host:port` for the remote driver. */
export function builderEndpoint(access: Pick<MeshBuilderAccess, "host" | "port">): string {
  return `tcp://${access.host.includes(":") ? `[${access.host}]` : access.host}:${access.port}`;
}

/** The remote driver's TLS options for files in `dir`. */
export function builderDriverOpts(dir: string, serverName: string): string {
  return [`cacert=${join(dir, "ca.pem")}`, `cert=${join(dir, "cert.pem")}`, `key=${join(dir, "key.pem")}`, `servername=${serverName}`].join(",");
}

export type MeshBuilderSession = { env: { BUILDX_CONFIG: string; BUILDX_BUILDER: string }; close: () => Promise<void> };

/** Registers and bootstraps the peer's builder under a session-private buildx config. Throws when it can't be reached. */
export async function openMeshBuilder(
  access: MeshBuilderAccess,
  { exec = execFileAsync as unknown as Exec, signal, env = process.env }: { exec?: Exec; signal?: AbortSignal; env?: NodeJS.ProcessEnv } = {},
): Promise<MeshBuilderSession> {
  const dir = await mkdtemp(join(tmpdir(), "vardo-buildx-"));
  const close = () => rm(dir, { recursive: true, force: true }).catch(() => {});
  try {
    const tls = join(dir, "tls");
    await mkdir(tls, { mode: 0o700 });
    await writeFile(join(tls, "ca.pem"), access.ca, { mode: 0o600 });
    await writeFile(join(tls, "cert.pem"), access.cert, { mode: 0o600 });
    await writeFile(join(tls, "key.pem"), access.key, { mode: 0o600 });
    await chmod(join(tls, "key.pem"), 0o600);
    await exec(
      "docker",
      ["buildx", "create", "--name", TARGET_BUILDER, "--driver", "remote", "--driver-opt", builderDriverOpts(tls, access.serverName), "--bootstrap", builderEndpoint(access)],
      { env: { ...env, BUILDX_CONFIG: dir }, timeout: BOOTSTRAP_TIMEOUT, signal },
    );
    return { env: { BUILDX_CONFIG: dir, BUILDX_BUILDER: TARGET_BUILDER }, close };
  } catch (err) {
    await close();
    throw err;
  }
}

/** This host's isolated builder as a peer sees it: its OOM kills since it was created, and its memory limit in bytes. */
export type MeshBuilderStats = { oomKills: number | null; limitBytes: number | null };

/** This host's isolated builder's OOM kills and limit; nulls for what can't be read. */
export async function meshBuilderStats(
  { inspect = inspectBuilder, oomKills = readContainerOomKills }: { inspect?: typeof inspectBuilder; oomKills?: (id: string) => Promise<number | null> } = {},
): Promise<MeshBuilderStats> {
  const info = await inspect().catch(() => null);
  if (!info?.Id) return { oomKills: null, limitBytes: null };
  const limit = info.HostConfig?.Memory;
  return { oomKills: await oomKills(info.Id), limitBytes: typeof limit === "number" && limit > 0 ? limit : null };
}

function inspectBuilder(): Promise<{ Id?: string; HostConfig?: { Memory?: number } }> {
  return dockerRequest("GET", `/containers/${encodeURIComponent(MESH_BUILDER_CONTAINER)}/json`, undefined, { timeoutMs: 5_000 });
}

/** Throws unless the peer's builder accepts this instance's certificate. */
export async function probeMeshBuilder(access: MeshBuilderAccess, opts: { exec?: Exec; timeout?: number } = {}): Promise<void> {
  const signal = opts.timeout ? AbortSignal.timeout(opts.timeout) : undefined;
  const session = await openMeshBuilder(access, { exec: opts.exec, signal });
  await session.close();
}
