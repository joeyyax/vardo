// ---------------------------------------------------------------------------
// Deploy logger — writes deploy events to Redis Streams
//
// Replaces the inline log() and stage() functions in runDeployment.
// Each deploy gets its own stream (stream:deploy:{deployId}) that serves
// as the single source of truth for both live tailing and history.
// ---------------------------------------------------------------------------

import { addDeployLog } from "@/lib/stream/producer";
import { logger } from "@/lib/logger";
import { redactSecrets } from "@/lib/redact";

const log = logger.child("deploy-logger");

/**
 * Re-use the stage type from deploy.ts to avoid drift.
 * Extended with "queued" for the pre-start state.
 */
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

/**
 * Phases of an auto-rollback, named for the steps performRollback runs.
 * A rollback restores an already-built slot, so it shares no phase with a deploy.
 */
export type RollbackStage = "stop" | "restore" | "route" | "verify" | "done";

/** Any phase that can appear on a deploy stream. */
export type StreamStage = DeployStage | RollbackStage;

export type DeployStatus = "running" | "success" | "failed" | "skipped" | "cancelled";

/**
 * Whether a stage event ends the deploy, and with it the stream.
 * Success is terminal only on `done` — every stage reports success of its own.
 */
export function isTerminalStageEvent(stage?: string, status?: string): boolean {
  if (status === "failed" || status === "cancelled") return true;
  return stage === "done" && status === "success";
}

/** Key file names, which point at a secret without being one. */
const KEY_FILE_PATTERNS = [
  { pattern: /\.host-deploy-key-[A-Za-z0-9_-]+/g, replacement: ".host-deploy-key-***" },
  { pattern: /\.host-ssh-key-[A-Za-z0-9_-]+/g, replacement: ".host-ssh-key-***" },
];

function sanitize(line: string): string {
  let result = redactSecrets(line);
  for (const { pattern, replacement } of KEY_FILE_PATTERNS) {
    result = result.replace(pattern, replacement);
  }
  return result;
}

/**
 * Create a deploy logger bound to a specific deployment.
 *
 * Returns `log()` and `stage()` functions that write to the deploy's
 * Redis Stream. The stream serves as the single source of truth —
 * live SSE consumers and history views both read from it.
 */
export function createDeployLogger(deployId: string) {
  let currentStage: StreamStage = "queued";
  let lastWrite: Promise<string> = Promise.resolve("");

  /**
   * Log a deploy message. Sanitizes secrets and writes to the stream.
   * Returns the sanitized line (for backward compatibility with logLines[]).
   */
  function logLine(line: string): string {
    const sanitized = sanitize(line);

    addDeployLog(deployId, {
      line: sanitized,
      stage: currentStage,
      status: "running",
    }).catch((err) => {
      log.error(`Failed to write deploy log for ${deployId}:`, err);
    });

    return sanitized;
  }

  /**
   * Record a stage transition. Writes to the stream with the stage/status
   * so the frontend can render progress indicators.
   *
   * Terminal states (success, failed, cancelled) are awaited to ensure
   * the SSE endpoint sees the "done" event before the connection closes.
   * Non-terminal states are fire-and-forget.
   */
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
    // Terminal writes: the returned promise is available on `lastWrite`
    // so callers can await it if needed
    lastWrite = isTerminal ? write : lastWrite;
  }

  /** Get the current stage (for error handler context). */
  function getStage(): StreamStage {
    return currentStage;
  }

  /** Await the last terminal write to ensure SSE consumers see the done event. */
  async function flush(): Promise<void> {
    try { await lastWrite; } catch { /* already logged */ }
  }

  return { log: logLine, stage: setStage, getStage, flush };
}
