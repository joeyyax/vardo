// Deploy phases, named once. The header states the stage a deploy is in, the
// in-progress card walks the same list.

export const STAGE_LABELS: Record<string, string> = {
  clone: "Clone",
  compose: "Compose",
  build: "Build",
  deploy: "Deploy",
  healthcheck: "Health",
  routing: "Route",
  cleanup: "Cleanup",
  stop: "Stop",
  restore: "Restore",
  route: "Route",
  verify: "Verify",
};

export const DEPLOY_STAGE_KEYS = ["clone", "compose", "build", "deploy", "healthcheck", "routing", "cleanup"];

/** An auto-rollback restores a built slot, so it reports its own phases. */
export const ROLLBACK_STAGE_KEYS = ["stop", "restore", "route", "verify"];

/** The phase a run is in right now, or null before the first stage event lands. */
export function currentStageLabel(stages: Record<string, string> | undefined): string | null {
  if (!stages) return null;
  const keys = ROLLBACK_STAGE_KEYS.some((s) => stages[s]) ? ROLLBACK_STAGE_KEYS : DEPLOY_STAGE_KEYS;
  const running = keys.find((s) => stages[s] === "running");
  return running ? STAGE_LABELS[running] : null;
}
