// Local deploy and verification states. Mesh scheduling lives in rollout-plan.ts.

/** Run states after which nothing is left to do. */
export const TERMINAL_RUN_STATES = ["verified", "failed", "rolled-back", "rollback-failed"] as const;

export type RunState = "deploying" | "verifying" | "rolling-back" | (typeof TERMINAL_RUN_STATES)[number];

export const DEPLOY_TIMEOUT_MS = 2 * 60 * 60_000;

/** A run still in flight. One stuck past twice the deploy timeout is abandoned. */
export function isRunActive(run: { state: RunState; startedAt: string } | null, now = Date.now()): boolean {
  if (!run || (TERMINAL_RUN_STATES as readonly string[]).includes(run.state)) return false;
  return now - Date.parse(run.startedAt) < DEPLOY_TIMEOUT_MS * 2;
}

export type VerifyStep =
  | { next: "verifying"; passes: number; fails: number }
  | { next: "verified" }
  | { next: "rollback"; reason: string };

/** Checks after the update: three failed probes in a row roll back; a clean window verifies. */
export const VERIFY_WINDOW_MS = 5 * 60_000;
export const VERIFY_MIN_PASSES = 3;
export const VERIFY_MAX_FAILS = 3;

export function verifyStep(input: {
  startedAt: number;
  now: number;
  passes: number;
  fails: number;
  unhealthy: string[];
}): VerifyStep {
  const healthy = input.unhealthy.length === 0;
  const passes = healthy ? input.passes + 1 : input.passes;
  const fails = healthy ? 0 : input.fails + 1;
  if (fails >= VERIFY_MAX_FAILS) return { next: "rollback", reason: `Unhealthy after the update: ${input.unhealthy.join(", ")}` };
  if (passes >= VERIFY_MIN_PASSES && input.now - input.startedAt >= VERIFY_WINDOW_MS) return { next: "verified" };
  return { next: "verifying", passes, fails };
}
