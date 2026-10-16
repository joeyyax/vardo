// Where background loops run: in the web process, in the worker, or handed between them.

export type LoopsInWeb = "auto" | "always" | "never";
export type WorkerMode = "embedded" | "external";

/** How often a worker records its heartbeat. */
export const WORKER_BEAT_MS = 10_000;
/** A worker heartbeat younger than this counts as present. */
export const WORKER_FRESH_MS = 90_000;
/** How often web checks for a worker. */
export const HANDOFF_CHECK_MS = 30_000;
/** Web takes its loops back after this long without a present worker. */
export const WEB_RESUME_AFTER_MS = 120_000;
/** host.worker-down opens after this long without a worker heartbeat. */
export const WORKER_DOWN_AFTER_MS = 180_000;
/** host.watchdog-silent opens when the watchdog's alive file is older than this. */
export const WATCHDOG_SILENT_AFTER_MS = 600_000;

/** `embedded` runs every loop in web, the dev default; `external` expects a worker container. */
export function workerMode(env: NodeJS.ProcessEnv = process.env): WorkerMode {
  const set = env.VARDO_WORKER;
  if (set === "embedded" || set === "external") return set;
  return env.NODE_ENV === "production" ? "external" : "embedded";
}

/** Whether web starts its background loops. Under `pnpm dev` only with VARDO_DEV_WORKERS=1. */
export function webLoopsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.NODE_ENV !== "development" || env.VARDO_DEV_WORKERS === "1";
}

/** VARDO_LOOPS_IN_WEB wins; otherwise embedded runs loops in web always and external hands them off. */
export function loopsInWeb(env: NodeJS.ProcessEnv = process.env): LoopsInWeb {
  const set = env.VARDO_LOOPS_IN_WEB;
  if (set === "auto" || set === "always" || set === "never") return set;
  return workerMode(env) === "embedded" ? "always" : "auto";
}

/** Whether a missing worker is a problem worth an incident. */
export function workerExpected(env: NodeJS.ProcessEnv = process.env): boolean {
  return loopsInWeb(env) !== "always";
}

function positiveInt(value: string | undefined, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

/** How long SIGTERM lets loop passes finish. Inside the compose stop_grace_period (10 min). */
export function workerDrainMs(env: NodeJS.ProcessEnv = process.env): number {
  return positiveInt(env.VARDO_WORKER_DRAIN_SECONDS, 540) * 1000;
}

export function workerHealthPort(env: NodeJS.ProcessEnv = process.env): number {
  return positiveInt(env.VARDO_WORKER_HEALTH_PORT, 3001);
}
