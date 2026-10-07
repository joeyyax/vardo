// Shared-service images, resolved before anything stops. Traefik can't run twice, so a pull after stop is downtime.

import type { ComposeService } from "../compose-types";

/** Whether this host already holds an image. */
export type ImageProbe = (image: string) => Promise<boolean>;

/**
 * Shared services whose image has to come from a registry; images already on the host are skipped.
 * Shared `up` runs `--no-recreate`, so re-pulling a tag would only move it.
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

