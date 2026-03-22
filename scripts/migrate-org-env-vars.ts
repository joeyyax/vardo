/**
 * Migration script: encrypt plaintext org env var secret values.
 *
 * Finds all org_env_var rows where is_secret = true and value is not yet
 * encrypted, encrypts them with the org-scoped AES-256-GCM key, and writes
 * them back.
 *
 * Run with: npx tsx scripts/migrate-org-env-vars.ts
 *
 * Requires ENCRYPTION_MASTER_KEY environment variable to be set.
 * Safe to run multiple times — already-encrypted values are skipped.
 */

import { db } from "@/lib/db";
import { orgEnvVars } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { encrypt, isEncrypted } from "@/lib/crypto/encrypt";

async function migrate() {
  if (!process.env.ENCRYPTION_MASTER_KEY) {
    console.error("ENCRYPTION_MASTER_KEY environment variable is required");
    process.exit(1);
  }

  const allVars = await db.query.orgEnvVars.findMany();
  console.log(`Found ${allVars.length} org env var(s)`);

  let migrated = 0;
  let skipped = 0;

  await db.transaction(async (tx) => {
    for (const v of allVars) {
      if (!v.isSecret) {
        skipped++;
        continue;
      }

      if (isEncrypted(v.value)) {
        console.log(`  [skip] ${v.key} (org: ${v.organizationId}) — already encrypted`);
        skipped++;
        continue;
      }

      const encrypted = encrypt(v.value, v.organizationId);
      await tx
        .update(orgEnvVars)
        .set({ value: encrypted, updatedAt: new Date() })
        .where(eq(orgEnvVars.id, v.id));

      console.log(`  [migrated] ${v.key} (org: ${v.organizationId})`);
      migrated++;
    }
  });

  console.log(`\nDone: ${migrated} migrated, ${skipped} skipped`);
}

migrate().catch(console.error);
