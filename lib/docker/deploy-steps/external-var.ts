// ---------------------------------------------------------------------------
// Resolves `${app.VAR}` references to another app in the same org.
// ---------------------------------------------------------------------------

import { db } from "@/lib/db";
import { apps, environments, environmentEnv } from "@/lib/db/schema";
import { eq, and } from "drizzle-orm";
import { decryptOrFallback } from "@/lib/crypto/encrypt";
import { parseEnvToMap } from "@/lib/env/parse-env";

export type ExternalVarScope = {
  organizationId: string;
  /** Project of the app being deployed. */
  projectId: string | null;
  groupEnvironmentId?: string;
  /** Set for a non-default environment deploy. */
  environmentName?: string;
  log?: (line: string) => void;
};

const IDENTITY_FIELDS = new Set(["name", "displayName", "port", "id", "gitUrl", "gitBranch", "imageName"]);

export function externalVarResolver(scope: ExternalVarScope) {
  const warned = new Set<string>();
  const warn = (line: string) => {
    if (warned.has(line)) return;
    warned.add(line);
    scope.log?.(line);
  };
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
    // A sibling's preview stands in for production's service when it has one.
    if (scope.environmentName && !IDENTITY_FIELDS.has(varKey)) {
      const refEnv =
        scope.groupEnvironmentId && refApp.projectId && refApp.projectId === scope.projectId
          ? await db.query.environments.findFirst({
              where: and(
                eq(environments.appId, refApp.id),
                eq(environments.groupEnvironmentId, scope.groupEnvironmentId),
              ),
              columns: { id: true, domain: true },
            })
          : undefined;

      if (refEnv) {
        if (varKey === "domain" || varKey === "host") return refEnv.domain;
        if (varKey === "url") return refEnv.domain ? `https://${refEnv.domain}` : null;
        if (varKey === "internalHost") {
          warn(`[deploy] Warning: \${${appName}.internalHost} names production's ${appName} — environments have no internal hostname`);
          return builtinFields.internalHost;
        }
        const snapshot = await db.query.environmentEnv.findFirst({
          where: eq(environmentEnv.environmentId, refEnv.id),
        });
        if (snapshot) {
          const { content, decryptFailed } = decryptOrFallback(snapshot.envContent, refApp.organizationId);
          if (decryptFailed) {
            throw new Error(`Could not decrypt ${refApp.name}'s ${scope.environmentName} env — check ENCRYPTION_MASTER_KEY`);
          }
          return parseEnvToMap(content)[varKey] ?? null;
        }
        warn(
          `[deploy] Warning: \${${appName}.${varKey}} points at production's ${appName} — its ${scope.environmentName} environment has no env of its own`,
        );
      } else {
        warn(
          `[deploy] Warning: \${${appName}.${varKey}} points at production's ${appName} — it has no ${scope.environmentName} environment`,
        );
      }
    }

    if (varKey in builtinFields) return builtinFields[varKey];

    if (!refApp.envContent) return null;
    const { content: refText } = decryptOrFallback(refApp.envContent, refApp.organizationId);
    if (!refText) return null;
    const refMap = parseEnvToMap(refText);
    return refMap[varKey] ?? null;
  };
}
