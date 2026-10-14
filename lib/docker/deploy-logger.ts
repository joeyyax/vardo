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

/** What a deploy is waiting on: the app's running deploy, a deploy slot, the builder or the shared checkout. */
export type WaitReason = "app" | "deploy-slot" | "build-slot" | "checkout";

/** Writes a wait entry to a deploy's stream; null ends the open wait. */
export type WaitWriter = (reason: WaitReason | null, ahead?: number) => Promise<void> | void;

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

/** A wait as the deploy streams send it; `reason` null ends it. */
export type DeployWaitEvent = { deploymentId: string; reason: WaitReason | null; ahead?: number; streamId?: string };

/** Told of stage and wait entries once written, with their stream id when Redis took them. */
export type DeployStreamObservers = {
  onStage?: (stage: StreamStage, status: DeployStatus, streamId?: string) => void;
  onWait?: (wait: DeployWaitEvent) => void;
};

/** Create `log()` and `stage()` writers bound to a deployment's stream. */
export function createDeployLogger(deployId: string, observers: DeployStreamObservers = {}) {
  const tell = (fn: () => void) => {
    try { fn(); } catch { /* an observer never breaks the deploy */ }
  };
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
    write.then(
      (id) => tell(() => observers.onStage?.(stage, status, id)),
      () => tell(() => observers.onStage?.(stage, status)),
    );

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
  let waitWrites: Promise<unknown> = Promise.resolve();
  let paused: ReturnType<typeof pauseRunningClock> | null = null;

  /** Open, update or end (null) a wait. Writes are serialized; ending with no wait open writes nothing. */
  function wait(reason: WaitReason | null, ahead?: number): Promise<void> {
    const next = reason === null ? undefined : ahead;
    if (reason === openWait && next === openAhead) return waitWrites.then(() => {});
    // Waiting doesn't count against the sweeper's running budget.
    if (reason !== null && !paused) paused = pauseRunningClock(deployId);
    if (reason === null && paused) {
      void paused.resume();
      paused = null;
    }
    openWait = reason;
    openAhead = next;
    const entry = {
      line: reason === null ? "[wait] done" : `[wait] ${reason}${next === undefined ? "" : ` (${next} ahead)`}`,
      stage: currentStage,
      status: "running",
      wait: reason ?? "",
      ahead: next,
    };
    const event: DeployWaitEvent = { deploymentId: deployId, reason, ...(next === undefined ? {} : { ahead: next }) };
    waitWrites = waitWrites
      .then(() => addDeployLog(deployId, entry))
      .then(
        (streamId) => tell(() => observers.onWait?.({ ...event, streamId })),
        (err) => {
          log.error(`Failed to write wait for ${deployId}:`, err);
          tell(() => observers.onWait?.(event));
        },
      );
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
