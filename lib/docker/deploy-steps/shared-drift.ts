// ---------------------------------------------------------------------------
// Shared services whose running container no longer matches the compose file.
//
// Shared services come up `--no-recreate`, so a changed definition never
// reaches a running container on its own. Compose stamps every container with
// the hash of the definition it was created from; comparing that label against
// `config --hash` is the test compose's own `up` uses to decide on a recreate.
// ---------------------------------------------------------------------------

import type { ComposeService } from "../compose-types";
import { ownsDataDirectory } from "../image-updates/stateful-image";
import { sharedContainerNames } from "./shared-images";

export const CONFIG_HASH_LABEL = "com.docker.compose.config-hash";

/** Runs `docker <args>`. Throws on a non-zero exit. */
export type DockerExec = (
  args: string[],
  opts: { cwd?: string; timeout: number },
) => Promise<{ stdout: string; stderr: string }>;

export type DriftState = "unchanged" | "drifted" | "missing" | "unknown";

export type SharedOutcome =
  | { service: string; result: "unchanged" | "recreated" }
  | { service: string; result: "held" | "unknown"; reason: string };

/** `config --hash` output: one `<service> <hash>` per line. */
export function parseConfigHashes(output: string): Map<string, string> {
  const hashes = new Map<string, string>();
  for (const line of output.split(/\r?\n/)) {
    const match = /^\s*(\S+)\s+([0-9a-f]{16,})\s*$/i.exec(line);
    if (match) hashes.set(match[1], match[2]);
  }
  return hashes;
}

/**
 * Whether a deploy may recreate a drifted shared service on its own.
 *
 * A data store is held: recreating it drops every connection to it, including
 * this deploy's, and a definition change there is the operator's call.
 * Anything else is recreated — Traefik, BuildKit and WireGuard restart in
 * seconds and hold nothing a restart loses.
 */
export function sharedPolicy(
  service: ComposeService,
): { action: "recreate" } | { action: "hold"; reason: string } {
  if (service.image && ownsDataDirectory(service.image)) {
    return {
      action: "hold",
      reason: "a data store is never recreated by a deploy — every app connected to it would drop",
    };
  }
  return { action: "recreate" };
}

type DriftOpts = {
  shared: Record<string, ComposeService>;
  project: string;
  composeFileArgs: string[];
  cwd: string;
  exec: DockerExec;
  timeout: number;
};

/** Compare each shared service's running container against its definition. */
export async function sharedDrift(
  opts: DriftOpts,
): Promise<{ states: Map<string, DriftState>; error?: string }> {
  const { shared, project, composeFileArgs, cwd, exec, timeout } = opts;
  const names = Object.keys(shared);
  const states = new Map<string, DriftState>();

  // `--profile *` so a profiled service (buildkit) is hashed rather than refused.
  let desired: Map<string, string>;
  try {
    const { stdout } = await exec(
      ["compose", ...composeFileArgs, "--profile", "*", "-p", project, "config", "--hash", names.join(",")],
      { cwd, timeout },
    );
    desired = parseConfigHashes(stdout);
  } catch (err) {
    for (const name of names) states.set(name, "unknown");
    return { states, error: err instanceof Error ? err.message : String(err) };
  }

  for (const [container, name] of sharedContainerNames(shared, project)) {
    let running: string | undefined;
    try {
      const { stdout } = await exec(
        ["inspect", "--format", `{{index .Config.Labels "${CONFIG_HASH_LABEL}"}}`, container],
        { timeout },
      );
      running = stdout.trim();
    } catch {
      states.set(name, "missing");
      continue;
    }
    const want = desired.get(name);
    if (!running || running === "<no value>" || !want) states.set(name, "unknown");
    else states.set(name, running === want ? "unchanged" : "drifted");
  }
  return { states };
}

/**
 * Wait for a recreated container to be ready. Resolves null when it is, or
 * the reason it is not.
 *
 * With a Docker healthcheck that means healthy; without one, running for
 * `stableMs` in a row.
 */
export async function waitForContainer(
  container: string,
  exec: DockerExec,
  timing: { timeoutMs: number; intervalMs: number; stableMs: number; queryTimeout: number },
  sleep: (ms: number) => Promise<void>,
  now: () => number = Date.now,
): Promise<string | null> {
  const deadline = now() + timing.timeoutMs;
  let runningSince: number | null = null;
  let last = "not started";

  while (now() < deadline) {
    try {
      const { stdout } = await exec(
        ["inspect", "--format", "{{.State.Status}} {{if .State.Health}}{{.State.Health.Status}}{{end}}", container],
        { timeout: timing.queryTimeout },
      );
      const [state = "", health = ""] = stdout.trim().split(/\s+/);
      last = health ? `${state}, ${health}` : state;
      if (state === "exited" || state === "dead") return `container ${state}`;
      if (health) {
        if (health === "healthy") return null;
        runningSince = null;
      } else if (state === "running") {
        runningSince ??= now();
        if (now() - runningSince >= timing.stableMs) return null;
      } else {
        runningSince = null;
      }
    } catch (err) {
      last = err instanceof Error ? err.message : String(err);
      runningSince = null;
    }
    await sleep(timing.intervalMs);
  }
  return `not ready after ${Math.round(timing.timeoutMs / 1000)}s (${last})`;
}

/** A recreated shared service that failed to start or never became ready. */
export class SharedRecreateError extends Error {
  constructor(readonly service: string, message: string) {
    super(`Shared service ${service} failed after recreate: ${message}`);
    this.name = "SharedRecreateError";
  }
}

/**
 * Recreate each drifted shared service the policy allows, one at a time, each
 * ready before the next. Held and unreadable services are reported, not
 * touched. Throws SharedRecreateError on the first recreate that fails.
 */
export async function reconcileSharedServices(
  opts: DriftOpts & {
    log: (line: string) => void;
    upTimeout: number;
    readyTimeout: (service: ComposeService) => number;
    intervalMs: number;
    stableMs: number;
    sleep: (ms: number) => Promise<void>;
    /** Services whose bind data has to move out of a slot before a recreate. */
    pendingMoves?: Record<string, string[]>;
  },
): Promise<SharedOutcome[]> {
  const { shared, project, composeFileArgs, cwd, exec, timeout, log } = opts;
  const { states, error } = await sharedDrift(opts);
  if (error) log(`[deploy] Could not read shared service definitions — ${error}`);

  const containers = new Map(
    [...sharedContainerNames(shared, project)].map(([container, name]) => [name, container]),
  );
  const outcomes: SharedOutcome[] = [];

  for (const [name, service] of Object.entries(shared)) {
    const state = states.get(name) ?? "unknown";
    if (state === "unchanged") {
      outcomes.push({ service: name, result: "unchanged" });
      continue;
    }
    if (state !== "drifted") {
      outcomes.push({
        service: name,
        result: "unknown",
        reason: state === "missing" ? "no running container" : "no definition hash to compare",
      });
      continue;
    }

    const moves = opts.pendingMoves?.[name];
    if (moves?.length) {
      outcomes.push({
        service: name,
        result: "held",
        reason: `its data is still in a slot dir — move ${moves.join(", ")} first`,
      });
      continue;
    }

    const policy = sharedPolicy(service);
    if (policy.action === "hold") {
      outcomes.push({ service: name, result: "held", reason: policy.reason });
      continue;
    }

    log(`[deploy] Recreating shared service ${name} — its definition changed`);
    try {
      await exec(
        ["compose", ...composeFileArgs, "-p", project, "up", "-d", "--no-deps", "--pull", "never", name],
        { cwd, timeout: opts.upTimeout },
      );
    } catch (err) {
      throw new SharedRecreateError(name, err instanceof Error ? err.message : String(err));
    }
    const notReady = await waitForContainer(
      containers.get(name)!,
      exec,
      { timeoutMs: opts.readyTimeout(service), intervalMs: opts.intervalMs, stableMs: opts.stableMs, queryTimeout: timeout },
      opts.sleep,
    );
    if (notReady) throw new SharedRecreateError(name, notReady);
    outcomes.push({ service: name, result: "recreated" });
  }
  return outcomes;
}

/** The deploy log line for one shared service. */
export function describeSharedOutcome(outcome: SharedOutcome): string {
  switch (outcome.result) {
    case "unchanged":
      return `[deploy] Shared service ${outcome.service}: unchanged`;
    case "recreated":
      return `[deploy] Shared service ${outcome.service}: recreated with its new definition`;
    case "held":
      return `[deploy] Shared service ${outcome.service}: definition changed, held — ${outcome.reason}`;
    case "unknown":
      return `[deploy] Shared service ${outcome.service}: drift not checked — ${outcome.reason}`;
  }
}
