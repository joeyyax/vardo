// Matches an app row to its containers. Kept dependency-free for lightweight callers.

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

/** Containers belonging to an app, most specific match first: id label, parent + service, compose labels, then name. */
export function matchContainers(app: ReconcilableApp, all: ContainerInfo[]): ContainerInfo[] {
  // Preview containers carry the app's labels but must not decide its status.
  const containers = all.filter((c) => !/^pr-\d+$/.test(label(c, "environment") ?? ""));

  if (app.importedContainerId) {
    const imported = containers.filter((c) => c.id === app.importedContainerId);
    if (imported.length > 0) return imported;
  }

  const byAppId = containers.filter((c) => label(c, "project.id") === app.id);
  if (byAppId.length > 0) return byAppId;

  // Decomposed children carry the parent's vardo.project.id.
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
