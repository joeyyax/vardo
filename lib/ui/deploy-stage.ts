// Deploy phases shared by the app header and the in-progress card.

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

/** Auto-rollback phases. */
export const ROLLBACK_STAGE_KEYS = ["stop", "restore", "route", "verify"];

/** Position through the phase list, like "3 of 7". */
export function stageProgress(
  stages: Record<string, string> | undefined,
  keys: string[],
): { position: number; total: number } {
  if (!stages) return { position: 0, total: keys.length };
  const active = keys.findIndex((s) => stages[s] === "running" || stages[s] === "failed");
  return {
    position: active >= 0 ? active + 1 : keys.filter((s) => stages[s]).length,
    total: keys.length,
  };
}

/** The phase a run is in right now, or null before the first stage event lands. */
export function currentStageLabel(stages: Record<string, string> | undefined): string | null {
  if (!stages) return null;
  const keys = ROLLBACK_STAGE_KEYS.some((s) => stages[s]) ? ROLLBACK_STAGE_KEYS : DEPLOY_STAGE_KEYS;
  const running = keys.find((s) => stages[s] === "running");
  return running ? STAGE_LABELS[running] : null;
}
