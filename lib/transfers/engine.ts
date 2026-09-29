import { db } from "@/lib/db";
import {
  apps,
  deployKeys,
  deployments,
  envVars,
  appTransfers,
  projects,
  volumes,
} from "@/lib/db/schema";
import { eq, and, isNull, isNotNull, inArray, or } from "drizzle-orm";
import { nanoid } from "nanoid";
import { extractExpressions, validateExpression } from "@/lib/env/resolve";
import { decrypt, encrypt, isEncrypted } from "@/lib/crypto/encrypt";
import { logger } from "@/lib/logger";

const log = logger.child("transfers");

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** A value encrypted under one org's key, rewritten under another's. Plaintext passes through. */
export function reencryptForOrg(value: string, fromOrgId: string, toOrgId: string): string {
  if (!isEncrypted(value)) return value;
  return encrypt(decrypt(value, fromOrgId), toOrgId);
}

/**
 * Move the org-keyed secrets of these apps from one org's key to another's.
 * Throws when a live secret cannot be read, so the move never strands one.
 * A deployment snapshot that is already unreadable is left as it is.
 */
async function reencryptAppSecrets(
  tx: Tx,
  appIds: string[],
  fromOrgId: string,
  toOrgId: string,
): Promise<void> {
  const appRows = await tx.query.apps.findMany({
    where: inArray(apps.id, appIds),
    columns: { id: true, name: true, envContent: true },
  });
  for (const row of appRows) {
    if (!row.envContent) continue;
    let next: string;
    try {
      next = reencryptForOrg(row.envContent, fromOrgId, toOrgId);
    } catch {
      throw new Error(`Env vars for "${row.name}" cannot be decrypted — transfer aborted`);
    }
    if (next !== row.envContent) {
      await tx.update(apps).set({ envContent: next }).where(eq(apps.id, row.id));
    }
  }

  const varRows = await tx.query.envVars.findMany({
    where: inArray(envVars.appId, appIds),
    columns: { id: true, key: true, value: true },
  });
  for (const row of varRows) {
    let next: string;
    try {
      next = reencryptForOrg(row.value, fromOrgId, toOrgId);
    } catch {
      throw new Error(`Env var "${row.key}" cannot be decrypted — transfer aborted`);
    }
    if (next !== row.value) {
      await tx.update(envVars).set({ value: next }).where(eq(envVars.id, row.id));
    }
  }

  const snapshots = await tx.query.deployments.findMany({
    where: inArray(deployments.appId, appIds),
    columns: { id: true, envSnapshot: true },
  });
  for (const row of snapshots) {
    if (!row.envSnapshot) continue;
    let next: string;
    try {
      next = reencryptForOrg(row.envSnapshot, fromOrgId, toOrgId);
    } catch {
      log.warn(`Deployment ${row.id} env snapshot was already unreadable; left as is`);
      continue;
    }
    if (next !== row.envSnapshot) {
      await tx.update(deployments).set({ envSnapshot: next }).where(eq(deployments.id, row.id));
    }
  }
}

/**
 * The id of a deploy key `toOrgId` can use in place of `keyId`: the key itself
 * when the org already owns it, otherwise a copy re-encrypted under the org's key.
 * Null when the key is gone or unreadable.
 */
async function adoptDeployKey(tx: Tx, keyId: string, toOrgId: string): Promise<string | null> {
  const key = await tx.query.deployKeys.findFirst({ where: eq(deployKeys.id, keyId) });
  if (!key) return null;
  if (key.organizationId === toOrgId) return key.id;
  let privateKey: string;
  try {
    privateKey = reencryptForOrg(key.privateKey, key.organizationId, toOrgId);
  } catch {
    log.warn(`Deploy key ${key.id} is unreadable; not carried over`);
    return null;
  }
  if (!isEncrypted(privateKey)) privateKey = encrypt(privateKey, toOrgId);
  const id = nanoid();
  await tx.insert(deployKeys).values({
    id,
    organizationId: toOrgId,
    name: key.name,
    publicKey: key.publicKey,
    privateKey,
  });
  return id;
}

/** Point these apps at deploy keys owned by `toOrgId`, copying keys as needed. */
async function moveAppDeployKeys(tx: Tx, appIds: string[], toOrgId: string): Promise<number> {
  const keyed = await tx.query.apps.findMany({
    where: and(inArray(apps.id, appIds), isNotNull(apps.gitKeyId)),
    columns: { id: true, gitKeyId: true },
  });
  const adopted = new Map<string, string | null>();
  let moved = 0;
  for (const app of keyed) {
    const from = app.gitKeyId!;
    if (!adopted.has(from)) adopted.set(from, await adoptDeployKey(tx, from, toOrgId));
    const to = adopted.get(from)!;
    if (to === from) continue;
    await tx.update(apps).set({ gitKeyId: to }).where(eq(apps.id, app.id));
    moved++;
  }
  return moved;
}

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

  await db.transaction(async (tx) => {
    // Claims the transfer; a second accept racing this one finds nothing pending.
    const claimed = await tx
      .update(appTransfers)
      .set({
        status: "accepted",
        frozenRefs,
        respondedBy,
        respondedAt: new Date(),
      })
      .where(and(eq(appTransfers.id, transferId), eq(appTransfers.status, "pending")))
      .returning({ id: appTransfers.id });
    if (claimed.length === 0) {
      throw new Error("Transfer not found or not pending");
    }

    for (const ref of frozenRefs) {
      const vars = await tx.query.envVars.findMany({
        where: and(
          eq(envVars.appId, transfer.appId),
          eq(envVars.key, ref.key),
          isNull(envVars.environmentId),
        ),
      });
      for (const v of vars) {
        if (v.value.includes(ref.originalRef)) {
          await tx
            .update(envVars)
            .set({
              value: v.value.replace(ref.originalRef, ref.frozenValue),
              updatedAt: new Date(),
            })
            .where(eq(envVars.id, v.id));
        }
      }
    }

    // Compose children move with their parent; their secrets are keyed the same way.
    const children = await tx.query.apps.findMany({
      where: eq(apps.parentAppId, transfer.appId),
      columns: { id: true },
    });
    const appIds = [transfer.appId, ...children.map((c) => c.id)];

    // Secrets are encrypted under a key derived from the org id. Moving the row
    // without rewriting them leaves them unreadable in the destination org.
    await reencryptAppSecrets(tx, appIds, transfer.sourceOrgId, transfer.destinationOrgId);
    // Deploy keys are org-owned; the source org keeps its own copy.
    await moveAppDeployKeys(tx, appIds, transfer.destinationOrgId);

    // Ensure a "Default" project exists in the destination org
    const [destProject] = await tx
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

    await tx
      .update(apps)
      .set({
        organizationId: transfer.destinationOrgId,
        projectId: destProject!.id,
        updatedAt: new Date(),
      })
      .where(inArray(apps.id, appIds));

    await tx
      .update(volumes)
      .set({ organizationId: transfer.destinationOrgId })
      .where(inArray(volumes.appId, appIds));
  });
}

/**
 * Repair apps accepted before transfers re-encrypted secrets: anything still
 * encrypted under the source org's key is rewritten under the app's current org,
 * and a deploy key still owned by another org is copied into the app's org.
 * Only values the source key authenticates are touched, so it is idempotent.
 */
export async function repairTransferredSecrets(): Promise<number> {
  const accepted = await db.query.appTransfers.findMany({
    where: eq(appTransfers.status, "accepted"),
    columns: { appId: true, sourceOrgId: true },
  });
  let repaired = 0;
  for (const t of accepted) {
    const rows = await db.query.apps.findMany({
      where: or(eq(apps.id, t.appId), eq(apps.parentAppId, t.appId)),
      columns: { id: true, organizationId: true },
    });
    for (const row of rows) {
      if (row.organizationId === t.sourceOrgId) continue;
      repaired += await db.transaction(async (tx) =>
        (await repairAppSecrets(tx, row.id, t.sourceOrgId, row.organizationId)) +
        (await moveAppDeployKeys(tx, [row.id], row.organizationId)),
      );
    }
  }
  return repaired;
}

/** Rewrites values the source key opens and the current key does not. */
async function repairAppSecrets(tx: Tx, appId: string, fromOrgId: string, toOrgId: string): Promise<number> {
  const stranded = (value: string | null): value is string => {
    if (!value || !isEncrypted(value)) return false;
    try {
      decrypt(value, toOrgId);
      return false;
    } catch {
      try {
        decrypt(value, fromOrgId);
        return true;
      } catch {
        return false;
      }
    }
  };
  let count = 0;

  const app = await tx.query.apps.findFirst({ where: eq(apps.id, appId), columns: { envContent: true } });
  if (stranded(app?.envContent ?? null)) {
    await tx.update(apps).set({ envContent: reencryptForOrg(app!.envContent!, fromOrgId, toOrgId) }).where(eq(apps.id, appId));
    count++;
  }
  for (const v of await tx.query.envVars.findMany({ where: eq(envVars.appId, appId), columns: { id: true, value: true } })) {
    if (!stranded(v.value)) continue;
    await tx.update(envVars).set({ value: reencryptForOrg(v.value, fromOrgId, toOrgId) }).where(eq(envVars.id, v.id));
    count++;
  }
  for (const d of await tx.query.deployments.findMany({ where: eq(deployments.appId, appId), columns: { id: true, envSnapshot: true } })) {
    if (!stranded(d.envSnapshot)) continue;
    await tx.update(deployments).set({ envSnapshot: reencryptForOrg(d.envSnapshot, fromOrgId, toOrgId) }).where(eq(deployments.id, d.id));
    count++;
  }
  return count;
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
