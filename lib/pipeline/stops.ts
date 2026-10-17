// Where a deploy sits on the Pipeline map, from its row's status, stage and wait.

import type { WaitReason } from "@/lib/docker/deploy-logger";

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

/** What a deploy is doing, in a few words. */
export function describePlacement(p: Placement, ctx: { waitReason?: string | null; stage?: string | null; builder?: string | null }): string {
  if (p.gone) return "Cancelled";
  if (p.failed) return ctx.stage ? `Failed at ${ctx.stage}` : "Failed";
  if (ctx.waitReason === "build-slot") return "Waiting for a build slot";
  if (ctx.waitReason === "deploy-slot") return "Waiting for a deploy slot";
  if (ctx.waitReason === "app") return "Waiting for this app's deploy";
  if (ctx.waitReason === "worker") return "Waiting for the worker";
  if (ctx.waitReason === "exclusive") return "Waiting for Vardo's own swap";
  if (ctx.waitReason === "checkout") return "Waiting for the checkout";
  switch (p.stop) {
    case "queue":
      return "Queued";
    case "gate":
      return ctx.stage === "clone" ? "Cloning" : ctx.stage === "compose" ? "Preparing" : "Starting";
    case "build":
      return ctx.builder ? `Building on ${ctx.builder}` : "Building";
    case "export":
      return "Exporting image";
    case "swap":
      return "Starting new slot";
    case "health":
      return "Health check";
    case "routing":
      return "Switching traffic";
    case "live":
      return "Live";
    case "rolledBack":
      return "Rolled back";
  }
}

export const STOP_LABEL: Record<Stop, string> = {
  queue: "Queue",
  gate: "Slot gate",
  build: "Build",
  export: "Export",
  swap: "Swap",
  health: "Health check",
  routing: "Routing",
  live: "Live",
  rolledBack: "Rolled back",
};
