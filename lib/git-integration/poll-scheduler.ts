// Runs the auto-deploy poll: due apps in small batches each minute, plus catch-up passes on start and reconnect.

import { and, asc, eq, isNotNull, isNull, lt, ne, or, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { apps } from "@/lib/db/schema";
import { redis } from "@/lib/redis";
import { logger } from "@/lib/logger";
import { deployInFlight, requestDeploy } from "@/lib/docker/deploy-cancel";
import { RedisCooldownStore, type KeyedCooldown } from "@/lib/net/cooldown";
import { lsRemoteHead } from "./remote-head";
import {
  decidePoll,
  deployHistory,
  getPollIntervalMinutes,
  hostCooldown,
  hostOf,
  recordPoll,
  type PollDecision,
} from "./poll";

const log = logger.child("git-poll");

const TICK_MS = 60_000;
const BATCH_SIZE = 25;
const CONCURRENCY = 3;
const STAGGER_MS = 500;
const START_DELAY_MS = 90_000;
const CATCH_UP_DEBOUNCE_MS = 30_000;
const PASS_LOCK_KEY = "git-poll:pass";
const PASS_LOCK_MS = 10 * 60_000;

const backoff = hostCooldown(new RedisCooldownStore(redis, "git-poll:host:"));

export type PollableApp = {
  id: string;
  name: string;
  organizationId: string;
  gitUrl: string;
  gitBranch: string | null;
  gitCredentials: string | null;
  gitKeyId: string | null;
  parked: boolean;
  status: string;
  gitPolledSha: string | null;
};

export type PollDeps = {
  lsRemoteHead: typeof lsRemoteHead;
  deployInFlight: typeof deployInFlight;
  deployHistory: typeof deployHistory;
  recordPoll: typeof recordPoll;
  requestDeploy: typeof requestDeploy;
  backoff: KeyedCooldown;
};

const defaultDeps: PollDeps = { lsRemoteHead, deployInFlight, deployHistory, recordPoll, requestDeploy, backoff };

type PollResult = PollDecision | { action: "error"; reason: string };

/** Checks one app's branch head and deploys it when it moved. */
export async function pollApp(app: PollableApp, intervalMs: number, deps: PollDeps = defaultDeps): Promise<PollResult> {
  const host = hostOf(app.gitUrl);
  if (await deps.backoff.blocked(host)) return { action: "skip", reason: `backing off ${host}` };

  let remoteSha: string;
  try {
    remoteSha = await deps.lsRemoteHead(app, app.gitBranch || "main");
    await deps.backoff.succeed(host);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    const delay = await deps.backoff.fail(host, { baseMs: intervalMs });
    log.warn(`Couldn't check ${app.name} on ${host}; backing off ${Math.round(delay / 60_000)} min: ${reason}`);
    await deps.recordPoll(app.id, { error: reason }).catch(() => {});
    return { action: "error", reason };
  }

  const [inFlight, history] = await Promise.all([deps.deployInFlight(app.id), deps.deployHistory(app.id, remoteSha)]);
  const decision = decidePoll({
    parked: app.parked,
    status: app.status,
    inFlight: history.queuedOrRunning ? true : inFlight,
    remoteSha,
    lastDeployedSha: history.lastDeployedSha,
    polledSha: app.gitPolledSha,
    shaHasDeployment: history.shaHasDeployment,
  });

  if (decision.action === "deploy") {
    await deps.recordPoll(app.id, { sha: remoteSha, error: null });
    log.info(`${app.name}: ${remoteSha.slice(0, 7)} is new; deploying`);
    void deps
      .requestDeploy({ appId: app.id, organizationId: app.organizationId, trigger: "poll" })
      .catch((err) => log.warn(`Polled deploy of ${app.name} failed to start:`, err));
  } else if (decision.action === "baseline") {
    await deps.recordPoll(app.id, { sha: remoteSha, error: null });
  } else {
    await deps.recordPoll(app.id, { error: null });
  }
  return decision;
}

async function claimPass(): Promise<() => Promise<void>> {
  const owner = `${process.pid}:${Date.now()}`;
  try {
    const ok = await redis.set(PASS_LOCK_KEY, owner, "PX", PASS_LOCK_MS, "NX");
    if (ok !== "OK") throw new Error("busy");
  } catch (err) {
    if (err instanceof Error && err.message === "busy") throw err;
    return async () => {};
  }
  return async () => {
    try {
      if ((await redis.get(PASS_LOCK_KEY)) === owner) await redis.del(PASS_LOCK_KEY);
    } catch {}
  };
}

let running = false;

/** One pass over due apps, or over every pollable app for a catch-up. Returns how many were checked. */
export async function runPollPass({ catchUp = false }: { catchUp?: boolean } = {}): Promise<number> {
  const minutes = await getPollIntervalMinutes();
  if (minutes === 0 || running) return 0;
  running = true;
  let release: (() => Promise<void>) | null = null;
  try {
    release = await claimPass();
  } catch {
    running = false;
    return 0;
  }

  try {
    const intervalMs = minutes * 60_000;
    const base = and(
      eq(apps.autoDeploy, true),
      eq(apps.source, "git"),
      isNotNull(apps.gitUrl),
      eq(apps.isSystemManaged, false),
      eq(apps.parked, false),
      ne(apps.status, "stopped"),
    );
    const due = catchUp ? base : and(base, or(isNull(apps.gitPolledAt), lt(apps.gitPolledAt, new Date(Date.now() - intervalMs))));
    const rows = await db.query.apps.findMany({
      where: due,
      orderBy: [sql`${apps.gitPolledAt} asc nulls first`, asc(apps.id)],
      ...(catchUp ? {} : { limit: BATCH_SIZE }),
      columns: {
        id: true,
        name: true,
        organizationId: true,
        gitUrl: true,
        gitBranch: true,
        gitCredentials: true,
        gitKeyId: true,
        parked: true,
        status: true,
        gitPolledSha: true,
      },
    });

    const queue: PollableApp[] = rows.flatMap((r) => (r.gitUrl ? [{ ...r, gitUrl: r.gitUrl }] : []));
    const worker = async () => {
      for (let app = queue.shift(); app; app = queue.shift()) {
        await pollApp(app, intervalMs).catch((err) => log.error(`Poll of ${app!.name} failed:`, err));
        await new Promise((r) => setTimeout(r, STAGGER_MS));
      }
    };
    await Promise.all(Array.from({ length: CONCURRENCY }, worker));
    return rows.length;
  } finally {
    await release?.();
    running = false;
  }
}

let catchUpTimer: ReturnType<typeof setTimeout> | null = null;

/** A catch-up pass soon, coalescing requests that arrive together. */
export function requestCatchUpPoll(reason: string): void {
  if (catchUpTimer) return;
  log.info(`Catch-up poll queued: ${reason}`);
  catchUpTimer = setTimeout(() => {
    catchUpTimer = null;
    runPollPass({ catchUp: true }).catch((err) => log.error("Catch-up poll failed:", err));
  }, CATCH_UP_DEBOUNCE_MS);
  catchUpTimer.unref?.();
}

export function startGitPollScheduler(): void {
  const start = setTimeout(() => {
    runPollPass({ catchUp: true }).catch((err) => log.error("Startup poll failed:", err));
  }, START_DELAY_MS);
  start.unref?.();

  const tick = setInterval(() => {
    runPollPass().catch((err) => log.error("Poll pass failed:", err));
  }, TICK_MS);
  tick.unref?.();
}
