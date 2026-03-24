/**
 * Migration script: encrypt plaintext system settings that contain secrets.
 *
 * Targets the following keys written by the setup wizard:
 *   - backup_storage  (S3/SSH credentials)
 *   - github_app      (GitHub App private key + webhook secret)
 *   - email_provider  (SMTP password or API key)
 *
 * Finds rows where the value is not yet encrypted and re-encrypts them with
 * AES-256-GCM using the system-level derived key.
 *
 * Run with: npx tsx scripts/migrate-system-settings.ts
 *
 * Requires ENCRYPTION_MASTER_KEY environment variable to be set.
 * Safe to run multiple times — already-encrypted values are skipped.
 */

import { db } from "@/lib/db";
import { systemSettings } from "@/lib/db/schema";
import { eq, inArray } from "drizzle-orm";
import { encryptSystem, isEncrypted } from "@/lib/crypto/encrypt";

const SECRET_KEYS = ["backup_storage", "github_app", "email_provider"];

async function migrate() {
  if (!process.env.ENCRYPTION_MASTER_KEY) {
    console.error("ENCRYPTION_MASTER_KEY environment variable is required");
    process.exit(1);
  }

  const rows = await db.query.systemSettings.findMany({
    where: (t, { inArray: inArr }) => inArr(t.key, SECRET_KEYS),
  });

  console.log(`Found ${rows.length} sensitive system setting(s)`);

  let migrated = 0;
  let skipped = 0;

  await db.transaction(async (tx) => {
    for (const row of rows) {
      if (isEncrypted(row.value)) {
        console.log(`  [skip] ${row.key} — already encrypted`);
        skipped++;
        continue;
      }

      const encrypted = encryptSystem(row.value);
      await tx
        .update(systemSettings)
        .set({ value: encrypted, updatedAt: new Date() })
        .where(eq(systemSettings.key, row.key));

      console.log(`  [migrated] ${row.key}`);
      migrated++;
    }
  });

  console.log(`\nDone: ${migrated} migrated, ${skipped} skipped`);
}

migrate().catch(console.error);
