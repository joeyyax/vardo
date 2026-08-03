// ---------------------------------------------------------------------------
// Matching an app row to the containers that belong to it.
//
// Pure and dependency-free so the callers that only need the matcher — metrics,
// cron, container lookup — don't pull a scheduler into their bundle.
// ---------------------------------------------------------------------------

import type { ContainerInfo } from "./client";
import { composeProjectApp } from "./slot-partition";

/** An app row as far as container matching is concerned. */
export type ReconcilableApp = {
  id: string;
  name: string;
  status: string;
  parentAppId: string | null;
  composeService: string | null;
  containerName: string | null;
  importedContainerId: string | null;
};

function label(c: ContainerInfo, key: string): string | undefined {
  return c.labels[`vardo.${key}`] ?? c.labels[`host.${key}`];
}

/** App the container's compose project belongs to: paperless-staging-green → paperless. */
function projectApp(c: ContainerInfo): string | undefined {
  const project = c.labels["com.docker.compose.project"];
  return project === undefined ? undefined : composeProjectApp(project);
}

/**
 * Containers belonging to an app, most specific match first.
 *
 * Vardo-deployed containers carry vardo.project.id; a decomposed child narrows
 * that set by compose service. Vardo's own control plane is started by plain
 * `docker compose` and carries no vardo labels, so compose project/service and
 * the container name are checked too.
 */
export function matchContainers(app: ReconcilableApp, containers: ContainerInfo[]): ContainerInfo[] {
  if (app.importedContainerId) {
    const imported = containers.filter((c) => c.id === app.importedContainerId);
    if (imported.length > 0) return imported;
  }

  const byAppId = containers.filter((c) => label(c, "project.id") === app.id);
  if (byAppId.length > 0) return byAppId;

  // Decomposed children carry the PARENT's vardo.project.id, so narrow the
  // parent's containers by compose service.
  if (app.parentAppId && app.composeService) {
    const byParent = containers.filter(
      (c) =>
        label(c, "project.id") === app.parentAppId &&
        c.labels["com.docker.compose.service"] === app.composeService,
    );
    if (byParent.length > 0) return byParent;
  }

  if (app.composeService) {
    const byService = containers.filter(
      (c) => c.labels["com.docker.compose.service"] === app.composeService,
    );
    const scoped = byService.filter(
      (c) =>
        label(c, "project") === app.name ||
        projectApp(c) === app.name ||
        `${projectApp(c)}-${app.composeService}` === app.name,
    );
    if (scoped.length > 0) return scoped;
  }

  const byName = containers.filter(
    (c) => c.name === app.containerName || c.name === app.name,
  );
  if (byName.length > 0) return byName;

  const byProject = containers.filter(
    (c) =>
      label(c, "project") === app.name ||
      c.labels["com.docker.compose.project"] === app.name ||
      projectApp(c) === app.name,
  );
  return byProject;
}
