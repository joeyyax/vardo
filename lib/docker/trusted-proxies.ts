// Traefik's web and websecure entrypoints trust X-Forwarded-* from Cloudflare's ranges (#902) and VARDO_TRUSTED_PROXIES.
// Entrypoints are static config, so a changed list is applied by recreating Traefik.

import { readFile, realpath } from "fs/promises";
import { dirname, join } from "path";
import { cloudflareTrustEnabled, trustedProxyRanges } from "@/lib/cloudflare-ips";
import { dockerRequest } from "@/lib/docker/client";
import { dockerEnv } from "@/lib/docker/docker-env";
import { GLOBAL_ENV_PATH } from "@/lib/docker/self-env";
import { writeEnvKey } from "@/lib/env/write-env-key";
import { logger } from "@/lib/logger";
import { resolveVardoComposeFile } from "@/lib/paths";
import { execFileAsync } from "@/lib/utils/exec";

const log = logger.child("trusted-proxies");

/** Interpolated into Traefik's command in docker-compose.yml; unset means the bundled ranges. */
export const TRUSTED_IPS_KEY = "VARDO_TRAEFIK_TRUSTED_IPS";

export const ENTRYPOINTS = ["web", "websecure"] as const;

const RECREATE_TIMEOUT_MS = 120_000;

type Env = Record<string, string | undefined>;

/** The value Traefik's entrypoints should carry: Cloudflare's ranges unless opted out, plus VARDO_TRUSTED_PROXIES. */
export function desiredTrustedIps(ranges: readonly string[], env: Env = process.env): string {
  const cloudflare = cloudflareTrustEnabled(env) ? ranges : [];
  return [...new Set([...cloudflare, ...trustedProxyRanges(env)])].join(",");
}

/** Each entrypoint's trustedIPs from Traefik's command line. A missing flag reads as empty. */
export function runningTrustedIps(args: readonly string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const ep of ENTRYPOINTS) {
    const prefix = `--entrypoints.${ep}.forwardedheaders.trustedips=`;
    const arg = [...args].reverse().find((a) => a.toLowerCase().startsWith(prefix));
    out[ep] = arg ? arg.slice(prefix.length) : "";
  }
  return out;
}

function sameList(a: string, b: string): boolean {
  const norm = (s: string) => [...new Set(s.split(",").map((x) => x.trim()).filter(Boolean))].sort().join(",");
  return norm(a) === norm(b);
}

export type TraefikContainer = { args: string[]; project?: string; service?: string };

async function inspectTraefik(): Promise<TraefikContainer | null> {
  const name = process.env.VARDO_TRAEFIK_CONTAINER || "vardo-traefik";
  try {
    const info = await dockerRequest<{ Args?: string[]; Config?: { Cmd?: string[]; Labels?: Record<string, string> } }>(
      "GET",
      `/containers/${encodeURIComponent(name)}/json`,
    );
    const labels = info.Config?.Labels ?? {};
    return {
      args: info.Config?.Cmd ?? info.Args ?? [],
      project: labels["com.docker.compose.project"],
      service: labels["com.docker.compose.service"],
    };
  } catch {
    return null;
  }
}

async function recreateTraefik(composeFile: string, project: string, service: string, value: string): Promise<void> {
  await execFileAsync(
    "docker",
    ["compose", "-p", project, "-f", composeFile, "up", "-d", "--no-deps", "--pull", "never", service],
    { env: dockerEnv({ [TRUSTED_IPS_KEY]: value }), timeout: RECREATE_TIMEOUT_MS },
  );
}

/** The global .env and the one compose reads beside the compose file, once each. */
async function envFiles(composeFile: string): Promise<string[]> {
  const paths = [GLOBAL_ENV_PATH, join(dirname(composeFile), ".env")];
  const seen = new Map<string, string>();
  for (const p of paths) seen.set(await realpath(p).catch(() => p), p);
  return [...seen.values()];
}

export type TrustedIpsDeps = {
  inspect: () => Promise<TraefikContainer | null>;
  composeFile: () => string;
  readCompose: (path: string) => Promise<string>;
  envFiles: (composeFile: string) => Promise<string[]>;
  writeEnv: (path: string, key: string, value: string) => Promise<void>;
  recreate: (composeFile: string, project: string, service: string, value: string) => Promise<void>;
};

const defaultDeps: TrustedIpsDeps = {
  inspect: inspectTraefik,
  composeFile: resolveVardoComposeFile,
  readCompose: (p) => readFile(p, "utf-8"),
  envFiles,
  writeEnv: writeEnvKey,
  recreate: recreateTraefik,
};

// One recreate per value per process, so a compose that ignores the key can't restart Traefik daily.
const attempted = new Set<string>();

export type TrustedIpsOutcome = "unchanged" | "recreated" | "skipped" | "failed";

/** Recreates Traefik when its entrypoints trust a different list than the desired one. */
export async function syncTraefikTrustedIps(opts: {
  ranges: readonly string[];
  env?: Env;
  deps?: Partial<TrustedIpsDeps>;
  attempts?: Set<string>;
}): Promise<TrustedIpsOutcome> {
  const deps = { ...defaultDeps, ...opts.deps };
  const attempts = opts.attempts ?? attempted;
  const desired = desiredTrustedIps(opts.ranges, opts.env);

  const traefik = await deps.inspect();
  if (!traefik) return "skipped";
  const running = runningTrustedIps(traefik.args);
  if (ENTRYPOINTS.every((ep) => sameList(running[ep], desired))) return "unchanged";

  if (!traefik.project || !traefik.service) {
    log.warn("Traefik's trusted IPs are out of date, but it wasn't started by compose; leaving it alone");
    return "skipped";
  }
  const composeFile = deps.composeFile();
  const compose = await deps.readCompose(composeFile).catch(() => "");
  if (!compose.includes(TRUSTED_IPS_KEY)) {
    log.warn(`Traefik's trusted IPs are out of date, but ${composeFile} doesn't set them; leaving it alone`);
    return "skipped";
  }
  if (attempts.has(desired)) return "skipped";
  attempts.add(desired);

  try {
    for (const path of await deps.envFiles(composeFile)) await deps.writeEnv(path, TRUSTED_IPS_KEY, desired);
    log.info(`Recreating Traefik: its entrypoints' trusted IPs changed (${desired ? desired.split(",").length : 0} ranges)`);
    await deps.recreate(composeFile, traefik.project, traefik.service, desired);
  } catch (err) {
    log.error("Couldn't apply Traefik's trusted IPs:", err);
    return "failed";
  }
  return "recreated";
}
