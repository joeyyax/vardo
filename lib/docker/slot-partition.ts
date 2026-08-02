import { dependsOnKeys, type ComposeFile, type ComposeService } from "./compose-types";

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

export type SlotPartition = {
  /** Services deployed once and left alone across swaps. */
  shared: Record<string, ComposeService>;
  /** Services that get a blue and a green copy. */
  slotted: Record<string, ComposeService>;
};

export class SlotPartitionError extends Error {}

/**
 * Split a compose file into the services that rotate and the ones that persist.
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

  for (const [name, service] of Object.entries(services)) {
    (isSharedService(service) ? shared : slotted)[name] = service;
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

/** Whether this app needs the two-project deploy at all. */
export function hasSharedServices(compose: ComposeFile): boolean {
  return Object.values(compose.services ?? {}).some(isSharedService);
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
