// Resolves a dump spec to the container running it now.

import { listContainers, inspectContainer } from "@/lib/docker/client";
import type { DumpSpec } from "./dump-spec";

const COMPOSE_SERVICE_LABEL = "com.docker.compose.service";

export type ResolvedDbContainer = {
  id: string;
  name: string;
  /** The container's own environment — where credentials are read from. */
  env: string[];
};

/** Running container for a spec's compose service, scoped to app and environment. Null when stopped. */
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
