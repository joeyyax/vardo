// Which process claims which deploys.

import { workerMode } from "@/lib/worker/mode";
import type { LoopRole } from "@/lib/worker/interval-loop";

/** "all" claims every deploy, "self" only Vardo's own, "others" everything but Vardo's own. */
export type ClaimScope = "all" | "self" | "others" | "none";

/** `VARDO_DEPLOY_EXECUTOR=web` runs every deploy in the console, for a worker that can't run them. */
export function webExecutesAll(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.VARDO_DEPLOY_EXECUTOR === "web" || workerMode(env) === "embedded";
}

export function claimScope(role: LoopRole, env: NodeJS.ProcessEnv = process.env): ClaimScope {
  if (role === "web") return webExecutesAll(env) ? "all" : "self";
  return env.VARDO_DEPLOY_EXECUTOR === "web" ? "none" : "others";
}

/** The process that runs a deploy of this app. */
export function executorFor(selfApp: boolean, env: NodeJS.ProcessEnv = process.env): LoopRole {
  return selfApp || webExecutesAll(env) ? "web" : "worker";
}
