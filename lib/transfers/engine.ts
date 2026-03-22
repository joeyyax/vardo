import { db } from "@/lib/db";
import {
  apps,
  envVars,
  appTransfers,
} from "@/lib/db/schema";
import { eq, and, isNull } from "drizzle-orm";
import { nanoid } from "nanoid";
import { extractExpressions, validateExpression } from "@/lib/env/resolve";

/**
 * Analyze what would happen if an app is transferred.
 * Returns list of cross-project refs that would become unresolvable.
 */
export async function analyzeTransfer(
  appId: string,
  sourceOrgId: string,
  destinationOrgId: string,
): Promise<{
  frozenRefs: { key: string; originalRef: string; currentValue: string }[];
  warnings: string[];
}> {
  // Load app's env vars (base-level, no environment override)
  const vars = await db.query.envVars.findMany({
    where: and(eq(envVars.appId, appId), isNull(envVars.environmentId)),
  });

  // Load all app names in destination org
  const destApps = await db.query.apps.findMany({
    where: eq(apps.organizationId, destinationOrgId),
    columns: { name: true },
  });
  const destAppNames = new Set(destApps.map((a) => a.name));

  // Load all app names in source org (for reference resolution)
  const sourceApps = await db.query.apps.findMany({
    where: eq(apps.organizationId, sourceOrgId),
    columns: { name: true },
  });

  const frozenRefs: { key: string; originalRef: string; currentValue: string }[] = [];
  const warnings: string[] = [];

  for (const v of vars) {
    const expressions = extractExpressions(v.value);
    for (const expr of expressions) {
      const { type, target } = validateExpression(expr);
      if (type === "cross-project") {
        const refAppName = target.split(".")[0];
        // If the referenced app won't exist in the destination org
        if (!destAppNames.has(refAppName)) {
          frozenRefs.push({
            key: v.key,
            originalRef: `\${${expr}}`,
            currentValue: v.value,
          });
        }
      }
      if (type === "org-var") {
        warnings.push(
          `Env var "${v.key}" references org variable "\${org.${target}}" which may not exist in the destination org`,
        );
      }
    }
  }

  return { frozenRefs, warnings };
}

/**
 * Initiate a transfer -- creates a pending transfer record.
 */
export async function initiateTransfer(opts: {
  appId: string;
  sourceOrgId: string;
  destinationOrgId: string;
  initiatedBy: string;
  note?: string;
}): Promise<string> {
  const analysis = await analyzeTransfer(
    opts.appId,
    opts.sourceOrgId,
    opts.destinationOrgId,
  );

  const id = nanoid();
  await db.insert(appTransfers).values({
    id,
    appId: opts.appId,
    sourceOrgId: opts.sourceOrgId,
    destinationOrgId: opts.destinationOrgId,
    initiatedBy: opts.initiatedBy,
    status: "pending",
    frozenRefs: analysis.frozenRefs.map((r) => ({
      key: r.key,
      originalRef: r.originalRef,
      frozenValue: r.currentValue,
    })),
    note: opts.note,
  });

  return id;
}

/**
 * Accept a transfer -- move the app to the destination org.
 * Freezes unresolvable cross-project refs by replacing expressions with literal values.
 */
export async function acceptTransfer(
  transferId: string,
  respondedBy: string,
): Promise<void> {
  const transfer = await db.query.appTransfers.findFirst({
    where: eq(appTransfers.id, transferId),
  });

  if (!transfer || transfer.status !== "pending") {
    throw new Error("Transfer not found or not pending");
  }

  // Freeze cross-project refs that won't resolve in the new org
  if (transfer.frozenRefs && transfer.frozenRefs.length > 0) {
    for (const ref of transfer.frozenRefs) {
      const vars = await db.query.envVars.findMany({
        where: and(
          eq(envVars.appId, transfer.appId),
          eq(envVars.key, ref.key),
          isNull(envVars.environmentId),
        ),
      });
      for (const v of vars) {
        if (v.value.includes(ref.originalRef)) {
          await db
            .update(envVars)
            .set({
              value: v.value.replace(
                ref.originalRef,
                ref.frozenValue,
              ),
              updatedAt: new Date(),
            })
            .where(eq(envVars.id, v.id));
        }
      }
    }
  }

  // Move the app to the destination org
  await db
    .update(apps)
    .set({
      organizationId: transfer.destinationOrgId,
      projectId: null, // Remove from project (projects are org-scoped)
      updatedAt: new Date(),
    })
    .where(eq(apps.id, transfer.appId));

  // Update transfer status
  await db
    .update(appTransfers)
    .set({
      status: "accepted",
      respondedBy,
      respondedAt: new Date(),
    })
    .where(eq(appTransfers.id, transferId));
}

/**
 * Reject or cancel a transfer.
 */
export async function rejectTransfer(
  transferId: string,
  respondedBy: string,
  status: "rejected" | "cancelled" = "rejected",
): Promise<void> {
  await db
    .update(appTransfers)
    .set({
      status,
      respondedBy,
      respondedAt: new Date(),
    })
    .where(eq(appTransfers.id, transferId));
}
