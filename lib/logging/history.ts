// Log viewer backfill from VictoriaLogs, or `docker compose logs` when it can't serve the app.

import { spawn } from "child_process";
import { resolve } from "path";
import { readlink } from "fs/promises";
import { appEnvDir, appBaseDir } from "@/lib/paths";
import { FIELD, buildLogsQLQuery, queryLogs } from "./victorialogs";
import { logAccountId } from "./account";
import { appLogSource, type LogSource } from "./source";
import { interleaveByTimestamp, parseComposeLine, type ServiceLine } from "./compose-lines";
import { dockerEnv } from "@/lib/docker/docker-env";
import { slotEnvFileArgs } from "@/lib/docker/slot-files";

export type ComposeTarget = {
  slotDir: string;
  composePath: string;
  composeProject: string;
  /** The slot's --env-file arguments, so compose interpolates Vardo's variables. */
  envFileArgs: string[];
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
  const slotDir = resolve(appDir, activeSlot);
  return {
    slotDir,
    composePath: resolve(appDir, activeSlot, "docker-compose.yml"),
    composeProject: envAware
      ? `${appName}-${environmentName}-${activeSlot}`
      : `${appName}-${activeSlot}`,
    envFileArgs: await slotEnvFileArgs(slotDir),
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
    ...target.envFileArgs,
    "-p", target.composeProject,
    "logs",
    "--no-color",
    "--tail", String(tail),
    ...(prefixed && !service ? ["--timestamps"] : ["--no-log-prefix", ...(service ? [service] : [])]),
  ];

  const output = await new Promise<string>((done) => {
    const proc = spawn("docker", args, { env: dockerEnv(), cwd: target.slotDir });
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
export const LOOKBACK_MS = [3_600_000, 86_400_000, 7 * 86_400_000, 30 * 86_400_000];

/** Read the tail of an app's logs from VictoriaLogs, widening the window until something turns up. */
export async function readStoredHistory(opts: {
  project: string;
  organizationId: string;
  environment?: string;
  service?: string | null;
  prefixed?: boolean;
  search?: string;
  tail: number;
}): Promise<ServiceLine[]> {
  const query = buildLogsQLQuery({
    project: opts.project,
    environment: opts.environment,
    service: opts.service ?? undefined,
    search: opts.search,
  });

  for (const window of LOOKBACK_MS) {
    const entries = await queryLogs({
      query,
      organizationId: opts.organizationId,
      start: new Date(Date.now() - window),
      limit: opts.tail,
    });
    if (entries.length === 0) continue;

    return entries.map((entry) => ({
      text: entry.line,
      service: opts.prefixed ? entry.labels[FIELD.service] : undefined,
    }));
  }

  return [];
}

export type HistoryResult = {
  source: LogSource;
  lines: ServiceLine[];
};

/** Backfill for one app. `project` is the compose project; `service` scopes it to one container. */
export async function readLogHistory(opts: {
  project: string;
  /** App id the project's containers carry. */
  projectId: string;
  organizationId: string;
  environment: string;
  service?: string | null;
  prefixed?: boolean;
  search?: string;
  tail: number;
  /** Decided by the caller; looked up when unset. */
  source?: LogSource;
}): Promise<HistoryResult> {
  // Outside the try so a missing organization isn't swallowed.
  await logAccountId(opts.organizationId);

  const source = opts.source ?? (await appLogSource({ id: opts.projectId, name: opts.project }, opts.environment));
  if (source === "victorialogs") {
    try {
      const lines = await readStoredHistory(opts);
      if (lines.length > 0) return { source, lines };
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
