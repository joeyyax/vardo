import { dependsOnKeys, type ComposeFile, type ComposeService } from "./compose-types";
import { declaredVolumes, slotIndependentMounts, volumeSharedServices } from "./volume-shared";

/** Compose extension field marking a service as deployed once, outside blue/green. */
export const SHARED_MARKER = "x-vardo-shared";

export function isSharedService(service: ComposeService | undefined): boolean {
  return service?.[SHARED_MARKER] === true;
}

/**
 * Services a deploy must not rotate: marked ones plus those detected holding a volume both slots address.
 * Detected ones are dropped if that would leave nothing to deploy or they depend on a rotating service.
 */
export function nonRotatingServices(compose: ComposeFile): Set<string> {
  const services = compose.services ?? {};
  const marked = new Set(Object.keys(services).filter((n) => isSharedService(services[n])));

  const detected = [...volumeSharedServices(compose)].filter((n) => !marked.has(n));
  if (detected.length === 0) return marked;

  const shared = new Set([...marked, ...detected]);
  if (shared.size === Object.keys(services).length) return marked;

  // Fixpoint: dropping one can strand another.
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
 * Split a compose file into rotating and shared services.
 * Slotted→shared depends_on is dropped (cross-project, else "undefined service"); shared→slotted is rejected.
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
 * Compose project for an app's shared services, scoped by environment.
 * A compose `name:` wins only in the app's own environment; previews must never attach to production's database.
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

/** The `-<env>-<slot>` tail of a generated project name. `pr-<n>` is the one env name with a hyphen. */
const PROJECT_SUFFIX = /-(pr-\d+|[^-]+)-(blue|green|shared)$/;

/** App a compose project belongs to: paperless-staging-green → paperless. Unsuffixed names come back unchanged. */
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
 * `docker compose` arguments confining a command to the rotating set. Empty when nothing is shared.
 * `--no-deps` is required, or compose starts depends_on targets into this project.
 */
export function slotScopeArgs(partition: SlotPartition): string[] {
  if (Object.keys(partition.shared).length === 0) return [];
  return ["--no-deps", ...Object.keys(partition.slotted)];
}

/** Likely cause when a rotating service fails while the slots overlap and it mounts a directory the old slot holds. */
export function slotOverlapDiagnosis(
  compose: ComposeFile,
  slotted: Record<string, ComposeService>,
  overlapped: boolean,
): string | null {
  if (!overlapped) return null;

  const declared = declaredVolumes(compose);
  const held = Object.entries(slotted)
    .filter(([, service]) => !service.build)
    .map(([name, service]) => [name, slotIndependentMounts(service.volumes, declared)] as const)
    .filter(([, mounts]) => mounts.length > 0)
    .map(([name, mounts]) => `${name} (${mounts.join(", ")})`);
  if (held.length === 0) return null;

  return (
    `Both slots ran at once, and these rotating services mount a directory the old slot ` +
    `still held: ${held.join("; ")}. An engine that locks its data directory cannot be stood ` +
    `up twice — mark it ${SHARED_MARKER}: true to deploy it once and leave it in place.`
  );
}
