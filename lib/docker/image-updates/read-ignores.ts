import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { imageUpdateIgnores } from "@/lib/db/schema";
import type { IgnoreRule } from "./ignore";

/** Every ignore rule in an org, lapsed ones included — expiry is judged at read. */
export async function readIgnoreRules(orgId: string): Promise<IgnoreRule[]> {
  const rows = await db
    .select({
      id: imageUpdateIgnores.id,
      appId: imageUpdateIgnores.appId,
      composeService: imageUpdateIgnores.composeService,
      scope: imageUpdateIgnores.scope,
      expiresAt: imageUpdateIgnores.expiresAt,
    })
    .from(imageUpdateIgnores)
    .where(eq(imageUpdateIgnores.organizationId, orgId));

  return rows.map((row) => ({
    ...row,
    expiresAt: row.expiresAt?.toISOString() ?? null,
  }));
}
