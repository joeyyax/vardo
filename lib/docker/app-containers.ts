// Which containers belong to one app. Stack children look up under the parent.

import { listContainers, type ContainerInfo, type ContainerScope } from "./client";
import { matchContainers, type ReconcilableApp } from "./container-match";

/** An app row as far as container lookup is concerned, plus the stack it belongs to. */
export type ContainerOwnerApp = ReconcilableApp & {
  parentApp?: { name: string } | null;
};

/** App whose containers the target's live under. */
export function appContainerScope(app: ContainerOwnerApp): ContainerScope {
  return {
    id: app.parentAppId ?? app.id,
    name: app.parentApp?.name ?? app.name,
  };
}

/** Running containers belonging to this app alone. */
export async function listAppContainers(app: ContainerOwnerApp): Promise<ContainerInfo[]> {
  const containers = await listContainers(appContainerScope(app));
  return matchContainers(app, containers);
}
