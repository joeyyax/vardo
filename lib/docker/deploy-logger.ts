// Writes deploy events to a per-deploy Redis stream (stream:deploy:{deployId}), read by live tailing and history.

import { addDeployLog } from "@/lib/stream/producer";
import { expireDeployStream } from "@/lib/stream/deploy-expiry";
import { pauseRunningClock } from "@/lib/deploy/running-clock";
import { logger } from "@/lib/logger";
import { MIN_KEYED_LENGTH, redactSecrets, secretEnvValues } from "@/lib/redact";

const log = logger.child("deploy-logger");

/** Deploy stages, including "queued" before start. */
export type DeployStage =
  | "queued"
  | "clone"
  | "compose"
  | "build"
  | "deploy"
  | "healthcheck"
  | "routing"
  | "cleanup"
  | "done";

/** The phases in the order a deploy runs them. */
export const DEPLOY_STAGE_ORDER: DeployStage[] = [
  "queued",
  "clone",
  "compose",
  "build",
  "deploy",
  "healthcheck",
  "routing",
  "cleanup",
  "done",
];

/** Phases of an auto-rollback, named for the steps performRollback runs. */
export type RollbackStage = "stop" | "restore" | "route" | "verify" | "done";

/** Any phase that can appear on a deploy stream. */
export type StreamStage = DeployStage | RollbackStage;

export type DeployStatus = "running" | "success" | "failed" | "skipped" | "cancelled";

/** What a deploy waits on: the app's running deploy, a deploy slot, the builder, the shared checkout, the worker or Vardo's own swap. */
export type WaitReason = "app" | "deploy-slot" | "build-slot" | "checkout" | "worker" | "exclusive";

/** One line per reason, for callers that print why a deploy waits. Never states capacity. */
export function waitText(reason: WaitReason, ahead?: number, total?: number): string {
  const place = ahead === undefined ? "" : total ? ` (${ahead + 1} of ${total})` : ahead ? ` (${ahead} ahead)` : "";
  switch (reason) {
    case "worker":
      return "Waiting for the worker. Deploys start when it's back";
    case "exclusive":
      return "Waiting for Vardo's own update to finish its swap";
    case "app":
      return "Waiting for the deploy already running for this app";
    case "deploy-slot":
      return `Waiting for a free deploy slot${place}`;
    case "build-slot":
      return `Waiting for the builder${place}`;
    case "checkout":
      return "Waiting for another deploy of this app to finish with the repository checkout";
  }
}

/** Writes a wait entry to a deploy's stream; null ends the open wait. `ahead` and `total` place it in a line. */
export type WaitWriter = (reason: WaitReason | null, ahead?: number, total?: number) => Promise<void> | void;

/** Whether a stage event ends the deploy stream. Success is terminal only on `done`. */
export function isTerminalStageEvent(stage?: string, status?: string): boolean {
  if (status === "failed" || status === "cancelled") return true;
  return stage === "done" && status === "success";
}

/** Key file names, which point at a secret without being one. */
const KEY_FILE_PATTERNS = [
  { pattern: /\.host-deploy-key-[A-Za-z0-9_-]+/g, replacement: ".host-deploy-key-***" },
  { pattern: /\.host-ssh-key-[A-Za-z0-9_-]+/g, replacement: ".host-ssh-key-***" },
];

function sanitize(line: string, values: Iterable<string>): string {
  let result = redactSecrets(line, values, MIN_KEYED_LENGTH);
  for (const { pattern, replacement } of KEY_FILE_PATTERNS) {
    result = result.replace(pattern, replacement);
  }
  return result;
}

/** A deploy stream entry for a wait; null ends it. The `wait` field marks it, so readers never show it as a log line. */
export function waitEntry(reason: WaitReason | null, ahead: number | undefined, stage: string, total?: number) {
  const next = reason === null ? undefined : ahead;
  const of = reason === null ? undefined : total;
  const place = next === undefined ? "" : of === undefined ? ` (${next} ahead)` : ` (${next + 1} of ${of})`;
  return {
    line: reason === null ? "[wait] done" : `[wait] ${reason}${place}`,
    stage,
    status: "running",
    wait: reason ?? "",
    ahead: next,
    total: of,
  };
}

/** Create `log()` and `stage()` writers bound to a deployment's stream. */
export function createDeployLogger(deployId: string) {
  let currentStage: StreamStage = "queued";
  let lastWrite: Promise<string> = Promise.resolve("");
  const secretValues = new Set<string>();
  const publicNames = new Set<string>();

  /** Names (app, project, org, domains) that are never redacted as env values. */
  function addPublicNames(names: Iterable<string | null | undefined>): void {
    for (const name of names) if (name) publicNames.add(name);
  }

  /** Redact the secret-looking values of this env from every later line. */
  function addSecrets(env: Record<string, string>): void {
    for (const value of secretEnvValues(env, publicNames)) secretValues.add(value);
  }

  /** Sanitize a line, write it to the stream and return it. */
  function logLine(line: string): string {
    const sanitized = sanitize(line, secretValues);

    addDeployLog(deployId, {
      line: sanitized,
      stage: currentStage,
      status: "running",
    }).catch((err) => {
      log.error(`Failed to write deploy log for ${deployId}:`, err);
    });

    return sanitized;
  }

  /** Record a stage transition. Terminal writes are kept on `lastWrite` for `flush()`; others are fire-and-forget. */
  function setStage(stage: StreamStage, status: DeployStatus): void {
    currentStage = stage;

    const isTerminal = status === "success" || status === "failed" || status === "cancelled";
    const write = addDeployLog(deployId, {
      line: `[stage] ${stage}: ${status}`,
      stage,
      status,
    });

    if (!isTerminal) {
      write.catch((err) => {
        log.error(`Failed to write stage for ${deployId}:`, err);
      });
    }
    if (isTerminal && isTerminalStageEvent(stage, status)) {
      // Expiry failure is logged; the sweep retries.
      lastWrite = write.then(async (id) => {
        await expireDeployStream(deployId).catch((err) => {
          log.error(`Failed to expire deploy stream for ${deployId}:`, err);
        });
        return id;
      });
    } else {
      lastWrite = isTerminal ? write : lastWrite;
    }
  }

  let openWait: WaitReason | null = null;
  let openAhead: number | undefined;
  let openTotal: number | undefined;
  let waitWrites: Promise<unknown> = Promise.resolve();
  let paused: ReturnType<typeof pauseRunningClock> | null = null;

  /** Open, update or end (null) a wait on the stream and the row. Writes are serialized; ending with no wait open writes nothing. */
  function wait(reason: WaitReason | null, ahead?: number, total?: number): Promise<void> {
    const next = reason === null ? undefined : ahead;
    const of = reason === null ? undefined : total;
    if (reason === openWait && next === openAhead && of === openTotal) return waitWrites.then(() => {});
    // Waiting doesn't count against the sweeper's running budget.
    if (reason !== null && !paused) paused = pauseRunningClock(deployId);
    if (reason === null && paused) {
      void paused.resume();
      paused = null;
    }
    const restart = reason !== openWait;
    const sameAhead = next === openAhead;
    openWait = reason;
    openAhead = next;
    openTotal = of;
    const entry = waitEntry(reason, next, currentStage, of);
    waitWrites = waitWrites
      .then(() => addDeployLog(deployId, entry))
      .catch((err) => log.error(`Failed to write wait for ${deployId}:`, err))
      .then(async () => {
        const { recordWait, recordQueueTotal } = await import("@/lib/deploy/waiting");
        // Only the line's length moved: one write for every row in that line.
        if (!restart && sameAhead && reason !== null && of !== undefined) await recordQueueTotal(reason, of);
        else await recordWait(deployId, reason, next, of, { restart });
      })
      .catch((err) => log.warn(`Failed to record the wait on ${deployId}:`, err));
    return waitWrites.then(() => {});
  }

  /** Current stage, for error context. */
  function getStage(): StreamStage {
    return currentStage;
  }

  /** Await the last terminal write so SSE consumers see the done event. */
  async function flush(): Promise<void> {
    try { await lastWrite; } catch { /* already logged */ }
  }

  return { log: logLine, stage: setStage, wait, getStage, flush, addSecrets, addPublicNames, redact: (text: string) => sanitize(text, secretValues) };
}
