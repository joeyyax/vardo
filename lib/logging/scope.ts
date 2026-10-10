// Which containers a log request covers. A child app resolves through its parent's compose project.

import { db } from "@/lib/db";
import { apps, environments } from "@/lib/db/schema";
import { and, eq, inArray } from "drizzle-orm";

export type LogScopeApp = {
  id: string;
  name: string;
  parentAppId: string | null;
  composeService: string | null;
};

export type LogScope = {
  /** Compose project name — the parent's for a decomposed service. */
  project: string;
  /** App id whose containers carry the project label — the parent's for a decomposed service. */
  projectId: string;
  /** Service to scope to, or null for the whole stack. */
  service: string | null;
  /** Every service in the stack, for the viewer's service pills. */
  services: string[];
  /** Tag lines with their service — only meaningful when reading several at once. */
  prefixed: boolean;
};

export async function resolveLogScope(
  app: LogScopeApp,
  opts: { allServices?: boolean } = {},
): Promise<LogScope> {
  const parentId = app.parentAppId ?? app.id;

  const siblings = await db.query.apps.findMany({
    where: eq(apps.parentAppId, parentId),
    columns: { composeService: true },
  });
  const services = siblings.map((s) => s.composeService).filter((s): s is string => !!s).sort();

  if (!app.parentAppId) {
    return { project: app.name, projectId: app.id, service: null, services, prefixed: services.length > 1 };
  }

  const parent = await db.query.apps.findFirst({
    where: eq(apps.id, app.parentAppId),
    columns: { name: true },
  });

  const service = opts.allServices ? null : app.composeService;
  return {
    project: parent?.name ?? app.name,
    projectId: parent ? app.parentAppId : app.id,
    service,
    services,
    prefixed: !service && services.length > 1,
  };
}

export const DEFAULT_LOG_ENVIRONMENT = "production";

/** The requested environment if the app (or its parent) has it, else null. Unset means production. */
export async function resolveLogEnvironment(
  app: Pick<LogScopeApp, "id" | "parentAppId">,
  requested: string | null,
): Promise<string | null> {
  if (!requested || requested === DEFAULT_LOG_ENVIRONMENT) return DEFAULT_LOG_ENVIRONMENT;

  const appIds = app.parentAppId ? [app.id, app.parentAppId] : [app.id];
  const env = await db.query.environments.findFirst({
    where: and(inArray(environments.appId, appIds), eq(environments.name, requested)),
    columns: { name: true },
  });
  return env?.name ?? null;
}
