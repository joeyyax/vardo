// Deploy stages in one vocabulary, shared by the app header, the in-progress card and the Pipeline page.

/** The stages a deploy passes, in order, as people read them. `wait` is waiting for a builder. */
export const SHARED_STAGES = ["queued", "prepare", "wait", "build", "start", "health", "switch", "live", "rollingBack"] as const;
export type SharedStage = (typeof SHARED_STAGES)[number];

export const SHARED_STAGE_LABELS: Record<SharedStage, string> = {
  queued: "Queued",
  prepare: "Prepare",
  wait: "Waiting for a builder",
  build: "Build",
  start: "Start",
  health: "Health check",
  switch: "Switch traffic",
  live: "Live",
  rollingBack: "Rolling back",
};

/** Present tense, for the head of a bar or a status line. */
const HEAD: Record<SharedStage, string> = {
  queued: "Queued",
  prepare: "Preparing",
  wait: "Waiting for a builder",
  build: "Building",
  start: "Starting",
  health: "Checking health",
  switch: "Switching traffic",
  live: "Live",
  rollingBack: "Rolling back",
};

/** "Building on Long House", "Starting", "Switching traffic". */
export function stageHead(stage: SharedStage, opts: { builder?: string | null } = {}): string {
  return stage === "build" && opts.builder ? `Building on ${opts.builder}` : HEAD[stage];
}

/** The shared stage an engine stage belongs to; null for one outside a deploy's run. */
export function sharedStage(engine: string | null | undefined): SharedStage | null {
  switch (engine) {
    case "queued":
      return "queued";
    case "clone":
    case "compose":
      return "prepare";
    case "build":
      return "build";
    case "deploy":
      return "start";
    case "healthcheck":
      return "health";
    case "routing":
      return "switch";
    case "cleanup":
    case "done":
      return "live";
    case "stop":
    case "restore":
    case "route":
    case "verify":
      return "rollingBack";
    default:
      return null;
  }
}

/** Engine stages by their shared label. Clone and compose both read Prepare. */
export const STAGE_LABELS: Record<string, string> = {
  clone: "Prepare",
  compose: "Prepare",
  build: "Build",
  deploy: "Start",
  healthcheck: "Health check",
  routing: "Switch traffic",
  cleanup: "Live",
  stop: "Stop",
  restore: "Restore",
  route: "Switch traffic",
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

/** The phase a run is in right now, present tense, or null before the first stage event lands. */
export function currentStageLabel(stages: Record<string, string> | undefined): string | null {
  if (!stages) return null;
  const rollback = ROLLBACK_STAGE_KEYS.some((s) => stages[s]);
  const keys = rollback ? ROLLBACK_STAGE_KEYS : DEPLOY_STAGE_KEYS;
  const running = keys.find((s) => stages[s] === "running");
  if (!running) return null;
  return rollback ? HEAD.rollingBack : HEAD[sharedStage(running) ?? "prepare"];
}
