// Writes deploy events to a per-deploy Redis stream (stream:deploy:{deployId}), read by live tailing and history.

import { addDeployLog } from "@/lib/stream/producer";
import { expireDeployStream } from "@/lib/stream/deploy-expiry";
import { logger } from "@/lib/logger";
import { redactSecrets } from "@/lib/redact";

const log = logger.child("deploy-logger");

/** Shortest env value redacted by exact match. */
const MIN_SECRET_LENGTH = 6;

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

/** Values too common to redact by exact match without mangling logs. */
const COMMON_VALUES = new Set([
  "true", "false", "production", "development", "staging", "preview", "test", "localhost", "default", "enabled", "disabled",
]);

function sanitize(line: string, values: Iterable<string>): string {
  let result = redactSecrets(line, values);
  for (const { pattern, replacement } of KEY_FILE_PATTERNS) {
    result = result.replace(pattern, replacement);
  }
  return result;
}

/** Create `log()` and `stage()` writers bound to a deployment's stream. */
export function createDeployLogger(deployId: string) {
  let currentStage: StreamStage = "queued";
  let lastWrite: Promise<string> = Promise.resolve("");
  const secretValues = new Set<string>();

  /** Redact these literal values from every later line. Short and common values are skipped. */
  function addSecrets(values: Iterable<string>): void {
    for (const value of values) {
      if (typeof value !== "string" || value.length < MIN_SECRET_LENGTH) continue;
      if (COMMON_VALUES.has(value.toLowerCase())) continue;
      secretValues.add(value);
    }
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

  /** Current stage, for error context. */
  function getStage(): StreamStage {
    return currentStage;
  }

  /** Await the last terminal write so SSE consumers see the done event. */
  async function flush(): Promise<void> {
    try { await lastWrite; } catch { /* already logged */ }
  }

  return { log: logLine, stage: setStage, getStage, flush, addSecrets, redact: (text: string) => sanitize(text, secretValues) };
}
