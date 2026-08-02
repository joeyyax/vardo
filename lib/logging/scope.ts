// ---------------------------------------------------------------------------
// Which containers a log request covers.
//
// Compose decomposition gives a child app no deploy directory of its own — its
// containers live under the parent's compose project — so log reads resolve
// through the parent and scope by service name.
// ---------------------------------------------------------------------------

import { db } from "@/lib/db";
import { apps } from "@/lib/db/schema";
import { eq } from "drizzle-orm";

export type LogScopeApp = {
  id: string;
  name: string;
  parentAppId: string | null;
  composeService: string | null;
};

export type LogScope = {
  /** Compose project name — the parent's for a decomposed service. */
  project: string;
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
    return { project: app.name, service: null, services, prefixed: services.length > 1 };
  }

  const parent = await db.query.apps.findFirst({
    where: eq(apps.id, app.parentAppId),
    columns: { name: true },
  });

  const service = opts.allServices ? null : app.composeService;
  return {
    project: parent?.name ?? app.name,
    service,
    services,
    prefixed: !service && services.length > 1,
  };
}
