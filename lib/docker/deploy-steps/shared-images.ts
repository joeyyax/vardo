// ---------------------------------------------------------------------------
// Images the shared project needs, decided before anything is stopped.
//
// A shared service is the one thing that cannot be run twice — Traefik holds
// :80 and :443 for every site on the host. There is no second copy to serve
// while a pull runs, so a pull issued after the old container is gone is total
// downtime, and an unreachable registry makes it open-ended.
// ---------------------------------------------------------------------------

import type { ComposeService } from "../compose-types";

/** Whether this host already holds an image. */
export type ImageProbe = (image: string) => Promise<boolean>;

/**
 * Shared services whose image has to come from a registry.
 *
 * An image already on the host is skipped. The shared `up` runs
 * `--no-recreate`, so re-pulling a tag would move it without replacing the
 * container running the old one; a digest-pinned ref that is local is by
 * definition the image the compose file names.
 */
export async function sharedPullTargets(
  shared: Record<string, ComposeService>,
  builtImageRefs: string[],
  isLocal: ImageProbe,
): Promise<string[]> {
  const built = new Set(builtImageRefs);
  const targets: string[] = [];
  for (const [name, service] of Object.entries(shared)) {
    const image = service.image;
    if (!image || service.build || built.has(image)) continue;
    if (!(await isLocal(image))) targets.push(name);
  }
  return targets;
}

/** Container each shared service runs as. */
export function sharedContainerNames(
  shared: Record<string, ComposeService>,
  project: string,
): Map<string, string> {
  return new Map(
    Object.entries(shared).map(([name, service]) => [
      service.container_name ?? `${project}-${name}-1`,
      name,
    ]),
  );
}

/**
 * Services a `--dry-run up` says it would replace, meaning the running
 * container no longer matches the compose file. Compose prints `Recreate` for
 * those and `Creating` for one that does not exist yet.
 */
export function driftedFromDryRun(output: string, containers: Map<string, string>): string[] {
  const drifted: string[] = [];
  for (const line of output.split(/\r?\n/)) {
    const container = /^\s*Container\s+(\S+)\s+Recreate\s*$/.exec(line)?.[1];
    const service = container ? containers.get(container) : undefined;
    if (service && !drifted.includes(service)) drifted.push(service);
  }
  return drifted;
}
