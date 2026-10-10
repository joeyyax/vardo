// Shared services whose running container no longer matches the compose file.
// Shared `up` is `--no-recreate`, so drift is the config-hash label against `config --hash`, then a recorded fingerprint.

import { dirname } from "path";

import type { ComposeService } from "../compose-types";
import { ownsDataDirectory } from "../image-updates/stateful-image";
import { sharedContainerNames } from "./shared-images";
import {
  fingerprintsFromConfig,
  loadDefinitions,
  saveDefinitions,
  type DefinitionRecords,
} from "./shared-definitions";

export const CONFIG_HASH_LABEL = "com.docker.compose.config-hash";

/** Runs `docker <args>`. Throws on a non-zero exit. */
export type DockerExec = (
  args: string[],
  opts: { cwd?: string; timeout: number },
) => Promise<{ stdout: string; stderr: string }>;

export type DriftState = "unchanged" | "drifted" | "missing" | "unknown";

export type SharedOutcome =
  | { service: string; result: "unchanged"; labelsOnly?: boolean }
  | { service: string; result: "recreated" }
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
 * Data stores are always held; recreating one drops every app connected to it.
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
  /** Where the definitions shared containers were created from are kept between deploys. */
  definitionsFile?: string;
  /** A compose file that may have created the running containers, outside this deploy's files. */
  legacyComposeFile?: string;
};

type DriftResult = {
  states: Map<string, DriftState>;
  staleRoutes: Set<string>;
  error?: string;
  /** Unchanged apart from labels, scheduling weights or how limits are written. */
  labelsOnly: Set<string>;
  desired: Map<string, string>;
  running: Map<string, string>;
  fingerprints: Map<string, string>;
  records: DefinitionRecords;
};

/** `config` for some services, from `args` (compose file and project arguments). */
async function composeConfig(
  exec: DockerExec,
  args: string[],
  names: string[],
  format: "hash" | "json",
  opts: { cwd?: string; timeout: number },
): Promise<string> {
  // `--profile *` or compose refuses to hash a profiled service (buildkit).
  const tail = format === "hash" ? ["--hash", names.join(",")] : ["--format", "json", ...names];
  return (await exec(["compose", ...args, "--profile", "*", "config", ...tail], opts)).stdout;
}

/** Compare each shared service's running container against its definition. */
export async function sharedDrift(opts: DriftOpts): Promise<DriftResult> {
  const { shared, project, composeFileArgs, cwd, exec, timeout } = opts;
  const names = Object.keys(shared);
  const states = new Map<string, DriftState>();
  const staleRoutes = new Set<string>();
  const labelsOnly = new Set<string>();
  const running = new Map<string, string>();
  let fingerprints = new Map<string, string>();
  let records: DefinitionRecords = {};
  const projectArgs = [...composeFileArgs, "-p", project];

  let desired: Map<string, string>;
  try {
    desired = parseConfigHashes(await composeConfig(exec, projectArgs, names, "hash", { cwd, timeout }));
  } catch (err) {
    for (const name of names) states.set(name, "unknown");
    return {
      states, staleRoutes, labelsOnly, desired: new Map(), running, fingerprints, records,
      error: err instanceof Error ? err.message : String(err),
    };
  }

  for (const [container, name] of sharedContainerNames(shared, project)) {
    let hash: string | undefined;
    try {
      const { stdout } = await exec(
        ["inspect", "--format", `{{index .Config.Labels "${CONFIG_HASH_LABEL}"}}|{{index .Config.Labels "traefik.enable"}}`, container],
        { timeout },
      );
      const [label, routed] = stdout.trim().split("|");
      hash = label;
      if (routed === "true" && !isRouted(shared[name])) staleRoutes.add(name);
    } catch {
      states.set(name, "missing");
      continue;
    }
    const want = desired.get(name);
    if (!hash || hash === "<no value>" || !want) {
      states.set(name, "unknown");
      continue;
    }
    running.set(name, hash);
    states.set(name, hash === want ? "unchanged" : "drifted");
  }

  if (!opts.definitionsFile) return { states, staleRoutes, labelsOnly, desired, running, fingerprints, records };

  records = await loadDefinitions(opts.definitionsFile);
  try {
    fingerprints = fingerprintsFromConfig(await composeConfig(exec, projectArgs, names, "json", { cwd, timeout }));
  } catch {
    // Without the definitions only the hash counts.
  }

  const unknown = names.filter((n) => running.has(n) && records[n]?.hash !== running.get(n));
  if (opts.legacyComposeFile && unknown.length > 0) {
    // Compose reads the legacy file's .env from its directory, as it did when it created them.
    const legacy = { cwd: dirname(opts.legacyComposeFile), timeout };
    const legacyArgs = ["-f", opts.legacyComposeFile, "-p", project];
    try {
      const hashes = parseConfigHashes(await composeConfig(exec, legacyArgs, unknown, "hash", legacy));
      const prints = fingerprintsFromConfig(await composeConfig(exec, legacyArgs, unknown, "json", legacy));
      for (const name of unknown) {
        const print = prints.get(name);
        if (print && hashes.get(name) === running.get(name)) records[name] = { hash: running.get(name)!, fingerprint: print };
      }
    } catch {
      // No legacy layout to read.
    }
  }

  for (const name of names) {
    if (states.get(name) !== "drifted" || staleRoutes.has(name)) continue;
    const record = records[name];
    const print = fingerprints.get(name);
    if (print && record?.hash === running.get(name) && record.fingerprint === print) {
      states.set(name, "unchanged");
      labelsOnly.add(name);
    }
  }
  return { states, staleRoutes, labelsOnly, desired, running, fingerprints, records };
}

function isRouted(service: ComposeService | undefined): boolean {
  const enable = service?.labels?.["traefik.enable"];
  return enable === "true" || (enable as unknown) === true;
}

/**
 * Wait for a recreated container to be healthy, or running for `stableMs` without a healthcheck.
 * Resolves null when ready, else the reason.
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
 * Recreate drifted shared services the policy allows, one at a time, each ready before the next.
 * Held and unreadable services are reported, not touched.
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
  const drift = await sharedDrift(opts);
  const { states, staleRoutes, error, labelsOnly, records } = drift;
  if (error) log(`[deploy] Could not read shared service definitions — ${error}`);

  const containers = new Map(
    [...sharedContainerNames(shared, project)].map(([container, name]) => [name, container]),
  );
  const outcomes: SharedOutcome[] = [];

  for (const [name, service] of Object.entries(shared)) {
    const state = states.get(name) ?? "unknown";
    if (state === "unchanged") {
      outcomes.push({ service: name, result: "unchanged", ...(labelsOnly.has(name) ? { labelsOnly: true } : {}) });
      remember(name, drift.running.get(name));
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

    // Traefik keeps routing to a stale label, so a held data store is recreated to drop it.
    const staleRoute = staleRoutes.has(name);
    const policy = sharedPolicy(service);
    if (policy.action === "hold" && !staleRoute) {
      outcomes.push({ service: name, result: "held", reason: policy.reason });
      continue;
    }

    log(
      staleRoute
        ? `[deploy] Recreating shared service ${name} — it still carries Traefik routing it no longer has`
        : `[deploy] Recreating shared service ${name} — its definition changed`,
    );
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
    remember(name, drift.desired.get(name));
  }

  if (opts.definitionsFile) {
    await saveDefinitions(opts.definitionsFile, records).catch((err) =>
      log(`[deploy] Could not record shared service definitions — ${err instanceof Error ? err.message : err}`),
    );
  }
  return outcomes;

  function remember(name: string, hash: string | undefined) {
    const fingerprint = drift.fingerprints.get(name);
    if (hash && fingerprint) records[name] = { hash, fingerprint };
  }
}

/** The deploy log line for one shared service. */
export function describeSharedOutcome(outcome: SharedOutcome): string {
  switch (outcome.result) {
    case "unchanged":
      return outcome.labelsOnly
        ? `[deploy] Shared service ${outcome.service}: unchanged (only labels, CPU weights or how limits are written differ)`
        : `[deploy] Shared service ${outcome.service}: unchanged`;
    case "recreated":
      return `[deploy] Shared service ${outcome.service}: recreated with its new definition`;
    case "held":
      return `[deploy] Shared service ${outcome.service}: definition changed, held — ${outcome.reason}`;
    case "unknown":
      return `[deploy] Shared service ${outcome.service}: drift not checked — ${outcome.reason}`;
  }
}
