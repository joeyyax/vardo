// ---------------------------------------------------------------------------
// Resolves `${app.VAR}` references to another app in the same org.
// ---------------------------------------------------------------------------

import { db } from "@/lib/db";
import { apps, environments } from "@/lib/db/schema";
import { eq, and } from "drizzle-orm";
import { decryptOrFallback } from "@/lib/crypto/encrypt";
import { parseEnvToMap } from "@/lib/env/parse-env";

export type ExternalVarScope = {
  organizationId: string;
  /** Project of the app being deployed. */
  projectId: string | null;
  groupEnvironmentId?: string;
};

export function externalVarResolver(scope: ExternalVarScope) {
  return async (appName: string, varKey: string): Promise<string | null> => {
    const refApp = await db.query.apps.findFirst({
      where: and(
        eq(apps.organizationId, scope.organizationId),
        eq(apps.name, appName),
      ),
      columns: {
        id: true,
        name: true,
        displayName: true,
        organizationId: true,
        projectId: true,
        containerPort: true,
        gitUrl: true,
        gitBranch: true,
        imageName: true,
        envContent: true,
      },
      with: { domains: { columns: { domain: true }, limit: 1 } },
    });
    if (!refApp) return null;

    const builtinFields: Record<string, string | null> = {
      name: refApp.name,
      displayName: refApp.displayName,
      port: refApp.containerPort?.toString() ?? null,
      id: refApp.id,
      domain: refApp.domains[0]?.domain ?? null,
      url: refApp.domains[0]?.domain
        ? `https://${refApp.domains[0].domain}`
        : null,
      host: refApp.domains[0]?.domain ?? null,
      internalHost: refApp.name,
      gitUrl: refApp.gitUrl,
      gitBranch: refApp.gitBranch,
      imageName: refApp.imageName,
    };
    if (varKey in builtinFields) return builtinFields[varKey];

    if (
      scope.groupEnvironmentId &&
      refApp.projectId &&
      scope.projectId &&
      refApp.projectId === scope.projectId
    ) {
      const refEnv = await db.query.environments.findFirst({
        where: and(
          eq(environments.appId, refApp.id),
          eq(environments.groupEnvironmentId, scope.groupEnvironmentId),
        ),
        columns: { id: true },
      });

      if (refEnv) {
        // Environment-specific resolution would go here
      }
    }

    if (!refApp.envContent) return null;
    const { content: refText } = decryptOrFallback(refApp.envContent, refApp.organizationId);
    if (!refText) return null;
    const refMap = parseEnvToMap(refText);
    return refMap[varKey] ?? null;
  };
}
