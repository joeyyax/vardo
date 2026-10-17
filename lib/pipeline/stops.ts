// Where a deploy sits on the Pipeline map, from its row's status, stage and wait.

import type { WaitReason } from "@/lib/docker/deploy-logger";
import { SHARED_STAGE_LABELS, sharedStage, stageHead, type SharedStage } from "@/lib/ui/deploy-stage";

/** Stops on the map, in the order a deploy passes them. `rolledBack` is the branch off the health check. */
export const STOPS = ["queue", "gate", "build", "export", "swap", "health", "routing", "live", "rolledBack"] as const;
export type Stop = (typeof STOPS)[number];

export type StopInput = {
  status: string;
  stage: string | null;
  waitReason: WaitReason | string | null;
};

/** `failed` marks a deploy that stopped at `stop` without reaching the swap. */
export type Placement = { stop: Stop; waiting: boolean; failed: boolean; gone: boolean };

const STAGE_STOP: Record<string, Stop> = {
  queued: "gate",
  clone: "gate",
  compose: "gate",
  build: "build",
  deploy: "swap",
  healthcheck: "health",
  routing: "routing",
  cleanup: "live",
  done: "live",
};

/** Stages past the swap: a failure there leaves the old version serving. */
const SWAPPED = new Set(["deploy", "healthcheck", "routing"]);

const QUEUE_WAITS = new Set(["app", "deploy-slot", "worker", "exclusive"]);

export function placeDeploy({ status, stage, waitReason }: StopInput): Placement {
  const at = (stop: Stop, extra: Partial<Placement> = {}): Placement => ({ stop, waiting: false, failed: false, gone: false, ...extra });
  switch (status) {
    case "queued":
      return at("queue", { waiting: true });
    case "running": {
      if (waitReason === "build-slot") return at("gate", { waiting: true });
      if (waitReason && QUEUE_WAITS.has(waitReason) && (!stage || stage === "queued")) return at("queue", { waiting: true });
      const stop = (stage && STAGE_STOP[stage]) || "gate";
      return at(stop, { waiting: waitReason !== null && waitReason !== undefined });
    }
    case "success":
      return at("live");
    case "rolled_back":
      return at("rolledBack");
    case "failed":
      if (stage && SWAPPED.has(stage)) return at("rolledBack");
      return at((stage && STAGE_STOP[stage]) || "queue", { failed: true });
    default:
      return at((stage && STAGE_STOP[stage]) || "queue", { gone: true });
  }
}

/** What a deploy is doing, in a few words: its shared stage, present tense. */
export function describePlacement(p: Placement, ctx: { waitReason?: string | null; stage?: string | null; builder?: string | null }): string {
  if (p.gone) return "Cancelled";
  if (p.failed) return ctx.stage ? `Failed at ${failedAt(ctx.stage)}` : "Failed";
  if (ctx.waitReason === "build-slot") return stageHead("wait");
  if (ctx.waitReason === "deploy-slot") return "Waiting for a deploy slot";
  if (ctx.waitReason === "app") return "Waiting for this app's deploy";
  if (ctx.waitReason === "worker") return "Waiting for the worker";
  if (ctx.waitReason === "exclusive") return "Waiting for Vardo's own swap";
  if (ctx.waitReason === "checkout") return "Waiting for the checkout";
  if (p.stop === "rolledBack") return "Rolled back";
  return stageHead(STOP_STAGE[p.stop], { builder: ctx.builder });
}

/** "build", "health check": the shared name of an engine stage. */
function failedAt(stage: string): string {
  const shared = sharedStage(stage);
  return shared ? SHARED_STAGE_LABELS[shared].toLowerCase() : stage;
}

/** Each stop's shared stage. Export folds into Build. */
export const STOP_STAGE: Record<Stop, SharedStage> = {
  queue: "queued",
  gate: "prepare",
  build: "build",
  export: "build",
  swap: "start",
  health: "health",
  routing: "switch",
  live: "live",
  rolledBack: "rollingBack",
};

/** Each stop's name on the map. */
export const STOP_NAMES: Record<Stop, string> = {
  queue: SHARED_STAGE_LABELS.queued,
  gate: SHARED_STAGE_LABELS.prepare,
  build: SHARED_STAGE_LABELS.build,
  export: SHARED_STAGE_LABELS.build,
  swap: SHARED_STAGE_LABELS.start,
  health: SHARED_STAGE_LABELS.health,
  routing: SHARED_STAGE_LABELS.switch,
  live: SHARED_STAGE_LABELS.live,
  rolledBack: "Rolled back",
};
