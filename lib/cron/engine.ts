import { db } from "@/lib/db";
import { apps, cronJobs, cronJobRuns } from "@/lib/db/schema";
import { and, eq, lt } from "drizzle-orm";
import { nanoid } from "nanoid";
import { listContainers, type ContainerInfo, type ContainerScope } from "@/lib/docker/client";
import { matchContainers, type ReconcilableApp } from "@/lib/docker/container-match";
import { shouldRunNow } from "./parse";
import { acquireLock, releaseLock } from "@/lib/redis-lock";
import { logger } from "@/lib/logger";
import { execFileAsync } from "@/lib/utils/exec";
import { dockerEnv } from "@/lib/docker/docker-env";
import { decryptHeaders, type CronHeader } from "./headers";
import { cronOutboundPolicy, runUrlRequest } from "./http";
import { DEFAULT_TIMEOUT_MS, MAX_RETRIES } from "./url-options";
import { CRON_JOB_APP } from "./columns";

const log = logger.child("cron");


/** An app a cron job can target, plus the stack it belongs to. */
export type CronTargetApp = ReconcilableApp & {
  parentApp?: { name: string } | null;
};

/** App whose containers the target's live under. Stack children carry the parent's labels. */
export function cronContainerScope(app: CronTargetApp): ContainerScope {
  return {
    id: app.parentAppId ?? app.id,
    name: app.parentApp?.name ?? app.name,
  };
}

/** Running container a cron job execs into. Stack children match by compose service. */
export function selectCronContainer(
  app: CronTargetApp,
  containers: ContainerInfo[],
): ContainerInfo | null {
  return matchContainers(app, containers).find((c) => c.state === "running") ?? null;
}

const OUTPUT_TAIL = 2000;
const COMMAND_TIMEOUT_MS = 300_000;

type ExecResult = {
  success: boolean;
  log: string;
  durationMs: number;
  exitCode?: number;
  httpStatus?: number;
  attempts?: number;
  /** Container the command ran in, or the URL. */
  target?: string;
};

/** Run a command inside an app's container. */
async function executeInContainer(
  app: CronTargetApp,
  command: string,
): Promise<ExecResult> {
  const startTime = Date.now();

  const containers = await listContainers(cronContainerScope(app));
  const running = selectCronContainer(app, containers);

  if (!running) {
    return {
      success: false,
      log: "No running container found for app",
      durationMs: Date.now() - startTime,
    };
  }

  try {
    // Pass the command as one argument to sh -c; JSON.stringify isn't shell quoting.
    const { stdout, stderr } = await execFileAsync(
      "docker",
      ["exec", running.id, "sh", "-c", command],
      { env: dockerEnv(), timeout: COMMAND_TIMEOUT_MS }
    );

    const log = [stdout, stderr].filter(Boolean).join("\n").trim();
    return {
      success: true,
      log: log || "(no output)",
      durationMs: Date.now() - startTime,
      exitCode: 0,
      target: running.name,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const { code, stdout, stderr } = err as { code?: unknown; stdout?: unknown; stderr?: unknown };
    const output = [stdout, stderr].filter((v): v is string => typeof v === "string" && v.trim() !== "").join("\n").trim();
    return {
      success: false,
      log: output || message,
      durationMs: Date.now() - startTime,
      exitCode: typeof code === "number" ? code : undefined,
      target: running.name,
    };
  }
}

/** Run every enabled cron job that's due. Call once a minute. */
export async function tickCronJobs(): Promise<void> {
  const now = new Date();

  const jobs = await db.query.cronJobs.findMany({
    where: eq(cronJobs.enabled, true),
    with: { app: CRON_JOB_APP },
  });

  const due: CronRunJob[] = [];
  for (const job of jobs) {
    // Org-level jobs have no app to wait on.
    if (job.app && job.app.status !== "active") continue;
    if (!job.app && job.type !== "url") continue;

    if (!shouldRunNow(job.schedule, now, job.timeZone)) continue;

    // Per-minute lock prevents double-firing across instances.
    const minuteTs = Math.floor(now.getTime() / 60_000);
    const locked = await acquireLock(`lock:cron:${job.id}:${minuteTs}`, 61_000);
    if (!locked) continue;

    due.push(job);
  }

  await Promise.allSettled(due.map((job) => runCronJob(job)));
}

export type CronRunJob = {
  id: string;
  name: string;
  type: "command" | "url";
  command: string;
  organizationId: string;
  /** Cron expression, for the failure email. */
  schedule?: string;
  /** Zone the schedule runs in. Null is the server's. */
  timeZone?: string | null;
  method?: string;
  /** Encrypted headers as stored. */
  headers?: string | null;
  timeoutMs?: number;
  retries?: number;
  expectedStatus?: string | null;
  app: (CronTargetApp & { organizationId: string; displayName: string | null }) | null;
};

export type CronRunResult = {
  runId: string;
  status: "success" | "failed";
  exitCode: number | null;
  httpStatus: number | null;
  durationMs: number;
  attempts: number | null;
  output: string;
};

/** Longest a run can hold its lock: every attempt timing out plus the backoff between them. */
export function runLockTtlMs(job: Pick<CronRunJob, "type" | "timeoutMs" | "retries">): number {
  if (job.type !== "url") return COMMAND_TIMEOUT_MS + 30_000;
  const retries = Math.min(job.retries ?? 0, MAX_RETRIES);
  const backoff = retries > 0 ? 1_000 * (2 ** retries - 1) : 0;
  return (job.timeoutMs ?? DEFAULT_TIMEOUT_MS) * (retries + 1) + backoff + 30_000;
}

async function execute(job: CronRunJob): Promise<ExecResult> {
  if (job.type === "url") {
    let headers: CronHeader[];
    try {
      headers = decryptHeaders(job.headers, job.organizationId);
    } catch {
      return { success: false, log: "Couldn't decrypt the request headers. Save them again.", durationMs: 0, target: job.command };
    }
    const policy = await cronOutboundPolicy(job.organizationId, job.command);
    return runUrlRequest(
      {
        url: job.command,
        method: job.method,
        headers,
        timeoutMs: job.timeoutMs,
        retries: job.retries,
        expectedStatus: job.expectedStatus,
      },
      policy,
    );
  }
  if (!job.app) {
    return { success: false, log: "Command jobs need an app", durationMs: 0 };
  }
  return executeInContainer(job.app, job.command);
}

/** Run a job, record the run and notify on failure. Null when the job is already running. */
export async function runCronJob(job: CronRunJob): Promise<CronRunResult | null> {
  const lockKey = `lock:cron:running:${job.id}`;
  if (!(await acquireLock(lockKey, runLockTtlMs(job)))) return null;

  try {
    const runId = nanoid();
    const startedAt = new Date();

    await db.update(cronJobs).set({
      lastRunAt: startedAt,
      lastStatus: "running",
      updatedAt: startedAt,
    }).where(eq(cronJobs.id, job.id));

    let result: ExecResult;
    try {
      result = await execute(job);
    } catch (err) {
      result = {
        success: false,
        log: (err as Error).message,
        durationMs: Date.now() - startedAt.getTime(),
      };
    }

    const completedAt = new Date();
    const status = result.success ? "success" : "failed";

    await db.update(cronJobs).set({
      lastStatus: status,
      lastLog: result.log.slice(0, 10000),
      updatedAt: completedAt,
    }).where(eq(cronJobs.id, job.id));

    await db.insert(cronJobRuns).values({
      id: runId,
      cronJobId: job.id,
      status,
      startedAt,
      completedAt,
      httpStatus: result.httpStatus ?? null,
      durationMs: result.durationMs,
      attempts: result.attempts ?? null,
      output: result.success ? result.log.slice(0, 50000) : null,
      error: result.success ? null : result.log.slice(0, 50000),
    });

    // Delete runs older than 30 days.
    const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    await db.delete(cronJobRuns).where(
      and(
        eq(cronJobRuns.cronJobId, job.id),
        lt(cronJobRuns.startedAt, cutoff),
      )
    );

    const where = job.app ? ` (${job.app.name})` : "";
    log.info(`${job.name}${where}: ${result.success ? "OK" : "FAILED"} in ${result.durationMs}ms`);

    const alerts = await import("./alerts");
    const alertJob = { id: job.id, name: job.name, organizationId: job.organizationId, app: job.app };
    if (result.success) {
      await alerts.noteCronSuccess(alertJob, completedAt);
    } else {
      const lastSuccess = await db.query.cronJobRuns.findFirst({
        where: and(eq(cronJobRuns.cronJobId, job.id), eq(cronJobRuns.status, "success")),
        orderBy: (r, { desc }) => [desc(r.startedAt)],
        columns: { startedAt: true },
      }).catch(() => undefined);
      const appName = job.app ? job.app.displayName || job.app.name : undefined;
      const shown = result.target ?? job.command;
      await alerts.noteCronFailure(
        alertJob,
        {
          title: appName ? `Cron failed: ${job.name} (${appName})` : `Cron failed: ${job.name}`,
          message: result.log.slice(0, 500),
          cronJobId: job.id,
          cronJobName: job.name,
          appId: job.app?.id,
          projectName: appName,
          durationMs: result.durationMs,
          schedule: job.schedule,
          scheduleTimeZone: job.timeZone ?? undefined,
          command: job.type === "url" ? undefined : job.command.length > 200 ? `${job.command.slice(0, 199)}…` : job.command,
          jobType: job.type === "url" ? "url" : "command",
          exitCode: result.exitCode ?? result.httpStatus,
          target: shown,
          lastSuccessAt: lastSuccess?.startedAt.toISOString(),
          logTail: result.log.split("\n").filter((l) => l.trim()).slice(-20),
        },
        completedAt,
      );
    }

    return {
      runId,
      status,
      exitCode: result.exitCode ?? null,
      httpStatus: result.httpStatus ?? null,
      durationMs: result.durationMs,
      attempts: result.attempts ?? null,
      output: result.log.slice(-OUTPUT_TAIL),
    };
  } finally {
    await releaseLock(lockKey).catch(() => {});
  }
}

/** Create an app's cron jobs from template or config. Skips existing names. */

export async function syncCronJobs(
  appId: string,
  definitions: { name: string; type?: "command" | "url"; schedule: string; command: string; enabled?: boolean }[],
): Promise<number> {
  const app = await db.query.apps.findFirst({
    where: eq(apps.id, appId),
    columns: { organizationId: true },
  });
  if (!app) return 0;

  const existing = await db.query.cronJobs.findMany({
    where: eq(cronJobs.appId, appId),
    columns: { name: true },
  });
  const existingNames = new Set(existing.map(j => j.name));

  let created = 0;
  for (const def of definitions) {
    if (existingNames.has(def.name)) continue;

    await db.insert(cronJobs).values({
      id: nanoid(),
      organizationId: app.organizationId,
      appId,
      name: def.name,
      type: def.type ?? "command",
      schedule: def.schedule,
      command: def.command,
      enabled: def.enabled ?? true,
    });
    created++;
  }

  return created;
}
