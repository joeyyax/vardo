import { dependsOnKeys, type ComposeFile, type ComposeService } from "./compose-types";
import { volumeSharedServices } from "./volume-shared";

/**
 * Compose extension field marking a service as exempt from blue/green.
 *
 * A database, a broker or a proxy cannot be stood up twice — one owns the data
 * directory, another owns port 443. Without a way to say so, the whole app has
 * to fall back to stop-then-start, which is why Vardo's own stack is still
 * deployed by hand.
 */
export const SHARED_MARKER = "x-vardo-shared";

export function isSharedService(service: ComposeService | undefined): boolean {
  return service?.[SHARED_MARKER] === true;
}

/**
 * Services a deploy must not rotate: the marked ones, plus the ones detection
 * caught holding a volume both slots address.
 *
 * A detected service is dropped again when promoting it would leave nothing to
 * deploy, or when it depends on something that still rotates. The marked form
 * rejects both outright, but a compose file that never claimed to be shared
 * should not start failing to deploy.
 */
export function nonRotatingServices(compose: ComposeFile): Set<string> {
  const services = compose.services ?? {};
  const marked = new Set(Object.keys(services).filter((n) => isSharedService(services[n])));

  const detected = [...volumeSharedServices(compose)].filter((n) => !marked.has(n));
  if (detected.length === 0) return marked;

  const shared = new Set([...marked, ...detected]);
  if (shared.size === Object.keys(services).length) return marked;

  // Repeated to a fixpoint: dropping one candidate can leave another depending
  // on a service that now rotates.
  for (let changed = true; changed; ) {
    changed = false;
    for (const name of detected) {
      if (!shared.has(name)) continue;
      const deps = dependsOnKeys(services[name].depends_on ?? []);
      if (deps.some((dep) => dep in services && !shared.has(dep))) {
        shared.delete(name);
        changed = true;
      }
    }
  }
  return shared;
}

export type SlotPartition = {
  /** Services deployed once and left alone across swaps. */
  shared: Record<string, ComposeService>;
  /** Services that get a blue and a green copy. */
  slotted: Record<string, ComposeService>;
};

export class SlotPartitionError extends Error {}

/**
 * Split a compose file into the services that rotate and the ones that persist.
 * Membership is `nonRotatingServices`: the marker, plus detection.
 *
 * `depends_on` pointing from a slotted service at a shared one is dropped:
 * the two end up in different compose projects, where the dependency cannot be
 * expressed, and leaving it in makes `up` fail with "undefined service". The
 * shared set is started first, so ordering still holds.
 *
 * The reverse — a shared service depending on a slotted one — is rejected. It
 * would mean the persistent half waits on the half being replaced, so the
 * shared set could not start without the very slot the deploy is swapping out.
 */
export function partitionBySlot(compose: ComposeFile): SlotPartition {
  const services = compose.services ?? {};
  const shared: Record<string, ComposeService> = {};
  const slotted: Record<string, ComposeService> = {};
  const nonRotating = nonRotatingServices(compose);

  for (const [name, service] of Object.entries(services)) {
    (nonRotating.has(name) ? shared : slotted)[name] = service;
  }

  if (Object.keys(shared).length === 0) return { shared, slotted };

  if (Object.keys(slotted).length === 0) {
    throw new SlotPartitionError(
      `Every service is marked ${SHARED_MARKER}, so there is nothing left to deploy. Leave at least one service out of it.`,
    );
  }

  for (const [name, service] of Object.entries(shared)) {
    const bad = dependsOnKeys(service.depends_on ?? []).filter((dep) => dep in slotted);
    if (bad.length > 0) {
      throw new SlotPartitionError(
        `Service "${name}" is marked ${SHARED_MARKER} but depends on ${bad.join(", ")}, which ${bad.length === 1 ? "is" : "are"} replaced on every deploy. A shared service can only depend on other shared services.`,
      );
    }
  }

  for (const [name, service] of Object.entries(slotted)) {
    slotted[name] = withoutDependenciesOn(service, shared);
  }

  return { shared, slotted };
}

/** Strip depends_on entries naming a service outside this compose project. */
function withoutDependenciesOn(
  service: ComposeService,
  outside: Record<string, ComposeService>,
): ComposeService {
  const dependsOn = service.depends_on;
  if (!dependsOn) return service;

  if (Array.isArray(dependsOn)) {
    const kept = dependsOn.filter((dep) => !(dep in outside));
    if (kept.length === dependsOn.length) return service;
    const next = { ...service };
    if (kept.length === 0) delete next.depends_on;
    else next.depends_on = kept;
    return next;
  }

  const kept = Object.fromEntries(
    Object.entries(dependsOn).filter(([dep]) => !(dep in outside)),
  );
  if (Object.keys(kept).length === Object.keys(dependsOn).length) return service;
  const next = { ...service };
  if (Object.keys(kept).length === 0) delete next.depends_on;
  else next.depends_on = kept;
  return next;
}

/** A compose file carrying only the named services, keeping networks and volumes. */
export function composeSubset(
  compose: ComposeFile,
  services: Record<string, ComposeService>,
): ComposeFile {
  return { ...compose, services };
}

/**
 * Compose project holding an app's shared services.
 *
 * Scoped by environment, not just app: a PR preview must get its own database
 * rather than attaching to production's.
 *
 * A top-level `name:` in the compose file wins, and only in the app's own
 * environment. That is what lets an already-running stack adopt this layout:
 * the shared services stay in the project that created them, under the volume
 * names they already have, so nothing has to be stopped or copied. Previews
 * still get their own, or they would attach to production's database.
 */
export function sharedProjectName(
  appName: string,
  envName: string,
  composeName?: string,
): string {
  const generated = `${appName}-${envName}-shared`;
  if (!composeName) return generated;
  return isOwnEnvironment(envName) ? composeName : generated;
}

/** Preview environments are named `pr-<n>`; anything else is the app's own. */
function isOwnEnvironment(envName: string): boolean {
  return !envName.startsWith("pr-");
}

/**
 * The `-<env>-<slot>` tail every generated compose project name carries.
 * `pr-<n>` is spelled out because it is the one env name with a hyphen.
 */
const PROJECT_SUFFIX = /-(pr-\d+|[^-]+)-(blue|green|shared)$/;

/**
 * App a compose project belongs to: paperless-staging-green → paperless.
 * A name with no suffix comes back unchanged — an adopted stack, or a shared
 * project taking its name from the compose file's top-level `name:`.
 */
export function composeProjectApp(project: string): string {
  return project.replace(PROJECT_SUFFIX, "");
}

/** Environment a compose project belongs to: paperless-pr-7-shared → pr-7. Null when the name carries none. */
export function composeProjectEnvironment(project: string): string | null {
  return PROJECT_SUFFIX.exec(project)?.[1] ?? null;
}

/** Whether this app needs the two-project deploy at all. */
export function hasSharedServices(compose: ComposeFile): boolean {
  return nonRotatingServices(compose).size > 0;
}

/**
 * Extra `docker compose` arguments confining a command to the rotating set.
 *
 * Empty for an app with nothing shared, so the overwhelming majority of
 * deploys issue exactly the commands they always did. `--no-deps` is required
 * whenever a service list is passed: compose would otherwise start a named
 * service's `depends_on` targets into whichever project it was given.
 */
export function slotScopeArgs(partition: SlotPartition): string[] {
  if (Object.keys(partition.shared).length === 0) return [];
  return ["--no-deps", ...Object.keys(partition.slotted)];
}
