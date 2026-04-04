// ---------------------------------------------------------------------------
// Deploy logger — writes deploy events to Redis Streams
//
// Replaces the inline log() and stage() functions in runDeployment.
// Each deploy gets its own stream (stream:deploy:{deployId}) that serves
// as the single source of truth for both live tailing and history.
// ---------------------------------------------------------------------------

import { addDeployLog } from "@/lib/stream/producer";
import { logger } from "@/lib/logger";

const log = logger.child("deploy-logger");

/**
 * Re-use the stage type from deploy.ts to avoid drift.
 * Extended with "queued" for the pre-start state.
 */
export type DeployStage =
  | "queued"
  | "clone"
  | "build"
  | "deploy"
  | "healthcheck"
  | "routing"
  | "cleanup"
  | "done";

export type DeployStatus = "running" | "success" | "failed" | "skipped" | "cancelled";

/** Secret patterns to strip from log output. */
const SECRET_PATTERNS = [
  { pattern: /x-access-token:[^\s@]+/g, replacement: "x-access-token:***" },
  { pattern: /ghs_[A-Za-z0-9]+/g, replacement: "***" },
  { pattern: /\.host-deploy-key-[A-Za-z0-9_-]+/g, replacement: ".host-deploy-key-***" },
];

function sanitize(line: string): string {
  let result = line;
  for (const { pattern, replacement } of SECRET_PATTERNS) {
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
  let currentStage: DeployStage = "queued";

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
   */
  function setStage(stage: DeployStage, status: DeployStatus): void {
    currentStage = stage;

    addDeployLog(deployId, {
      line: `[stage] ${stage}: ${status}`,
      stage,
      status,
    }).catch((err) => {
      log.error(`Failed to write stage for ${deployId}:`, err);
    });
  }

  /** Get the current stage (for error handler context). */
  function getStage(): DeployStage {
    return currentStage;
  }

  return { log: logLine, stage: setStage, getStage };
}
