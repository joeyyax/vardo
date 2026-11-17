// An org's build secrets: encrypted at rest, write-only through the API and MCP.

import { and, asc, eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import { z } from "zod";
import { db } from "@/lib/db";
import { orgBuildSecrets } from "@/lib/db/schema";
import { decryptOrFallback, encrypt } from "@/lib/crypto/encrypt";
import { recordActivity } from "@/lib/activity";
import { BUILD_SECRET_ID, type BuildSecrets } from "@/lib/docker/build-secrets";

export const buildSecretName = z.string().regex(BUILD_SECRET_ID, "Use lowercase letters, digits and underscores, starting with a letter");
export const buildSecretValue = z.string().min(1).max(64 * 1024);

export type BuildSecretSummary = { name: string; updatedAt: Date };

/** Names and when each was set; never values. */
export async function listBuildSecrets(orgId: string): Promise<BuildSecretSummary[]> {
  const rows = await db.query.orgBuildSecrets.findMany({
    where: eq(orgBuildSecrets.organizationId, orgId),
    columns: { name: true, updatedAt: true },
    orderBy: [asc(orgBuildSecrets.name)],
  });
  return rows.map((r) => ({ name: r.name, updatedAt: r.updatedAt }));
}

export async function setBuildSecret(orgId: string, name: string, value: string, userId: string | undefined, trigger?: string): Promise<BuildSecretSummary> {
  const now = new Date();
  const encrypted = encrypt(value, orgId);
  await db
    .insert(orgBuildSecrets)
    .values({ id: nanoid(), organizationId: orgId, name, value: encrypted, createdAt: now, updatedAt: now })
    .onConflictDoUpdate({
      target: [orgBuildSecrets.organizationId, orgBuildSecrets.name],
      set: { value: encrypted, updatedAt: now },
    });
  recordActivity({ organizationId: orgId, action: "build_secret.set", userId, metadata: { name, ...(trigger ? { trigger } : {}) } }).catch(() => {});
  return { name, updatedAt: now };
}

/** False when the org has no secret of that name. */
export async function deleteBuildSecret(orgId: string, name: string, userId: string | undefined, trigger?: string): Promise<boolean> {
  const deleted = await db
    .delete(orgBuildSecrets)
    .where(and(eq(orgBuildSecrets.organizationId, orgId), eq(orgBuildSecrets.name, name)))
    .returning({ id: orgBuildSecrets.id });
  if (deleted.length === 0) return false;
  recordActivity({ organizationId: orgId, action: "build_secret.deleted", userId, metadata: { name, ...(trigger ? { trigger } : {}) } }).catch(() => {});
  return true;
}

/** Decrypted values for a deploy. A row that won't decrypt is left out and named in `failed`. */
export async function orgBuildSecretValues(orgId: string): Promise<{ secrets: BuildSecrets; failed: string[] }> {
  const rows = await db.query.orgBuildSecrets.findMany({
    where: eq(orgBuildSecrets.organizationId, orgId),
    columns: { name: true, value: true },
  });
  const secrets: BuildSecrets = {};
  const failed: string[] = [];
  for (const row of rows) {
    const { content, decryptFailed, wasEncrypted } = decryptOrFallback(row.value, orgId);
    if (decryptFailed || !wasEncrypted) failed.push(row.name);
    else secrets[row.name] = content;
  }
  return { secrets, failed };
}
