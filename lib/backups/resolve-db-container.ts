// ---------------------------------------------------------------------------
// Which container a dump spec means, right now.
//
// The same resolution shape resolveDockerVolume already uses for tar: ask
// Docker what is running rather than trusting a name that was true once.
// ---------------------------------------------------------------------------

import { listContainers, inspectContainer } from "@/lib/docker/client";
import type { DumpSpec } from "./dump-spec";

const COMPOSE_SERVICE_LABEL = "com.docker.compose.service";

export type ResolvedDbContainer = {
  id: string;
  name: string;
  /** The container's own environment — where credentials are read from. */
  env: string[];
};

/**
 * Find the running container for a spec's compose service.
 *
 * Scoped to the app and environment, so a staging database is never dumped
 * into a production backup. Returns null when nothing is running, which is a
 * legitimate state for a stopped app and must not be reported as corruption.
 */
export async function resolveDbContainer(
  spec: DumpSpec,
  app: { id: string; name: string },
  environmentName: string | undefined,
  logFn: (msg: string) => void,
): Promise<ResolvedDbContainer | null> {
  const containers = await listContainers({ id: app.id, name: app.name }, environmentName);

  for (const c of containers) {
    if (c.state !== "running") continue;
    const info = await inspectContainer(c.id);
    if (info.labels[COMPOSE_SERVICE_LABEL] !== spec.service) continue;

    logFn(`Resolved service "${spec.service}" → ${info.name} (${c.id.slice(0, 12)})`);
    return { id: c.id, name: info.name, env: info.env };
  }

  const seen = containers.length;
  logFn(
    `No running container for service "${spec.service}" in ${app.name}` +
      (environmentName ? `/${environmentName}` : "") +
      ` (${seen} container(s) inspected)`,
  );
  return null;
}
