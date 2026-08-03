// ---------------------------------------------------------------------------
// Backfill for the log viewer: the last N lines of an app, from Loki when it
// is available and `docker compose logs` otherwise.
// ---------------------------------------------------------------------------

import { spawn } from "child_process";
import { resolve } from "path";
import { readlink } from "fs/promises";
import { appEnvDir, appBaseDir } from "@/lib/paths";
import { isLokiAvailable, queryRange, buildLogQLQuery, requireTenant } from "./client";
import { interleaveByTimestamp, parseComposeLine, type ServiceLine } from "./compose-lines";

export type ComposeTarget = {
  slotDir: string;
  composePath: string;
  composeProject: string;
};

/** Locate the compose file and project name of an app's active slot. */
export async function resolveComposeTarget(
  appName: string,
  environmentName: string,
): Promise<ComposeTarget> {
  let appDir = appEnvDir(appName, environmentName);
  let activeSlot = "blue";
  try {
    activeSlot = (await readlink(resolve(appDir, "current"))).trim();
  } catch {
    appDir = appBaseDir(appName);
    try {
      activeSlot = (await readlink(resolve(appDir, "current"))).trim();
    } catch { /* default to blue */ }
  }

  const envAware = appDir.endsWith(environmentName);
  return {
    slotDir: resolve(appDir, activeSlot),
    composePath: resolve(appDir, activeSlot, "docker-compose.yml"),
    composeProject: envAware
      ? `${appName}-${environmentName}-${activeSlot}`
      : `${appName}-${activeSlot}`,
  };
}

export type HistoryOptions = {
  tail: number;
  /** Compose service to scope to. Null reads every service in the stack. */
  service?: string | null;
  /** Tag each line with its service. Only worth it for a multi-service stack. */
  prefixed?: boolean;
  search?: string;
};

const COMPOSE_TIMEOUT_MS = 15_000;

/** Read the tail of an app's container logs through docker compose. */
export async function readComposeHistory(
  target: ComposeTarget,
  { tail, service, prefixed }: HistoryOptions,
): Promise<ServiceLine[]> {
  const args = [
    "compose",
    "-f", target.composePath,
    "-p", target.composeProject,
    "logs",
    "--no-color",
    "--tail", String(tail),
    ...(prefixed && !service ? ["--timestamps"] : ["--no-log-prefix", ...(service ? [service] : [])]),
  ];

  const output = await new Promise<string>((done) => {
    const proc = spawn("docker", args, { cwd: target.slotDir });
    let buffer = "";
    const timer = setTimeout(() => proc.kill(), COMPOSE_TIMEOUT_MS);

    proc.stdout.on("data", (chunk: Buffer) => { buffer += chunk.toString(); });
    proc.stderr.on("data", (chunk: Buffer) => { buffer += chunk.toString(); });
    proc.on("error", () => { clearTimeout(timer); done(buffer); });
    proc.on("close", () => { clearTimeout(timer); done(buffer); });
  });

  const lines = output.split("\n").filter(Boolean);
  if (service || !prefixed) return lines.map((text) => ({ text }));
  return interleaveByTimestamp(lines.map(parseComposeLine));
}

/** Windows tried in turn — an idle service has nothing to say in the last hour. */
const LOOKBACK_MS = [3_600_000, 86_400_000, 7 * 86_400_000, 30 * 86_400_000];

/** Read the tail of an app's logs from Loki, widening the window until something turns up. */
export async function readLokiHistory(opts: {
  project: string;
  organizationId: string;
  environment?: string;
  service?: string | null;
  prefixed?: boolean;
  search?: string;
  tail: number;
}): Promise<ServiceLine[]> {
  const query = buildLogQLQuery({
    project: opts.project,
    environment: opts.environment,
    service: opts.service ?? undefined,
    search: opts.search,
  });

  for (const window of LOOKBACK_MS) {
    const entries = await queryRange({
      query,
      organizationId: opts.organizationId,
      start: String((Date.now() - window) * 1_000_000),
      limit: opts.tail,
      direction: "backward",
    });
    if (entries.length === 0) continue;

    return entries
      .sort((a, b) => a.timestamp.padStart(20, "0").localeCompare(b.timestamp.padStart(20, "0")))
      .map((entry) => ({
        text: entry.line,
        service: opts.prefixed ? entry.labels.service : undefined,
      }));
  }

  return [];
}

export type HistoryResult = {
  source: "loki" | "docker";
  lines: ServiceLine[];
};

/**
 * Backfill for one app. `project` is the compose project name — the parent's
 * name for a decomposed service — and `service` scopes it to one container.
 */
export async function readLogHistory(opts: {
  project: string;
  organizationId: string;
  environment: string;
  service?: string | null;
  prefixed?: boolean;
  search?: string;
  tail: number;
}): Promise<HistoryResult> {
  // Checked before the try below, which would otherwise swallow it and read
  // the containers instead of saying the tenant was missing.
  requireTenant(opts.organizationId);

  if (await isLokiAvailable()) {
    try {
      const lines = await readLokiHistory(opts);
      if (lines.length > 0) return { source: "loki", lines };
    } catch { /* fall through to the container itself */ }
  }

  const target = await resolveComposeTarget(opts.project, opts.environment);
  const lines = await readComposeHistory(target, {
    tail: opts.tail,
    service: opts.service,
    prefixed: opts.prefixed,
  });
  return { source: "docker", lines };
}
