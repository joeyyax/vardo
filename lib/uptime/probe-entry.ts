// Runs one watch entry for a linked instance, over the path the entry names.

import { checkHost, runCheck, type CheckPath, type CheckResult, type WatchEntry } from "./core";
import { tunnelAddress, tunnelDeps } from "./mesh-path";
import { classifyHost, meshCarries, type Resolver } from "./net";
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
 * One watch entry, checked the way its path says. A mesh entry connects only to `peerAddress`, the peer's own tunnel address;
 * the entry's host supplies the Host header and SNI name and nothing else. Anything the mesh can't carry is refused as unknown.
 * A public entry whose host resolves to a private or tunnel address isn't checked.
 */
export async function probeEntry(
  entry: { monitorId: string; check: WatchEntry["check"]; path: string },
  ctx: { vantageId: string; peerAddress: string | null; strict: CheckDeps; deps?: ProbeDeps },
): Promise<CheckResult> {
  const clock = ctx.deps?.now ?? Date.now;
  if (entry.path === "mesh") {
    const address = tunnelAddress(ctx.peerAddress);
    if (!address || !meshCarries(entry.check)) return unchecked(entry.monitorId, ctx.vantageId, "mesh", "blocked", clock());
    return runCheck({ id: entry.monitorId, check: entry.check }, ctx.vantageId, "mesh", { now: ctx.deps?.now, ...tunnelDeps(address) });
  }
  const reach = await classifyHost(checkHost(entry.check), ctx.deps?.resolve);
  if (reach === "private") return unchecked(entry.monitorId, ctx.vantageId, "public", "private-address", clock());
  return runCheck({ id: entry.monitorId, check: entry.check }, ctx.vantageId, "public", {
    now: ctx.deps?.now,
    fetch: ctx.deps?.fetch ?? ctx.strict.fetch,
    guard: ctx.strict.guard,
  });
}
