// Runs one watch entry for a linked instance, over the public path.

import { checkHost, runCheck, type CheckPath, type CheckResult, type WatchEntry } from "./core";
import { classifyHost, type Resolver } from "./net";
import type { CheckDeps } from "./outbound";

export type ProbeDeps = { now?: () => number; resolve?: Resolver; fetch?: typeof fetch };

const unchecked = (monitorId: string, vantageId: string, path: CheckPath, error: "blocked" | "private-address", at: number): CheckResult => ({
  monitorId,
  vantageId,
  path,
  at,
  ok: false,
  latencyMs: 0,
  error,
});

/**
 * One watch entry, checked over the internet. A mesh entry from an older owner is refused as unknown and never sent through the tunnel.
 * A host that resolves to a private or tunnel address isn't checked.
 */
export async function probeEntry(
  entry: { monitorId: string; check: WatchEntry["check"]; path: string },
  ctx: { vantageId: string; strict: CheckDeps; deps?: ProbeDeps },
): Promise<CheckResult> {
  const clock = ctx.deps?.now ?? Date.now;
  if (entry.path === "mesh") return unchecked(entry.monitorId, ctx.vantageId, "mesh", "blocked", clock());
  const reach = await classifyHost(checkHost(entry.check), ctx.deps?.resolve);
  if (reach === "private") return unchecked(entry.monitorId, ctx.vantageId, "public", "private-address", clock());
  return runCheck({ id: entry.monitorId, check: entry.check }, ctx.vantageId, "public", {
    now: ctx.deps?.now,
    fetch: ctx.deps?.fetch ?? ctx.strict.fetch,
    guard: ctx.strict.guard,
  });
}
