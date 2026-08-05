import { db } from "@/lib/db";
import {
  apps,
  envVars,
  appTransfers,
  projects,
} from "@/lib/db/schema";
import { eq, and, isNull } from "drizzle-orm";
import { nanoid } from "nanoid";
import { extractExpressions, validateExpression } from "@/lib/env/resolve";

type CrossProjectRef = {
  key: string;
  refApp: string;
  originalRef: string;
  currentValue: string;
};

/**
 * Analyze what would happen if an app is transferred.
 * Reads the source app only; which refs actually freeze is decided on accept.
 */
export async function analyzeTransfer(appId: string): Promise<{
  crossProjectRefs: CrossProjectRef[];
  warnings: string[];
}> {
  // Load app's env vars (base-level, no environment override)
  const vars = await db.query.envVars.findMany({
    where: and(eq(envVars.appId, appId), isNull(envVars.environmentId)),
  });

  const crossProjectRefs: CrossProjectRef[] = [];
  const warnings: string[] = [];

  for (const v of vars) {
    const expressions = extractExpressions(v.value);
    for (const expr of expressions) {
      const { type, target } = validateExpression(expr);
      if (type === "cross-project") {
        crossProjectRefs.push({
          key: v.key,
          refApp: target.split(".")[0],
          originalRef: `\${${expr}}`,
          currentValue: v.value,
        });
      }
      if (type === "org-var") {
        warnings.push(
          `Env var "${v.key}" references org variable "\${org.${target}}" which may not exist in the destination org`,
        );
      }
    }
  }

  return { crossProjectRefs, warnings };
}

/** Cross-project refs with no app of that name in the destination org. */
async function resolveFrozenRefs(
  appId: string,
  destinationOrgId: string,
): Promise<{ key: string; originalRef: string; frozenValue: string }[]> {
  const { crossProjectRefs } = await analyzeTransfer(appId);

  const destApps = await db.query.apps.findMany({
    where: eq(apps.organizationId, destinationOrgId),
    columns: { name: true },
  });
  const destAppNames = new Set(destApps.map((a) => a.name));

  return crossProjectRefs
    .filter((r) => !destAppNames.has(r.refApp))
    .map((r) => ({
      key: r.key,
      originalRef: r.originalRef,
      frozenValue: r.currentValue,
    }));
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
  const id = nanoid();
  await db.insert(appTransfers).values({
    id,
    appId: opts.appId,
    sourceOrgId: opts.sourceOrgId,
    destinationOrgId: opts.destinationOrgId,
    initiatedBy: opts.initiatedBy,
    status: "pending",
    frozenRefs: [],
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
  const frozenRefs = await resolveFrozenRefs(
    transfer.appId,
    transfer.destinationOrgId,
  );

  if (frozenRefs.length > 0) {
    for (const ref of frozenRefs) {
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

  // Ensure a "Default" project exists in the destination org
  const [destProject] = await db
    .insert(projects)
    .values({
      id: nanoid(),
      organizationId: transfer.destinationOrgId,
      name: "default",
      displayName: "Default",
    })
    .onConflictDoUpdate({
      target: [projects.organizationId, projects.name],
      set: { updatedAt: new Date() },
    })
    .returning({ id: projects.id });

  // Move the app to the destination org
  await db
    .update(apps)
    .set({
      organizationId: transfer.destinationOrgId,
      projectId: destProject!.id,
      updatedAt: new Date(),
    })
    .where(eq(apps.id, transfer.appId));

  // Update transfer status
  await db
    .update(appTransfers)
    .set({
      status: "accepted",
      frozenRefs,
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
